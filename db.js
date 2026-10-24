const { Pool } = require('pg');

// Gamitin ang process.env.DATABASE_URL nang direkta mula sa Render environment variables
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Kailangan para sa Supabase / cloud PostgreSQL connection
    },
    connectionTimeoutMillis: 10000
});

// Para mahuli kung may error sa connection
pool.on('error', (err) => {
    console.error('❌ Unexpected database error on idle client:', err.message);
});

// I-test ang koneksyon habang nagbubukas ang app
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Database Connection Failed! I-check ang DATABASE_URL sa Render environment variables:', err.message);
    } else {
        console.log('✅ Connected to Supabase PostgreSQL Database successfully!');
    }
});

module.exports = pool;