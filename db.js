const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'postgres',
    password: String(process.env.DB_PASSWORD || ''),
    database: process.env.DB_NAME,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
    connectionTimeoutMillis: 3000 // Magpapatalo/Mag-e-error agad pagkalipas ng 3 segundo kung walang koneksyon
});

// Para mahuli kung biglang nawala ang koneksyon sa database
pool.on('error', (err) => {
    console.error('❌ Unexpected database error on idle client:', err.message);
});

// Optional: I-test ang koneksyon habang nagbubukas ang app
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Database Connection Failed! I-check ang `.env` o PostgreSQL service mo:', err.message);
    } else {
        console.log('✅ Connected to PostgreSQL Database successfully!');
    }
});

module.exports = pool;