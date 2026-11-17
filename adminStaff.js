const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('./db');

const router = express.Router();
const VALID_ROLES = new Set(['ADMIN', 'CASHIER', 'KITCHEN', 'WAITER']);
const BCRYPT_ROUNDS = 12;

const parseUserId = (value) => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const getPassword = (body) => body?.temp_password ?? body?.password;

const validatePassword = (password) =>
    typeof password === 'string' && password.length >= 8 && password.length <= 128;

const validatePin = (pin) => pin == null || (typeof pin === 'string' && /^\d{4,6}$/.test(pin));

const lockAdminChanges = async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [719304281]);
};

const activeAdminCount = async (client) => {
    const { rows } = await client.query(
        `SELECT COUNT(*)::int AS count
           FROM users
          WHERE role = 'ADMIN' AND is_active = TRUE`
    );
    return rows[0].count;
};

router.get('/', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT u.id, u.full_name, u.username, u.role, u.is_active, u.last_login_at AS last_login,
                    EXISTS (
                        SELECT 1
                          FROM staff_sessions ss
                         WHERE ss.user_id = u.id
                           AND ss.logout_at IS NULL
                           AND ss.last_seen_at >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
                    ) AS is_online
               FROM users u
              ORDER BY u.full_name NULLS LAST, u.username`
        );
        return res.status(200).json({ success: true, data: rows });
    } catch (error) {
        console.error('[Admin Staff] List failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to list staff.' });
    }
});

router.post('/', async (req, res) => {
    const fullName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const role = typeof req.body?.role === 'string' ? req.body.role.trim().toUpperCase() : '';
    const password = getPassword(req.body);
    const pin = req.body?.pin;

    if (!fullName || fullName.length > 100 ||
        !/^[a-z0-9._-]{3,50}$/.test(username) ||
        !VALID_ROLES.has(role) ||
        !validatePassword(password) ||
        !validatePin(pin) ||
        (pin != null && role !== 'CASHIER')) {
        return res.status(400).json({
            success: false,
            message: 'Provide a valid name, username, role, temporary password (8-128 characters), and optional 4-6 digit cashier PIN.'
        });
    }

    try {
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const pinHash = pin == null ? null : await bcrypt.hash(pin, BCRYPT_ROUNDS);
        const { rows } = await pool.query(
            `INSERT INTO users (full_name, username, password_hash, pin_hash, role)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, full_name, username, role, is_active, last_login_at AS last_login`,
            [fullName, username, passwordHash, pinHash, role]
        );
        return res.status(201).json({ success: true, data: rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ success: false, message: 'Username already exists.' });
        }
        console.error('[Admin Staff] Create failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to create staff account.' });
    }
});

router.patch('/:id', async (req, res) => {
    const userId = parseUserId(req.params.id);
    const fullName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const role = typeof req.body?.role === 'string' ? req.body.role.trim().toUpperCase() : '';

    if (!userId || !fullName || fullName.length > 100 || !VALID_ROLES.has(role)) {
        return res.status(400).json({ success: false, message: 'A valid staff id, name, and role are required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await lockAdminChanges(client);

        const current = await client.query(
            'SELECT id, role, is_active FROM users WHERE id = $1::int FOR UPDATE',
            [userId]
        );
        if (current.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Staff account not found.' });
        }

        const staff = current.rows[0];
        if (staff.is_active && staff.role === 'ADMIN' && role !== 'ADMIN' && await activeAdminCount(client) <= 1) {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, message: 'Cannot demote the last active ADMIN.' });
        }

        const { rows } = await client.query(
            `UPDATE users
                SET full_name = $1, role = $2
              WHERE id = $3::int
          RETURNING id, full_name, username, role, is_active, last_login_at AS last_login`,
            [fullName, role, userId]
        );
        await client.query('COMMIT');
        return res.status(200).json({ success: true, data: rows[0] });
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) {
            console.error('[Admin Staff] Edit rollback failed:', rollbackError.message);
        }
        console.error('[Admin Staff] Edit failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to update staff account.' });
    } finally {
        client.release();
    }
});

router.post('/:id/reset-password', async (req, res) => {
    const userId = parseUserId(req.params.id);
    const password = getPassword(req.body);
    const pin = req.body?.pin;

    if (!userId || !validatePassword(password) || !validatePin(pin)) {
        return res.status(400).json({
            success: false,
            message: 'A valid staff id and temporary password (8-128 characters) are required; optional PIN must be 4-6 digits.'
        });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const account = await client.query(
            'SELECT role FROM users WHERE id = $1::int FOR UPDATE',
            [userId]
        );
        if (account.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Staff account not found.' });
        }
        if (pin != null && account.rows[0].role !== 'CASHIER') {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'PIN login is only available for CASHIER accounts.' });
        }

        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const pinHash = pin == null ? null : await bcrypt.hash(pin, BCRYPT_ROUNDS);
        await client.query(
            `UPDATE users
                SET password_hash = $1,
                    pin_hash = COALESCE($2, pin_hash),
                    token_version = token_version + 1
              WHERE id = $3::int`,
            [passwordHash, pinHash, userId]
        );
        await client.query(
            `UPDATE staff_sessions
                SET logout_at = COALESCE(logout_at, CURRENT_TIMESTAMP)
              WHERE user_id = $1::int AND logout_at IS NULL`,
            [userId]
        );
        await client.query('COMMIT');
        return res.status(200).json({ success: true, message: 'Password reset successfully.' });
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) {
            console.error('[Admin Staff] Password reset rollback failed:', rollbackError.message);
        }
        console.error('[Admin Staff] Password reset failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to reset password.' });
    } finally {
        client.release();
    }
});

router.post('/:id/deactivate', async (req, res) => {
    const userId = parseUserId(req.params.id);
    if (!userId) return res.status(400).json({ success: false, message: 'A valid staff id is required.' });
    if (userId === Number(req.user.id)) {
        return res.status(409).json({ success: false, message: 'You cannot deactivate your own account.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await lockAdminChanges(client);
        const current = await client.query(
            'SELECT id, role, is_active FROM users WHERE id = $1::int FOR UPDATE',
            [userId]
        );
        if (current.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Staff account not found.' });
        }

        const staff = current.rows[0];
        if (staff.is_active && staff.role === 'ADMIN' && await activeAdminCount(client) <= 1) {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, message: 'Cannot deactivate the last active ADMIN.' });
        }

        await client.query(
            `UPDATE users SET is_active = FALSE, token_version = token_version + 1
              WHERE id = $1::int`,
            [userId]
        );
        await client.query(
            `UPDATE staff_sessions
                SET logout_at = COALESCE(logout_at, CURRENT_TIMESTAMP)
              WHERE user_id = $1::int AND logout_at IS NULL`,
            [userId]
        );
        await client.query('COMMIT');
        return res.status(200).json({ success: true, message: 'Staff account deactivated.' });
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) {
            console.error('[Admin Staff] Deactivation rollback failed:', rollbackError.message);
        }
        console.error('[Admin Staff] Deactivation failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to deactivate staff account.' });
    } finally {
        client.release();
    }
});

router.post('/:id/activate', async (req, res) => {
    const userId = parseUserId(req.params.id);
    if (!userId) return res.status(400).json({ success: false, message: 'A valid staff id is required.' });
    try {
        const { rows } = await pool.query(
            `UPDATE users SET is_active = TRUE
              WHERE id = $1::int
          RETURNING id, full_name, username, role, is_active, last_login_at AS last_login`,
            [userId]
        );
        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Staff account not found.' });
        }
        return res.status(200).json({ success: true, data: rows[0] });
    } catch (error) {
        console.error('[Admin Staff] Activation failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to activate staff account.' });
    }
});

module.exports = router;
