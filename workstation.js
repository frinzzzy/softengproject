const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db'); // Siguraduhing tama ang path patungo sa database connection mo

// 1. Generate workstation QR token (Admin side)
router.post('/api/v1/workstations/generate', async (req, res) => {
    const { station_type } = req.body; // 'kitchen', 'waiter', 'admin'
    
    if (!['kitchen', 'waiter', 'admin'].includes(station_type)) {
        return res.status(400).json({ error: 'Invalid station type' });
    }

    const qrToken = crypto.randomBytes(32).toString('hex');

    try {
        // Upsert para i-update o i-insert ang token ng workstation
        const query = `
            INSERT INTO workstations (station_type, qr_token) 
            VALUES ($1, $2)
            ON CONFLICT (station_type) 
            DO UPDATE SET qr_token = $2 
            RETURNING *;
        `;
        const result = await db.query(query, [station_type, qrToken]);
        res.json({ success: true, workstation: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Authenticate via workstation QR scan (Staff/App side)
router.post('/api/v1/auth/workstation-scan', async (req, res) => {
    const { qr_token } = req.body;

    try {
        const result = await db.query('SELECT * FROM workstations WHERE qr_token = $1', [qr_token]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid workstation QR code' });
        }

        const station = result.rows[0];

        // Gumawa ng JWT gamit ang secret key mula sa env mo
        const token = jwt.sign(
            { station_type: station.station_type }, 
            process.env.JWT_SECRET, 
            { expiresIn: '12h' }
        );

        res.json({ 
            success: true, 
            message: `Successfully logged into ${station.station_type} station`,
            token,
            station_type: station.station_type
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;