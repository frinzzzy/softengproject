const pool = require('./db');

const createReservation = async (req, res) => {
    const { customer_name, contact_number, party_size, reservation_time, table_id } = req.body;

    if (!customer_name || !contact_number || !party_size || !reservation_time) {
        return res.status(400).json({ 
            success: false, 
            message: 'Missing required reservation fields (customer_name, contact_number, party_size, reservation_time).' 
        });
    }

    try {
        // If a table_id is provided, validate the table's current status and bookings
        if (table_id) {
            const tableCheck = await pool.query('SELECT * FROM tables WHERE id = $1', [table_id]);
            if (tableCheck.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Selected table not found.' });
            }

            const table = tableCheck.rows[0];

            // 1. Check if the table is OCCUPIED
            if (table.status === 'OCCUPIED') {
                return res.status(400).json({ 
                    success: false, 
                    message: `Table #${table.table_number} is currently occupied and cannot be reserved.` 
                });
            }

            // 2. Check if another customer already booked/reserved this table
            const existingResCheck = await pool.query(
                "SELECT * FROM reservations WHERE table_id = $1 AND status IN ('PENDING', 'CONFIRMED')",
                [table_id]
            );
            if (existingResCheck.rows.length > 0) {
                return res.status(400).json({ 
                    success: false, 
                    message: `Table #${table.table_number} already has a pending or confirmed reservation.` 
                });
            }
        }

        const query = `
            INSERT INTO reservations (customer_name, contact_number, party_size, reservation_time, table_id, status)
            VALUES ($1, $2, $3, $4, $5, 'PENDING')
            RETURNING *;
        `;
        const { rows } = await pool.query(query, [customer_name, contact_number, party_size, reservation_time, table_id || null]);

        return res.status(201).json({
            success: true,
            message: 'Same-day reservation / queue slot created successfully.',
            data: rows[0]
        });
    } catch (error) {
        console.error('Create reservation error:', error.message);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
    }
};

const getReservations = async (req, res) => {
    try {
        const query = `
            SELECT r.*, t.table_number 
            FROM reservations r
            LEFT JOIN tables t ON r.table_id = t.id
            WHERE r.status IN ('PENDING', 'CONFIRMED')
            ORDER BY r.reservation_time ASC;
        `;
        const { rows } = await pool.query(query);

        return res.status(200).json({
            success: true,
            data: rows,
            message: 'Active reservations retrieved successfully.'
        });
    } catch (error) {
        console.error('Get reservations error:', error.message);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
    }
};

const checkInReservation = async (req, res) => {
    const { id } = req.params;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const resCheck = await client.query('SELECT * FROM reservations WHERE id = $1', [id]);
        if (resCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Reservation not found.' });
        }

        const reservation = resCheck.rows[0];

        await client.query(
            "UPDATE reservations SET status = 'CHECKED_IN' WHERE id = $1",
            [id]
        );

        let activeSessionId = null;
        if (reservation.table_id) {
            const sessionRes = await client.query(
                `INSERT INTO table_sessions (table_id, session_status) VALUES ($1, 'ACTIVE') RETURNING id`,
                [reservation.table_id]
            );
            activeSessionId = sessionRes.rows[0].id;
        }

        await client.query('COMMIT');

        return res.status(200).json({
            success: true,
            message: `Reservation #${id} checked in successfully. Table session opened.`,
            data: {
                reservation_id: reservation.id,
                table_id: reservation.table_id,
                session_id: activeSessionId
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Check-in error:', error.message);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
    } finally {
        client.release();
    }
};

module.exports = {
    createReservation,
    getReservations,
    checkInReservation
};