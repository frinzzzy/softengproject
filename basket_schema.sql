CREATE TABLE IF NOT EXISTS basket_items (
    id SERIAL PRIMARY KEY,
    session_id INT NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
    menu_item_id INT NOT NULL REFERENCES menu_items(id),
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS basket_item_addons (
    id SERIAL PRIMARY KEY,
    basket_item_id INT NOT NULL REFERENCES basket_items(id) ON DELETE CASCADE,
    addon_id INT NOT NULL REFERENCES menu_addons(id),
    price DECIMAL(10, 2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_basket_items_session_id
    ON basket_items(session_id);
