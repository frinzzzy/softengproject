const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto'); // <--- NILAGAY SA LINE 3 (Pinagsamang crypto module)
const pool = require('./db');
const authRoutes = require('./auth');
const assistanceRoutes = require('./assistance');

const { 
  createOrder, 
  getOrders, 
  updateOrderStatus, 
  processOrderPayment, 
  getDailySalesReport,
  cancelOrder,
  cancelTableSession,
  requestBill
} = require('./orders');

// 👉 IDINAGDAG: Import ng Reservation controllers
const {
  createReservation,
  getReservations,
  checkInReservation
} = require('./reservations');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/assistance', assistanceRoutes);

// Test Pool Connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('[LMCO Engine] Database connection error:', err.stack);
  } else {
    console.log('[LMCO Engine] Connected to PostgreSQL Database.');
    release();
  }
});

// ==========================================
// AUTHENTICATION & RBAC MIDDLEWARE
// ==========================================

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required.' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'lmco_super_secret_jwt_key_2026', (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    }
    req.user = user;
    next();
  });
};

const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    const formattedAllowedRoles = allowedRoles.map(r => r.toUpperCase());
    
    if (!req.user || !formattedAllowedRoles.includes(req.user.role.toUpperCase())) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied: Insufficient permissions for this route.' 
      });
    }
    next();
  };
};

// HEALTH CHECK ROUTE
app.get('/', (req, res) => {
  res.json({ message: 'LMCO Backend Engine active.' });
});

// ==========================================
// SESSIONS & ORDERS
// ==========================================

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
      "SELECT * FROM table_sessions WHERE table_id = $1 AND session_status = 'ACTIVE'",
      [foundTable.id]
    );

    let session;

    if (sessionResult.rows.length > 0) {
      session = sessionResult.rows[0];
    } else {
      const newSessionResult = await pool.query(
        "INSERT INTO table_sessions (table_id, session_status) VALUES ($1, 'ACTIVE') RETURNING *",
        [foundTable.id]
      );
      session = newSessionResult.rows[0];
    }

    return res.status(200).json({
      success: true,
      table_id: foundTable.id,
      table_number: foundTable.table_number,
      session_id: session.id,
      message: `Table session established for Table ${foundTable.table_number}`
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Server error processing QR scan.' });
  }
});

const validateSession = async (req, res, next) => {
  const { session_id, table_id } = req.body;

  if (!session_id || !table_id) {
    return res.status(400).json({ error: 'Missing session ID or table ID.' });
  }

  try {
    const sessionResult = await pool.query(
      "SELECT * FROM table_sessions WHERE id = $1 AND table_id = $2 AND session_status = 'ACTIVE'",
      [Number(session_id), Number(table_id)]
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

// ==========================================
// v1 PRODUCTION ORDER ENDPOINTS
// ==========================================

app.post('/api/v1/orders', createOrder);
app.get('/api/v1/orders', authenticateToken, authorizeRoles('ADMIN', 'WAITER', 'KITCHEN', 'CASHIER'), getOrders);
app.patch('/api/v1/orders/:id/status', authenticateToken, authorizeRoles('ADMIN', 'WAITER', 'KITCHEN'), updateOrderStatus);
app.post('/api/v1/orders/:id/pay', authenticateToken, authorizeRoles('ADMIN', 'CASHIER', 'WAITER'), processOrderPayment);
app.get('/api/v1/reports/daily-sales', authenticateToken, authorizeRoles('ADMIN', 'CASHIER'), getDailySalesReport);

// ==========================================
// RESERVATIONS & SAME-DAY QUEUE ENDPOINTS (IDINAGDAG)
// ==========================================

app.post('/api/v1/reservations', createReservation);
app.get('/api/v1/reservations', authenticateToken, authorizeRoles('ADMIN', 'WAITER', 'CASHIER'), getReservations);
app.patch('/api/v1/reservations/:id/check-in', authenticateToken, authorizeRoles('ADMIN', 'WAITER'), checkInReservation);

// ==========================================
// MENU & CATEGORY ENGINE
// ==========================================

app.get('/api/v1/menu', async (req, res) => {
  try {
    const { category_id, search } = req.query;

    let query = `
      SELECT 
        m.id, 
        m.name, 
        m.price, 
        m.is_available,
        m.category_id,
        COALESCE(
          json_agg(
            json_build_object(
              'id', a.id,
              'name', a.name,
              'price', a.price
            )
          ) FILTER (WHERE a.id IS NOT NULL), '[]'
      ) AS addons
      FROM menu_items m
      LEFT JOIN menu_addons a ON m.id = a.menu_item_id
    `;

    const conditions = [];
    const values = [];

    if (category_id) {
      values.push(category_id);
      conditions.push(`m.category_id = $${values.length}`);
    }

    if (search) {
      values.push(`%${search}%`);
      conditions.push(`m.name ILIKE $${values.length}`);
    }

    if (conditions.length > 0) {
      query += ` WHERE ` + conditions.join(' AND ');
    }

    query += ` GROUP BY m.id ORDER BY m.id ASC;`;

    const { rows } = await pool.query(query, values);
    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error('Error fetching menu:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch menu items.', details: error.message });
  }
});

app.post('/api/v1/menu', authenticateToken, authorizeRoles('ADMIN'), async (req, res) => {
  const { category_id, name, price, is_available } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO menu_items (category_id, name, price, is_available) VALUES ($1, $2, $3, $4) RETURNING *',
      [category_id || null, name, price, is_available ?? true]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create menu item.' });
  }
});

app.put('/api/v1/menu/:id', authenticateToken, authorizeRoles('ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { category_id, name, price, is_available } = req.body;

  try {
    const query = `
      UPDATE menu_items
      SET category_id = $1, name = $2, price = $3, is_available = $4
      WHERE id = $5
      RETURNING *
    `;
    const result = await pool.query(query, [category_id, name, price, is_available, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Menu item not found.' });
    }

    return res.status(200).json({ success: true, item: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to update menu item.' });
  }
});

app.put('/api/v1/orders/:id/cancel', authenticateToken, authorizeRoles('ADMIN', 'WAITER', 'CASHIER'), cancelOrder);
app.put('/api/v1/sessions/:session_id/cancel', authenticateToken, authorizeRoles('ADMIN', 'WAITER', 'CASHIER'), cancelTableSession);

app.patch('/api/v1/menu/:id/toggle-stock', authenticateToken, authorizeRoles('ADMIN', 'KITCHEN'), async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      UPDATE menu_items 
      SET is_available = NOT is_available 
      WHERE id = $1 
      RETURNING id, name, is_available;
    `;

    const { rows } = await pool.query(query, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Menu item not found.' });
    }

    return res.status(200).json({
      success: true,
      message: `Stock status updated for ${rows[0].name}.`,
      data: rows[0]
    });
  } catch (error) {
    console.error('Toggle stock error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/v1/menu/:id', authenticateToken, authorizeRoles('ADMIN'), async (req, res) => {
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

app.get('/api/v1/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM menu_categories ORDER BY id ASC');
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch categories.' });
  }
});

app.get('/api/v1/sessions/:session_id/bill', authenticateToken, authorizeRoles('ADMIN', 'WAITER', 'CASHIER'), requestBill);

app.post('/api/v1/tables/generate-qr', authenticateToken, authorizeRoles('ADMIN', 'WAITER'), async (req, res) => {
  const { table_id } = req.body;

  if (!table_id) {
    return res.status(400).json({ success: false, message: 'table_id is required.' });
  }

  try {
    const tableRes = await pool.query('SELECT * FROM tables WHERE id = $1', [table_id]);
    if (tableRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Table not found.' });
    }

    const table = tableRes.rows[0];
    const jwtSecret = process.env.JWT_SECRET || 'lmco_super_secret_jwt_key_2026';
    
    const signedQrToken = jwt.sign(
      { table_id: table.id, table_number: table.table_number },
      jwtSecret
    );

    await pool.query('UPDATE tables SET qr_token = $1 WHERE id = $2', [signedQrToken, table.id]);

    return res.status(200).json({
      success: true,
      data: {
        table_id: table.id,
        table_number: table.table_number,
        qr_token: signedQrToken,
        qr_url: `http://localhost:5000/api/session/scan/${signedQrToken}`
      },
      message: `Signed QR code successfully generated for ${table.table_number}`
    });

  } catch (err) {
    console.error('❌ [LMCO QR Generator Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate QR token.' });
  }
});

// ==========================================
// STAFF WORKSTATION QR AUTH & GENERATION
// ==========================================

app.post('/api/v1/workstations/generate', authenticateToken, authorizeRoles('ADMIN'), async (req, res) => {
  const { station_type } = req.body; 
  
  if (!['kitchen', 'waiter', 'admin'].includes(station_type)) {
    return res.status(400).json({ success: false, message: 'Invalid station type. Must be kitchen, waiter, or admin.' });
  }

  const qrToken = crypto.randomBytes(32).toString('hex');

  try {
    const query = `
      INSERT INTO workstations (station_type, qr_token) 
      VALUES ($1, $2)
      ON CONFLICT (station_type) 
      DO UPDATE SET qr_token = $2 
      RETURNING *;
    `;
    const result = await pool.query(query, [station_type, qrToken]);
    return res.status(200).json({ success: true, workstation: result.rows[0], message: `Workstation QR generated for ${station_type}` });
  } catch (err) {
    console.error('❌ [LMCO Workstation Gen Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate workstation QR token.', details: err.message });
  }
});

app.post('/api/v1/auth/workstation-scan', async (req, res) => {
  const { qr_token } = req.body;

  if (!qr_token) {
    return res.status(400).json({ success: false, message: 'qr_token is required.' });
  }

  try {
    const result = await pool.query('SELECT * FROM workstations WHERE qr_token = $1', [qr_token]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid workstation QR code.' });
    }

    const station = result.rows[0];

    const token = jwt.sign(
      { station_type: station.station_type, role: station.station_type.toUpperCase() }, 
      process.env.JWT_SECRET || 'lmco_super_secret_jwt_key_2026', 
      { expiresIn: '12h' }
    );

    return res.status(200).json({ 
      success: true, 
      message: `Successfully logged into ${station.station_type} station`,
      token,
      station_type: station.station_type
    });
  } catch (err) {
    console.error('❌ [LMCO Workstation Scan Error]:', err);
    return res.status(500).json({ success: false, message: 'Server error processing workstation scan.', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[LMCO Backend] Server running on http://localhost:${PORT}`);
});