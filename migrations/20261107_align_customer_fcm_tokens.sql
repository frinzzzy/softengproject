-- Align the customer FCM token table with the session-scoped schema used by
-- notificationService.js. The original deployed table used
-- (customer_id, fcm_token) which broke every customer push registration.
--
-- This migration is idempotent and safe to run repeatedly.

CREATE TABLE IF NOT EXISTS customer_fcm_tokens (
    id BIGSERIAL PRIMARY KEY,
    session_id INT,
    token TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
DECLARE
    has_session BOOLEAN;
    has_token BOOLEAN;
    has_legacy_token BOOLEAN;
    has_customer BOOLEAN;
    c RECORD;
BEGIN
    SELECT
        BOOL_OR(column_name = 'session_id'),
        BOOL_OR(column_name = 'token'),
        BOOL_OR(column_name = 'fcm_token'),
        BOOL_OR(column_name = 'customer_id')
      INTO has_session, has_token, has_legacy_token, has_customer
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'customer_fcm_tokens';

    IF has_legacy_token AND NOT has_token THEN
        ALTER TABLE customer_fcm_tokens RENAME COLUMN fcm_token TO token;
    END IF;

    IF NOT has_session THEN
        ALTER TABLE customer_fcm_tokens ADD COLUMN IF NOT EXISTS session_id INT;
    END IF;

    IF NOT has_token THEN
        ALTER TABLE customer_fcm_tokens ADD COLUMN IF NOT EXISTS token TEXT;
    END IF;

    IF has_customer THEN
        ALTER TABLE customer_fcm_tokens ALTER COLUMN customer_id DROP NOT NULL;
        -- Legacy rows have no session and can never match a session-scoped push.
        DELETE FROM customer_fcm_tokens WHERE session_id IS NULL;
    END IF;

    -- Legacy UNIQUE(token) prevents the same device from registering under more
    -- than one session. Replace it with UNIQUE(session_id, token).
    FOR c IN
        SELECT conname, pg_get_constraintdef(oid) AS def
          FROM pg_constraint
         WHERE conrelid = 'customer_fcm_tokens'::regclass
           AND contype = 'u'
    LOOP
        IF c.def NOT LIKE '%session_id%' THEN
            EXECUTE format(
                'ALTER TABLE customer_fcm_tokens DROP CONSTRAINT %I',
                c.conname
            );
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
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
