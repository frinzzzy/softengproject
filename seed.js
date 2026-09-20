import client from "./db.js";

async function seedDatabase() {
  try {
    console.log("Connecting to database...");

    // 1. Create Tables
    console.log("Creating tables...");
    
    // USERS TABLE
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'staff'
      );
    `);

    // CATEGORIES TABLE
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE
      );
    `);

    // MENU ITEMS TABLE
    await client.query(`
      CREATE TABLE IF NOT EXISTS menu_items (
        id SERIAL PRIMARY KEY,
        category_id INT REFERENCES categories(id) ON DELETE CASCADE,
        name VARCHAR(150) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) NOT NULL,
        is_available BOOLEAN DEFAULT TRUE,
        image_url TEXT
      );
    `);

    // ADDONS TABLE
    await client.query(`
      CREATE TABLE IF NOT EXISTS addons (
        id SERIAL PRIMARY KEY,
        menu_item_id INT REFERENCES menu_items(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        price DECIMAL(10, 2) NOT NULL DEFAULT 0.00
      );
    `);

    // ORDERS TABLE
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        table_id INT NOT NULL,
        total_amount DECIMAL(10, 2) NOT NULL,
        status VARCHAR(50) DEFAULT 'Pending',
        idempotency_key VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ORDER ITEMS TABLE
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INT REFERENCES orders(id) ON DELETE CASCADE,
        menu_item_id INT REFERENCES menu_items(id),
        quantity INT NOT NULL,
        unit_price DECIMAL(10, 2) NOT NULL,
        subtotal DECIMAL(10, 2) NOT NULL
      );
    `);

    // ORDER ITEM ADDONS TABLE
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_item_addons (
        id SERIAL PRIMARY KEY,
        order_item_id INT REFERENCES order_items(id) ON DELETE CASCADE,
        addon_id INT REFERENCES addons(id),
        unit_price DECIMAL(10, 2) NOT NULL
      );
    `);

    console.log("Tables created successfully.");

    // 2. Insert Default Admin User
    console.log("Inserting default admin user...");
    await client.query(`
      INSERT INTO users (username, password, role) 
      VALUES ('admin', 'password123', 'admin')
      ON CONFLICT (username) DO NOTHING;
    `);

    // 3. Seed Categories
    console.log("Seeding categories...");
    const categoryQuery = `
      INSERT INTO categories (name) VALUES 
      ('Main Course'),
      ('Appetizers'),
      ('Desserts'),
      ('Beverages')
      ON CONFLICT (name) DO NOTHING;
    `;
    await client.query(categoryQuery);

    // Get Category IDs
    const categoriesRes = await client.query(`SELECT id, name FROM categories;`);
    const categoryMap = {};
    categoriesRes.rows.forEach(cat => {
      categoryMap[cat.name] = cat.id;
    });

    // 4. Seed Menu Items
    console.log("Seeding menu items...");
    
    // Check if menu items already exist to avoid duplicate insertions on multiple runs
    const existingMenu = await client.query(`SELECT COUNT(*) FROM menu_items;`);
    
    if (parseInt(existingMenu.rows[0].count) === 0) {
      // Main Course Items
      const kareKare = await client.query(`
        INSERT INTO menu_items (category_id, name, description, price, is_available)
        VALUES ($1, 'Kare-Kare', 'Traditional Filipino stew made with peanut sauce, beef tripe, and vegetables.', 220.00, true)
        RETURNING id;
      `, [categoryMap['Main Course']]);

      const adobo = await client.query(`
        INSERT INTO menu_items (category_id, name, description, price, is_available)
        VALUES ($1, 'Pork Adobo', 'Classic pork stewed in soy sauce, vinegar, garlic, and bay leaves.', 180.00, true)
        RETURNING id;
      `, [categoryMap['Main Course']]);

      const sinigang = await client.query(`
        INSERT INTO menu_items (category_id, name, description, price, is_available)
        VALUES ($1, 'Sinigang na Baboy', 'Soured pork soup with tamarind and assorted vegetables.', 200.00, true)
        RETURNING id;
      `, [categoryMap['Main Course']]);

      // Appetizer Items
      const lumpia = await client.query(`
        INSERT INTO menu_items (category_id, name, description, price, is_available)
        VALUES ($1, 'Lumpia Shanghai', 'Deep-fried pork spring rolls served with sweet and sour sauce.', 120.00, true)
        RETURNING id;
      `, [categoryMap['Appetizers']]);

      // Dessert Items
      const haloHalo = await client.query(`
        INSERT INTO menu_items (category_id, name, description, price, is_available)
        VALUES ($1, 'Halo-Halo', 'Shaved ice dessert with sweet beans, jelly, leche flan, and ube ice cream.', 95.00, true)
        RETURNING id;
      `, [categoryMap['Desserts']]);

      // Beverage Items
      const icedTea = await client.query(`
        INSERT INTO menu_items (category_id, name, description, price, is_available)
        VALUES ($1, 'House Iced Tea', 'Refreshing bottomless house-brewed iced tea.', 45.00, true)
        RETURNING id;
      `, [categoryMap['Beverages']]);

      // 5. Seed Addons
      console.log("Seeding addons...");
      
      const kareKareId = kareKare.rows[0].id;
      const haloHaloId = haloHalo.rows[0].id;
      const icedTeaId = icedTea.rows[0].id;

      await client.query(`
        INSERT INTO addons (menu_item_id, name, price) VALUES
        ($1, 'Extra Bagoong Alamang', 20.00),
        ($1, 'Extra Peanut Sauce', 30.00),
        ($2, 'Extra Scoop Ube Ice Cream', 25.00),
        ($2, 'Extra Leche Flan Slice', 20.00),
        ($3, 'Up-size to Large Glass', 15.00);
      `, [kareKareId, haloHaloId, icedTeaId]);

      console.log("Menu items and addons seeded successfully.");
    } else {
      console.log("Menu items already exist. Skipping menu item seeding.");
    }

    console.log("Database seeding completed successfully!");
  } catch (error) {
    console.error("Error seeding database:", error);
  } finally {
    await client.end();
    console.log("Database connection closed.");
  }
}

seedDatabase();