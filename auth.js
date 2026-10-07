const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'lmco_super_secret_jwt_key_2026';

// Helper: Generate Token (Set to 365 days for smooth development/testing)
const generateAccessToken = (user) => {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role.toUpperCase() },
        JWT_SECRET,
        { expiresIn: '365d' }
    );
};

// ==========================================
// 1. REGISTER USER
// ==========================================
router.post('/register', async (req, res) => {
    const { username, password, role } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            success: false,
            message: 'Username and password are required.'
        });
    }

    try {
        const cleanUsername = username.trim().toLowerCase();

        const userCheck = await pool.query('SELECT id FROM users WHERE LOWER(username) = $1', [cleanUsername]);
        if (userCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Username already taken.' });
        }

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        const userRole = (role || 'ADMIN').toUpperCase();

        const newUser = await pool.query(
            'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role',
            [cleanUsername, password_hash, userRole]
        );

        const createdUser = newUser.rows[0];
        const token = generateAccessToken(createdUser);

        return res.status(201).json({
            success: true,
            token,
            data: {
                token,
                user: createdUser
            },
            message: 'User registered successfully.'
        });
    } catch (err) {
        console.error('❌ [LMCO Register Error]:', err);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// ==========================================
// 2. LOGIN USER
// ==========================================
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            success: false,
            message: 'Username and password are required.'
        });
    }

    try {
        const cleanUsername = username.trim().toLowerCase();

        // Match case-insensitively using LOWER()
        const result = await pool.query('SELECT * FROM users WHERE LOWER(username) = $1', [cleanUsername]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Invalid username or password.'
            });
        }

        const user = result.rows[0];

        // Compare bcrypt hash
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: 'Invalid username or password.'
            });
        }

        const token = generateAccessToken(user);

        return res.status(200).json({
            success: true,
            token,
            data: {
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    role: user.role.toUpperCase()
                }
            },
            message: 'Login successful.'
        });

    } catch (err) {
        console.error('❌ [LMCO Auth Error Details]:', err);
        return res.status(500).json({
            success: false,
            message: 'Internal server error.'
        });
    }
});

// ==========================================
// 3. VERIFY TOKEN HANDSHAKE (/me)
// ==========================================
router.get('/me', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return res.status(200).json({
            success: true,
            data: {
                id: decoded.id,
                username: decoded.username,
                role: decoded.role
            }
        });
    } catch (err) {
        return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    }
});

module.exports = router;