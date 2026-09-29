const pool = require('./db');

/**
 * Background worker para i-auto-close ang mga table session
 * na walang aktibidad (AFK) sa loob ng 5 minuto.
 */
const startAutoCloseMonitor = (io) => {
    // Tatakbo kada 1 minuto (60000 ms) para i-check ang mga inactive sessions
    setInterval(async () => {
        try {
            // Kunin at i-close ang mga sessions na lumampas na sa 5 minuto ang inactivities
            const query = `
                UPDATE table_sessions 
                SET session_status = 'CLOSED', closed_at = CURRENT_TIMESTAMP 
                WHERE session_status = 'ACTIVE' 
                AND last_active_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes'
                RETURNING id, table_id;
            `;

            const { rows } = await pool.query(query);

            if (rows.rows && rows.length > 0) {
                console.log(`🧹 [AutoClose] Na-close ang ${rows.length} na table session dahil sa 5-minutong AFK.`);

                // Opsyonal: Mag-broadcast gamit ang Socket.io kung nais mong ma-update ang UI ng cashier/waiter
                if (io) {
                    rows.forEach(session => {
                        io.emit('table_session_closed', {
                            session_id: session.id,
                            table_id: session.table_id,
                            reason: 'AFK Timeout (5 minutes)'
                        });
                    });
                }
            }
        } catch (err) {
            console.error('❌ [AutoClose Error]:', err.message);
        }
    }, 60000); // 1 minute interval
};

module.exports = { startAutoCloseMonitor };