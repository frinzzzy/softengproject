const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// --- POSTGRESQL DATABASE CONNECTION ---
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

// Test DB Connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('[LMCO Engine] Database connection error:', err.stack);
  } else {
    console.log('[LMCO Engine] Connected to PostgreSQL Database.');
    release();
  }
});

// --- ENDPOINTS ---

// 1. Resolve QR Token when customer scans QR code
app.get('/api/session/scan/:qr_token', async (req, res) => {
  const { qr_token } = req.params;

  try {
    // Check if QR token exists in database
    const tableResult = await pool.query(
      'SELECT * FROM tables WHERE qr_token = $1',
      [qr_token]
    );

    if (tableResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid QR Code token.' });
    }

    const foundTable = tableResult.rows[0];

    // Check for an active session in DB
    const sessionResult = await pool.query(
      'SELECT * FROM table_sessions WHERE table_id = $1 AND is_active = TRUE',
      [foundTable.id]
    );

    let sessionToken;

    if (sessionResult.rows.length > 0) {
      sessionToken = sessionResult.rows[0].session_token;
    } else {
      // Create new active session in DB
      sessionToken = `sess_tbl_${foundTable.id}_${Date.now()}`;
      await pool.query(
        'INSERT INTO table_sessions (table_id, session_token) VALUES ($1, $2)',
        [foundTable.id, sessionToken]
      );
    }

    return res.status(200).json({
      success: true,
      table_id: foundTable.id,
      table_number: foundTable.table_number,
      session_token: sessionToken,
      message: `Table session established for ${foundTable.table_number}`
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Server error processing QR scan.' });
  }
});

// 2. Middleware to validate active session on incoming orders
const validateSession = async (req, res, next) => {
  const { session_token, table_id } = req.body;

  if (!session_token || !table_id) {
    return res.status(400).json({ error: 'Missing session token or table ID.' });
  }

  try {
    const sessionResult = await pool.query(
      'SELECT * FROM table_sessions WHERE table_id = $1 AND session_token = $2 AND is_active = TRUE',
      [Number(table_id), session_token]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired table session.' });
    }

    next();
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Server error validating session.' });
  }
};

// 3. Order Placement Endpoint
app.post('/api/orders', validateSession, (req, res) => {
  const { table_id, items } = req.body;

  return res.status(201).json({
    success: true,
    order_id: Math.floor(1000 + Math.random() * 9000),
    table_id: Number(table_id),
    status: 'PENDING',
    items: items || [],
    message: 'Order placed under verified table session.'
  });
});

app.listen(PORT, () => {
  console.log(`[LMCO Backend] Server running on http://localhost:${PORT}`);
});