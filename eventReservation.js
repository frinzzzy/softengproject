const pool = require('./db');

const createEventReservation = async (req, res) => {
    const { customer_name, contact_number, party_size, event_date, reservation_time, table_id } = req.body;

    if (!customer_name || !contact_number || !party_size || !event_date || !reservation_time || !table_id) {
        return res.status(400).json({ 
            success: false, 
            message: 'Missing required fields (customer_name, contact_number, party_size, event_date, reservation_time, table_id).' 
        });
    }

    try {
        const tableCheck = await pool.query('SELECT * FROM tables WHERE id = $1', [table_id]);
        if (tableCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Selected table not found.' });
        }

        const table = tableCheck.rows[0];

        const conflictCheck = await pool.query(
            `SELECT * FROM event_reservations 
             WHERE table_id = $1 
             AND event_date = $2 
             AND status IN ('PENDING', 'CONFIRMED')`,
            [table_id, event_date]
        );

        if (conflictCheck.rows.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: `Table #${table.table_number} is already reserved for this date (${event_date}).` 
            });
        }

        const query = `
            INSERT INTO event_reservations (customer_name, contact_number, party_size, event_date, reservation_time, table_id, status)
            VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
            RETURNING *;
        `;
        const { rows } = await pool.query(query, [
            customer_name, 
            contact_number, 
            party_size, 
            event_date, 
            reservation_time, 
            table_id
        ]);

        return res.status(201).json({
            success: true,
            message: 'Event reservation created successfully for future date.',
            data: rows[0]
        });

    } catch (error) {
        console.error('Create event reservation error:', error.message);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
    }
};

const getEventReservations = async (req, res) => {
    try {
        const query = `
            SELECT er.*, t.table_number 
            FROM event_reservations er
            LEFT JOIN tables t ON er.table_id = t.id
            ORDER BY er.event_date ASC, er.reservation_time ASC;
        `;
        const { rows } = await pool.query(query);

        return res.status(200).json({
            success: true,
            data: rows,
            message: 'Event reservations retrieved successfully.'
        });
    } catch (error) {
        console.error('Get event reservations error:', error.message);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
    }
};

const updateEventReservation = async (req, res) => {
    const { id } = req.params;
    const { customer_name, contact_number, party_size, event_date, reservation_time, table_id, status } = req.body;

    try {
        // 1. Check kung existing yung reservation
        const existingRes = await pool.query('SELECT * FROM event_reservations WHERE id = $1', [id]);
        if (existingRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Event reservation not found.' });
        }

        const currentReservation = existingRes.rows[0];

        // 2. Kunin ang current date (YYYY-MM-DD) batay sa local time ng server
        const d = new Date();
        const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        
        // 3. Kunin ang event date gamit ang local date methods para walang UTC offset issue
        const eventDateObj = new Date(currentReservation.event_date);
        const dbEventDateStr = `${eventDateObj.getFullYear()}-${String(eventDateObj.getMonth() + 1).padStart(2, '0')}-${String(eventDateObj.getDate()).padStart(2, '0')}`;

        // 4. I-block ang pag-update kung ang event date ay ngayon na (current day)
        if (dbEventDateStr === todayStr) {
            return res.status(400).json({
                success: false,
                message: 'Cannot update event reservation scheduled for today. Please manage it via same-day queue/check-in.'
            });
        }

        // 5. Kung future date naman, ituloy ang update
        const query = `
            UPDATE event_reservations 
            SET customer_name = COALESCE($1, customer_name),
                contact_number = COALESCE($2, contact_number),
                party_size = COALESCE($3, party_size),
                event_date = COALESCE($4, event_date),
                reservation_time = COALESCE($5, reservation_time),
                table_id = COALESCE($6, table_id),
                status = COALESCE($7, status)
            WHERE id = $8
            RETURNING *;
        `;

        const { rows } = await pool.query(query, [
            customer_name || null,
            contact_number || null,
            party_size || null,
            event_date || null,
            reservation_time || null,
            table_id || null,
            status || null,
            id
        ]);

        return res.status(200).json({
            success: true,
            message: `Event reservation #${id} updated successfully.`,
            data: rows[0]
        });

    } catch (error) {
        console.error('Update event reservation error:', error.message);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
    }
};

const cancelEventReservation = async (req, res) => {
    const { id } = req.params;

    try {
        const query = `
            UPDATE event_reservations 
            SET status = 'CANCELLED' 
            WHERE id = $1 
            RETURNING *;
        `;
        const { rows } = await pool.query(query, [id]);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Event reservation not found.' });
        }

        return res.status(200).json({
            success: true,
            message: `Event reservation #${id} has been cancelled successfully.`,
            data: rows[0]
        });
    } catch (error) {
        console.error('Cancel event reservation error:', error.message);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
    }
};

module.exports = {
    createEventReservation,
    getEventReservations,
    updateEventReservation,
    cancelEventReservation
};