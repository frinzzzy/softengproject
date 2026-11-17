const pool = require('./db');

let initialization;

const initStaffAuthSchema = () => {
    if (!initialization) {
        initialization = (async () => {
            await pool.query(`
                ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(100);
                ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
                ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
                ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash VARCHAR(255);

                CREATE TABLE IF NOT EXISTS staff_sessions (
                    id BIGSERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    login_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    logout_at TIMESTAMPTZ,
                    device_info TEXT
                );
                ALTER TABLE staff_sessions ADD COLUMN IF NOT EXISTS login_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
                ALTER TABLE staff_sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
                ALTER TABLE staff_sessions ADD COLUMN IF NOT EXISTS logout_at TIMESTAMPTZ;
                CREATE INDEX IF NOT EXISTS idx_staff_sessions_user_open
                    ON staff_sessions(user_id, last_seen_at DESC)
                    WHERE logout_at IS NULL;
            `);
            console.log('[Auth] Staff account and session schema is ready.');
        })().catch((error) => {
            initialization = null;
            throw error;
        });
    }
    return initialization;
};

module.exports = { initStaffAuthSchema };
