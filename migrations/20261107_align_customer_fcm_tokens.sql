CREATE TABLE IF NOT EXISTS customer_fcm_tokens (
    id BIGSERIAL PRIMARY KEY,
    session_id INT NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'customer_fcm_tokens'
          AND column_name = 'fcm_token'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'customer_fcm_tokens'
          AND column_name = 'token'
    ) THEN
        ALTER TABLE customer_fcm_tokens RENAME COLUMN fcm_token TO token;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'customer_fcm_tokens'::regclass
          AND conname IN ('customer_fcm_tokens_token_key', 'customer_fcm_tokens_fcm_token_key')
    ) THEN
        ALTER TABLE customer_fcm_tokens
            DROP CONSTRAINT IF EXISTS customer_fcm_tokens_token_key;
        ALTER TABLE customer_fcm_tokens
            DROP CONSTRAINT IF EXISTS customer_fcm_tokens_fcm_token_key;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'customer_fcm_tokens'::regclass
          AND conname = 'uq_customer_fcm_tokens_session_token'
    ) THEN
        ALTER TABLE customer_fcm_tokens
            ADD CONSTRAINT uq_customer_fcm_tokens_session_token
            UNIQUE (session_id, token);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_customer_fcm_tokens_session_id
    ON customer_fcm_tokens(session_id);
CREATE INDEX IF NOT EXISTS idx_customer_fcm_tokens_token
    ON customer_fcm_tokens(token);
