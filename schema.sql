CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. USERS & AUTHENTICATION (RBAC)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'CASHIER', 'KITCHEN', 'WAITER')),
    full_name VARCHAR(100),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    token_version INTEGER NOT NULL DEFAULT 0,
    last_login_at TIMESTAMPTZ,
    pin_hash VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS staff_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    login_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    logout_at TIMESTAMPTZ,
    device_info TEXT
);

CREATE INDEX IF NOT EXISTS idx_staff_sessions_user_open
    ON staff_sessions(user_id, last_seen_at DESC)
    WHERE logout_at IS NULL;

CREATE TABLE  workstations (
    id SERIAL PRIMARY KEY,
    station_type VARCHAR(50) UNIQUE NOT NULL, -- admin, kitchen, waiter
    qr_token TEXT NOT NULL
);

-- 3. TABLES & VENUE
CREATE TABLE tables (
    id SERIAL PRIMARY KEY,
    table_number INT UNIQUE NOT NULL,
    qr_token TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'OCCUPIED', 'RESERVED'))
);

-- 4. MENU & CATEGORIES
CREATE TABLE menu_categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL
);

CREATE TABLE menu_items (
    id SERIAL PRIMARY KEY,
    category_id INT REFERENCES menu_categories(id) ON DELETE SET NULL,
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    is_available BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE menu_addons (
    id SERIAL PRIMARY KEY,
    menu_item_id INT REFERENCES menu_items(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    price DECIMAL(10, 2) NOT NULL DEFAULT 0.00
);

-- 5. TABLE SESSIONS & ASSISTANCE
CREATE TABLE table_sessions (
    id SERIAL PRIMARY KEY,
    table_id INT REFERENCES tables(id),
    session_status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (session_status IN ('ACTIVE', 'CLOSED')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP,
    last_active_at TIMESTAMP,
    bill_requested_at TIMESTAMP,
    customer_id INT
);

-- Backwards-compatible migrations for existing deployments
ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;
ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS bill_requested_at TIMESTAMP;
ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS customer_id INT;
CREATE INDEX IF NOT EXISTS idx_table_sessions_customer_id ON table_sessions(customer_id);

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

CREATE TABLE IF NOT EXISTS staff_fcm_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    role VARCHAR(20),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_staff_fcm_tokens_user_id
    ON staff_fcm_tokens(user_id);

CREATE TABLE table_assistance_requests (
    id SERIAL PRIMARY KEY,
    table_id INT REFERENCES tables(id) ON DELETE CASCADE,
    session_id INT REFERENCES table_sessions(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACKNOWLEDGED', 'RESOLVED')),
    waiter_id INT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP
);

-- 6. ORDERS
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    session_id INT REFERENCES table_sessions(id) ON DELETE CASCADE,
    table_id INT REFERENCES tables(id),
    client_order_id UUID UNIQUE NOT NULL,
    total_amount DECIMAL(10, 2) NOT NULL,
    order_type VARCHAR(20) NOT NULL DEFAULT 'NEW' CHECK (order_type IN ('NEW', 'ADDITIONAL')),
    order_status VARCHAR(30) DEFAULT 'PENDING' CHECK (order_status IN ('PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED', 'DECLINED')),
    decline_reason VARCHAR(255),
    notes TEXT,
    bill_requested_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Backwards-compatible migration for existing deployments.
-- Per-ticket bill state (single source of truth). Ang table_sessions.bill_requested_at
-- ay legacy/session-level aggregate lang at hindi na binabasa para sa per-ticket UI.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_requested_at TIMESTAMP;

CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INT REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INT REFERENCES menu_items(id),
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(10, 2) NOT NULL,
    is_checked BOOLEAN NOT NULL DEFAULT FALSE,
    checked_at TIMESTAMP,
    checked_by VARCHAR(120)
);

-- Per-item checklist (kitchen marks each item done; kitchen/waiter/admin can check).
-- Backwards-compatible migration for existing deployments.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_checked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS checked_at TIMESTAMP;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS checked_by VARCHAR(120);

CREATE TABLE order_item_addons (
    id SERIAL PRIMARY KEY,
    order_item_id INT REFERENCES order_items(id) ON DELETE CASCADE,
    addon_id INT REFERENCES menu_addons(id),
    price DECIMAL(10, 2) NOT NULL
);

-- 7. RESERVATIONS
CREATE TABLE reservations (
    id SERIAL PRIMARY KEY,
    table_id INT REFERENCES tables(id) ON DELETE SET NULL,
    customer_name VARCHAR(100) NOT NULL,
    contact_info VARCHAR(100) NOT NULL,
    party_size INT NOT NULL,
    reservation_time TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'CANCELLED')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. PAYMENTS & FINANCIAL LEDGER
CREATE TABLE payments (
    id SERIAL PRIMARY KEY,
    order_id INT REFERENCES orders(id),
    table_id INT REFERENCES tables(id),
    cashier_id INT REFERENCES users(id),
    payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('CASH', 'GCASH')),
    amount_due DECIMAL(10, 2) NOT NULL,
    amount_paid DECIMAL(10, 2) NOT NULL,
    change_given DECIMAL(10, 2) DEFAULT 0.00,
    gcash_reference_no VARCHAR(100) NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PENDING_VERIFICATION', 'COMPLETED', 'VOIDED')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 9. INDEXES FOR PERFORMANCE
CREATE INDEX idx_payments_created_at ON payments(created_at);
CREATE INDEX idx_orders_client_order_id ON orders(client_order_id);
CREATE INDEX idx_orders_session_id ON orders(session_id);
CREATE INDEX idx_reservations_time ON reservations(reservation_time);
CREATE INDEX idx_assistance_status ON table_assistance_requests(status);

-- 10. ONLINE (GOOGLE SIGN-IN) SUPPORT — additive at backward-compatible.
-- Dine-in orders remain DINE_IN by default; online orders use a virtual table.
CREATE TABLE IF NOT EXISTS customer_accounts (
    id SERIAL PRIMARY KEY,
    google_sub TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS customer_profiles (
    customer_id INT PRIMARY KEY
        REFERENCES customer_accounts(id) ON DELETE CASCADE,
    given_name TEXT,
    family_name TEXT,
    avatar_url TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE tables
    ADD COLUMN IF NOT EXISTS is_virtual BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS virtual_table_owners (
    customer_id INT PRIMARY KEY
        REFERENCES customer_accounts(id) ON DELETE CASCADE,
    table_id INT UNIQUE NOT NULL
        REFERENCES tables(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS customer_id INT
        REFERENCES customer_accounts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS fulfillment_type VARCHAR(20)
        NOT NULL DEFAULT 'DINE_IN';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'orders_fulfillment_type_check'
    ) THEN
        ALTER TABLE orders
            ADD CONSTRAINT orders_fulfillment_type_check
            CHECK (fulfillment_type IN ('DINE_IN', 'TAKEOUT'));
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_type
    ON orders(fulfillment_type);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id
    ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_tables_is_virtual
    ON tables(is_virtual);