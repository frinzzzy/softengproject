const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// --- POSTGRESQL CONNECTION ---
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('[LMCO Engine] Database connection error:', err.stack);
  } else {
    console.log('[LMCO Engine] Connected to PostgreSQL Database.');
    release();
  }
});

// --- HEALTH CHECK ROUTE ---
app.get('/', (req, res) => {
  res.json({ message: 'LMCO Backend Engine active.' });
});

// ==========================================
// WEEK 1 ROUTES: SESSIONS & ORDERS
// ==========================================

// 1. Resolve QR Token
app.get('/api/session/scan/:qr_token', async (req, res) => {
  const { qr_token } = req.params;

  try {
    const tableResult = await pool.query(
      'SELECT * FROM tables WHERE qr_token = $1',
      [qr_token]
    );

    if (tableResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid QR Code token.' });
    }

    const foundTable = tableResult.rows[0];

    const sessionResult = await pool.query(
      'SELECT * FROM table_sessions WHERE table_id = $1 AND is_active = TRUE',
      [foundTable.id]
    );

    let sessionToken;

    if (sessionResult.rows.length > 0) {
      sessionToken = sessionResult.rows[0].session_token;
    } else {
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

// 2. Validate Session Middleware
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

// 3. Submit Order
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

// ==========================================
// WEEK 2 ROUTES: MENU MANAGEMENT CRUD
// ==========================================

// 1. READ ALL MENU ITEMS
app.get('/api/v1/menu', async (req, res) => {
  try {
    const query = `
      SELECT 
        m.id, 
        m.name, 
        m.price, 
        m.is_available, 
        m.category_id,
        c.name AS category_name
      FROM menu_items m
      LEFT JOIN categories c ON m.category_id = c.id
      ORDER BY m.id ASC
    `;
    const result = await pool.query(query);
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch menu items.' });
  }
});

// 2. CREATE NEW MENU ITEM
app.post('/api/v1/menu', async (req, res) => {
  const { category_id, name, price } = req.body;

  if (!name || !price) {
    return res.status(400).json({ error: 'Item name and price are required.' });
  }

  try {
    const query = `
      INSERT INTO menu_items (category_id, name, price)
      VALUES ($1, $2, $3)
      RETURNING *
    `;
    const result = await pool.query(query, [category_id || null, name, price]);
    return res.status(201).json({ success: true, item: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to create menu item.' });
  }
});

// 3. UPDATE MENU ITEM
app.put('/api/v1/menu/:id', async (req, res) => {
  const { id } = req.params;
  const { category_id, name, price, is_available } = req.body;

  try {
    const query = `
      UPDATE menu_items
      SET category_id = $1, name = $2, price = $3, is_available = $4
      WHERE id = $5
      RETURNING *
    `;
    const result = await pool.query(query, [category_id || null, name, price, is_available, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Menu item not found.' });
    }

    return res.status(200).json({ success: true, item: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to update menu item.' });
  }
});

// 4. DELETE MENU ITEM
app.delete('/api/v1/menu/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM menu_items WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Menu item not found.' });
    }

    return res.status(200).json({ success: true, message: 'Menu item deleted.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to delete menu item.' });
  }
});

app.listen(PORT, () => {
  console.log(`[LMCO Backend] Server running on http://localhost:${PORT}`);
});