const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD), // Casts password explicitly to String
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

module.exports = pool;