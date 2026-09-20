-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. USERS & AUTHENTICATION (RBAC)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'CASHIER', 'KITCHEN', 'WAITER')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    closed_at TIMESTAMP
);

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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INT REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INT REFERENCES menu_items(id),
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(10, 2) NOT NULL
);

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