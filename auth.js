const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { authenticateToken } = require('./authMiddleware');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const BCRYPT_ROUNDS = 12;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 10;
const failedLogins = new Map();
const VALID_ROLES = new Set(['ADMIN', 'CASHIER', 'KITCHEN', 'WAITER']);

const getLoginAddress = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

const loginRetryAfter = (key, now = Date.now()) => {
    const entry = failedLogins.get(key);
    if (!entry || entry.resetAt <= now) {
        failedLogins.delete(key);
        return 0;
    }
    return entry.count >= LOGIN_FAILURE_LIMIT
        ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
        : 0;
};

const recordFailedLogin = (key, now = Date.now()) => {
    const entry = failedLogins.get(key);
    if (!entry || entry.resetAt <= now) {
        failedLogins.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    } else {
        entry.count += 1;
    }

    if (failedLogins.size > 10000) {
        for (const [address, value] of failedLogins) {
            if (value.resetAt <= now) failedLogins.delete(address);
        }
    }
};

const signStaffToken = (user, sessionId) => jwt.sign(
    {
        id: user.id,
        username: user.username,
        role: String(user.role).toUpperCase(),
        token_version: user.token_version,
        sid: sessionId
    },
    JWT_SECRET,
    { expiresIn: '365d' }
);

const openStaffSession = async (client, user) => {
    const { rows } = await client.query(
        `INSERT INTO staff_sessions (user_id)
         VALUES ($1::int)
         RETURNING id`,
        [user.id]
    );
    const sessionId = rows[0].id;
    await client.query(
        'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1::int',
        [user.id]
    );
    return { sessionId, token: signStaffToken(user, sessionId) };
};

const invalidCredentials = (res) => res.status(401).json({
    success: false,
    message: 'Invalid username or password.'
});

router.post('/register', async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const password = req.body?.password;
    const fullName = typeof req.body?.full_name === 'string' ? req.body.full_name.trim() : null;

    if (!/^[a-z0-9._-]{3,50}$/.test(username) ||
        typeof password !== 'string' || password.length < 8 || password.length > 128 ||
        (fullName != null && (!fullName || fullName.length > 100))) {
        return res.status(400).json({
            success: false,
            message: 'A valid username, password (8-128 characters), and optional full_name are required.'
        });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [719304282]);
        const existingUsers = await client.query('SELECT COUNT(*)::int AS count FROM users');
        if (existingUsers.rows[0].count > 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({
                success: false,
                message: 'Public registration is disabled. Ask an ADMIN to create your staff account.'
            });
        }

        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const { rows } = await client.query(
            `INSERT INTO users (username, password_hash, role, full_name)
             VALUES ($1, $2, 'ADMIN', $3)
             RETURNING id, username, role, full_name, is_active, token_version`,
            [username, passwordHash, fullName]
        );
        const auth = await openStaffSession(client, rows[0]);
        await client.query('COMMIT');

        return res.status(201).json({
            success: true,
            token: auth.token,
            data: {
                token: auth.token,
                user: {
                    id: rows[0].id,
                    username: rows[0].username,
                    role: rows[0].role,
                    full_name: rows[0].full_name,
                    is_active: rows[0].is_active
                }
            },
            message: 'Initial ADMIN account created successfully.'
        });
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) {
            console.error('[Auth] Registration rollback failed:', rollbackError.message);
        }
        if (error.code === '23505') {
            return res.status(409).json({ success: false, message: 'Username already taken.' });
        }
        console.error('[Auth] Initial registration failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to create initial ADMIN account.' });
    } finally {
        client.release();
    }
});

router.post('/login', async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const password = req.body?.password;
    const pin = req.body?.pin;
    const address = getLoginAddress(req);

    const retryAfter = loginRetryAfter(address);
    if (retryAfter > 0) {
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ success: false, message: 'Too many login attempts. Try again later.' });
    }
    if (!username || (typeof password !== 'string' && typeof pin !== 'string')) {
        return res.status(400).json({ success: false, message: 'Username and password or PIN are required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userResult = await client.query(
            `SELECT id, username, password_hash, pin_hash, role, full_name, is_active, token_version
               FROM users
              WHERE LOWER(username) = $1
              FOR UPDATE`,
            [username]
        );
        const user = userResult.rows[0];
        let matches = false;
        if (user && user.is_active) {
            if (typeof password === 'string') {
                matches = await bcrypt.compare(password, user.password_hash);
            } else if (typeof pin === 'string' && user.role === 'CASHIER' && user.pin_hash) {
                matches = await bcrypt.compare(pin, user.pin_hash);
            }
        }

        if (!user || !user.is_active || !matches) {
            await client.query('ROLLBACK');
            recordFailedLogin(address);
            return invalidCredentials(res);
        }

        const auth = await openStaffSession(client, user);
        await client.query('COMMIT');

        return res.status(200).json({
            success: true,
            token: auth.token,
            data: {
                token: auth.token,
                user: {
                    id: user.id,
                    username: user.username,
                    role: user.role,
                    full_name: user.full_name,
                    is_active: user.is_active
                }
            },
            message: 'Login successful.'
        });
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) {
            console.error('[Auth] Login rollback failed:', rollbackError.message);
        }
        console.error('[Auth] Login failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to log in.' });
    } finally {
        client.release();
    }
});

router.get('/me', authenticateToken, (req, res) => {
    const { id, username, role, full_name, is_active } = req.user;
    return res.status(200).json({
        success: true,
        data: { id, username, role, full_name, is_active }
    });
});

router.post('/logout', authenticateToken, async (req, res) => {
    try {
        await pool.query(
            `UPDATE staff_sessions
                SET logout_at = COALESCE(logout_at, CURRENT_TIMESTAMP)
              WHERE id = $1::bigint AND user_id = $2::int`,
            [req.user.session_id, req.user.id]
        );
        return res.status(200).json({ success: true, message: 'Logout successful.' });
    } catch (error) {
        console.error('[Auth] Logout failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to log out.' });
    }
});

module.exports = router;
