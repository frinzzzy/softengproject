-- Users & Roles
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'CASHIER', 'KITCHEN', 'WAITER')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Dining Tables
CREATE TABLE tables (
    id SERIAL PRIMARY KEY,
    table_number VARCHAR(10) NOT NULL,
    qr_token VARCHAR(255) UNIQUE NOT NULL,
    status VARCHAR(20) DEFAULT 'AVAILABLE'
);

-- Menu Categories & Items
CREATE TABLE categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL
);

CREATE TABLE menu_items (
    id SERIAL PRIMARY KEY,
    category_id INT REFERENCES categories(id),
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    is_available BOOLEAN DEFAULT TRUE
);

-- Active Table Sessions
CREATE TABLE table_sessions (
    id SERIAL PRIMARY KEY,
    table_id INT REFERENCES tables(id),
    session_token VARCHAR(255) UNIQUE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);