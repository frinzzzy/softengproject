const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

async function runSchemaAndSeed() {
  try {
    console.log('[LMCO Engine] Running schema setup...');
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schemaSql);
    console.log('✅ [LMCO Engine] Database schema created!');

    console.log('[LMCO Engine] Seeding tables...');
    await pool.query(`
      INSERT INTO tables (id, table_number, qr_token) VALUES 
      (1, 'Table 1', 'qr_tbl_1_sec123'),
      (2, 'Table 2', 'qr_tbl_2_sec456'),
      (8, 'Table 8', 'qr_tbl_8_sec789')
      ON CONFLICT DO NOTHING;
    `);
    await pool.query(`SELECT setval('tables_id_seq', (SELECT MAX(id) FROM tables));`);

    console.log('[LMCO Engine] Seeding categories...');
    await pool.query(`
      INSERT INTO categories (id, name) VALUES 
      (1, 'Mains'), 
      (2, 'Appetizers'), 
      (3, 'Beverages'), 
      (4, 'Desserts')
      ON CONFLICT DO NOTHING;
    `);
    await pool.query(`SELECT setval('categories_id_seq', (SELECT MAX(id) FROM categories));`);

    console.log('[LMCO Engine] Seeding menu items...');
    await pool.query(`
      INSERT INTO menu_items (category_id, name, price, is_available) VALUES 
      (1, 'Beef Pares Special', 150.00, TRUE),
      (1, 'Sizzling Sisig', 180.00, TRUE),
      (2, 'Lumpiang Shanghai', 90.00, TRUE),
      (3, 'Iced Milk Tea', 75.00, TRUE),
      (4, 'Leche Flan', 60.00, TRUE);
    `);

    console.log('✅ [LMCO Engine] Database fully initialized and seeded!');
    process.exit(0);
  } catch (err) {
    console.error('❌ [LMCO Engine] Database setup failed:', err);
    process.exit(1);
  }
}

runSchemaAndSeed();