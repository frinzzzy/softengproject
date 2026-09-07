const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./db');

// POST /api/v1/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: 'Username and password are required.'
    });
  }

  try {
    // 1. Fetch user from database
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password.'
      });
    }

    const user = result.rows[0];

    // 2. Verify password hash against password_hash column
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password.'
      });
    }

    // 3. Generate JWT Signed Token
    const jwtSecret = process.env.JWT_SECRET || 'lmco_super_secret_jwt_key_2026';
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role.toUpperCase() },
      jwtSecret,
      { expiresIn: '8h' }
    );

    // 4. Return standard handshake response
    return res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role.toUpperCase()
        }
      },
      message: 'Login successful'
    });

  } catch (err) {
    console.error('❌ [LMCO Auth Error Details]:', err);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

module.exports = router;