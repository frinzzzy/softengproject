const express = require('express');
const router = express.Router();
const pool = require('./db');

// 1. CALL WAITER (Customer Trigger - Just table_id required)
// 1. CALL WAITER (Customer Trigger)
router.post('/', async (req, res) => {
    const { table_id, session_id } = req.body;

    if (!table_id) {
        return res.status(400).json({ success: false, message: 'table_id is required.' });
    }

    try {
        let targetSessionId = session_id || null;

        // Try to find an active session if not provided, but don't crash if none exists
        if (!targetSessionId) {
            try {
                const activeSessionRes = await pool.query(
                    `SELECT id FROM table_sessions WHERE table_id = $1 LIMIT 1`,
                    [table_id]
                );
                if (activeSessionRes.rows.length > 0) {
                    targetSessionId = activeSessionRes.rows[0].id;
                }
            } catch (err) {
                // Ignore session lookup errors if table_sessions doesn't have data yet
                targetSessionId = null;
            }
        }

        const query = `
            INSERT INTO table_assistance_requests (table_id, session_id, status)
            VALUES ($1, $2, 'PENDING')
            RETURNING *;
        `;
        const { rows } = await pool.query(query, [table_id, targetSessionId]);

        return res.status(201).json({
            success: true,
            message: `Assistance alert sent for Table #${table_id}. A waiter is on the way!`,
            data: rows[0]
        });
    } catch (error) {
        console.error('Create assistance error:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// 2. GET PENDING/ACTIVE ASSISTANCE REQUESTS (For Waiter Dashboard)
router.get('/', async (req, res) => {
    try {
        const query = `
            SELECT 
                ar.id AS request_id,
                ar.table_id,
                t.table_number,
                ar.status,
                ar.created_at
            FROM table_assistance_requests ar
            JOIN tables t ON ar.table_id = t.id
            WHERE ar.status IN ('PENDING', 'ACKNOWLEDGED')
            ORDER BY ar.created_at ASC;
        `;

        const { rows } = await pool.query(query);

        return res.status(200).json({
            success: true,
            data: rows,
            message: 'Active assistance requests retrieved successfully.'
        });
    } catch (error) {
        console.error('Fetch assistance error:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// 3. ACKNOWLEDGE OR RESOLVE ASSISTANCE REQUEST (For Waiters)
router.patch('/:id/acknowledge', async (req, res) => {
    const { id } = req.params;
    const { status, waiter_id } = req.body; 

    const validStatuses = ['ACKNOWLEDGED', 'RESOLVED'];
    const targetStatus = (status || 'ACKNOWLEDGED').toUpperCase();

    if (!validStatuses.includes(targetStatus)) {
        return res.status(400).json({ 
            success: false, 
            message: `Invalid status. Allowed values: ${validStatuses.join(', ')}` 
        });
    }

    try {
        const resolvedClause = targetStatus === 'RESOLVED' ? ", resolved_at = CURRENT_TIMESTAMP" : "";
        const query = `
            UPDATE table_assistance_requests
            SET status = $1, waiter_id = $2 ${resolvedClause}
            WHERE id = $3
            RETURNING *;
        `;

        const { rows } = await pool.query(query, [targetStatus, waiter_id || null, id]);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Assistance request not found.' });
        }

        return res.status(200).json({
            success: true,
            message: `Assistance request #${id} marked as ${targetStatus}.`,
            data: rows[0]
        });
    } catch (error) {
        console.error('Update assistance error:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

module.exports = router;