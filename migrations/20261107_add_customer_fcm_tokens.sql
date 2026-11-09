CREATE TABLE IF NOT EXISTS customer_fcm_tokens (
    id BIGSERIAL PRIMARY KEY,
    session_id INT NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_customer_fcm_tokens_session_token UNIQUE (session_id, token)
);

CREATE INDEX IF NOT EXISTS idx_customer_fcm_tokens_session_id
    ON customer_fcm_tokens(session_id);
CREATE INDEX IF NOT EXISTS idx_customer_fcm_tokens_token
    ON customer_fcm_tokens(token);
