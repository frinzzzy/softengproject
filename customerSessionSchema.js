const pool = require('./db');

/// Self-migration para sa Google-linked table sessions.
/// Idinadagdag ang customer_id nang walang FK constraint para ligtas kahit
/// lumang database ang gagamitin (customer_accounts ay mas hulí nilikha sa
/// schema.sql). Ang order rows ang mananatiling source of truth ng identity.
const initCustomerSessionSchema = async () => {
    await pool.query(
        'ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS customer_id INT'
    );
    await pool.query(
        'CREATE INDEX IF NOT EXISTS idx_table_sessions_customer_id ON table_sessions(customer_id)'
    );
};

module.exports = { initCustomerSessionSchema };
