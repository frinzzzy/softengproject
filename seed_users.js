const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

async function seedUsers() {
  try {
    console.log('[LMCO Engine] Seeding default staff accounts...');
    
    // Default password for testing: "password123"
    const hashedPassword = await bcrypt.hash('password123', 10);

    await pool.query(`
      INSERT INTO users (username, password_hash, role) VALUES 
      ('admin', $1, 'ADMIN'),
      ('cashier1', $1, 'CASHIER'),
      ('chef1', $1, 'KITCHEN'),
      ('waiter1', $1, 'WAITER')
      ON CONFLICT (username) DO NOTHING;
    `, [hashedPassword]);

    console.log('✅ [LMCO Engine] Users table seeded successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ [LMCO Engine] User migration failed:', err);
    process.exit(1);
  }
}

seedUsers();