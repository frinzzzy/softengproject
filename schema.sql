-- ==========================================
-- LMCO BACKEND: FULL DATABASE SCHEMA
-- ==========================================

-- Reset database structure
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS table_sessions CASCADE;
DROP TABLE IF EXISTS menu_items CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS tables CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- 1. Users & RBAC Roles
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'CASHIER', 'KITCHEN', 'WAITER')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Dining Tables
CREATE TABLE tables (
    id SERIAL PRIMARY KEY,
    table_number VARCHAR(10) NOT NULL,
    qr_token VARCHAR(255) UNIQUE NOT NULL,
    status VARCHAR(20) DEFAULT 'AVAILABLE'
);

-- 3. Menu Categories
CREATE TABLE categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL
);

-- 4. Menu Items
CREATE TABLE menu_items (
    id SERIAL PRIMARY KEY,
    category_id INT REFERENCES categories(id) ON DELETE SET NULL,
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    is_available BOOLEAN DEFAULT TRUE
);

-- 5. Active Table Sessions (QR Code Scanning)
CREATE TABLE table_sessions (
    id SERIAL PRIMARY KEY,
    table_id INT REFERENCES tables(id) ON DELETE CASCADE,
    session_token VARCHAR(255) UNIQUE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Orders Master Table (With Idempotency Key)
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    table_id INT REFERENCES tables(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(255) UNIQUE NOT NULL,
    total_amount DECIMAL(10, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PREPARING', 'SERVED', 'CANCELLED')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Order Items Detail Table
-- 7. Order Items Detail Table
CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INT REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INT REFERENCES menu_items(id) ON DELETE RESTRICT,
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(10, 2) NOT NULL
);

-- ==========================================
-- SEED DATA
-- ==========================================

-- Default Sample Tables for QR Scanning
INSERT INTO tables (table_number, qr_token) VALUES 
('Table 1', 'qr_tbl_1_sec123'),
('Table 2', 'qr_tbl_2_sec456'),
('Table 8', 'qr_tbl_8_sec789')
ON CONFLICT (qr_token) DO NOTHING;