require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('./db');
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET must be set before starting the backend.');
}

const authRoutes = require('./auth');
const assistanceRoutes = require('./assistance');

const { startAutoCloseMonitor } = require('./autoclose');

const eventHub = require('./eventHub');

const { 
  createEventReservation, 
  getEventReservations, 
  updateEventReservation, 
  cancelEventReservation 
} = require('./eventReservation');

const { 
  createOrder, 
  getOrderById,
  getUnfinishedOrders,
  getTableSessionBill,
  getOrders, 
  getCustomerLiveOrders,
  getSessionOrder,
  getSessionOrdersSummary,
  updateOrderStatus, 
  processOrderPayment, 
  getDailySalesReport,
  cancelOrder,
  cancelTableSession,
  requestBill,
  updateItemStock
} = require('./orders');

const {
  createReservation,
  getReservations,
  checkInReservation
} = require('./reservations');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"]
  }
});

app.set('io', io);
app.set('event_hub', eventHub);

eventHub.setIO(io);

const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/assistance', assistanceRoutes);

pool.connect((err, client, release) => {
  if (err) {
    console.error('[LMCO Engine] Database connection error:', err.message);
  } else {
    console.log('[LMCO Engine] Connected to PostgreSQL Database.');
    release();
  }
});

io.on('connection', (socket) => {
  console.log(`⚡ [Socket.io] User connected: ${socket.id}`);

  socket.on('join_room', (roomName) => {
    socket.join(roomName);
    console.log(`User joined room: ${roomName}`);
  });

  socket.on('leave_room', (roomName) => {
    socket.leave(roomName);
    console.log(`User left room: ${roomName}`);
  });

  socket.on('disconnect', () => {
    console.log(`🔌 [Socket.io] User disconnected: ${socket.id}`);
  });
});

startAutoCloseMonitor(eventHub);

const logAuthDebug = (event, details) => {
  if (process.env.DEBUG_API_RESPONSES === 'true') {
    console.log(`[Auth Debug] ${event}`, details);
  }
};

const getBearerToken = (authorizationHeader) => {
  if (typeof authorizationHeader !== 'string') return null;
  return authorizationHeader.match(/^Bearer\s+(\S+)\s*$/i)?.[1] || null;
};

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    }
    req.user = user;
    next();
  });
};

const authenticateSessionToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = getBearerToken(authHeader);

  if (!token) {
    logAuthDebug('customer session token rejected', {
      session_id: req.params.session_id,
      reason: authHeader ? 'invalid_authorization_header' : 'missing_authorization_header'
    });
    return res.status(401).json({ success: false, message: 'Table session token required.' });
  }

  jwt.verify(token, JWT_SECRET, (err, claims) => {
    if (err) {
      logAuthDebug('customer session token rejected', {
        session_id: req.params.session_id,
        reason: 'invalid_or_expired_token'
      });
      return res.status(401).json({ success: false, message: 'Invalid or expired table session token.' });
    }

    if (
      claims.purpose !== 'table_session' ||
      Number(claims.session_id) !== Number(req.params.session_id)
    ) {
      logAuthDebug('customer session token rejected', {
        requested_session_id: Number(req.params.session_id),
        token_session_id: Number(claims.session_id),
        purpose: claims.purpose,
        reason: 'session_or_purpose_mismatch'
      });
      return res.status(403).json({ success: false, message: 'Token is not valid for this table session.' });
    }

    req.tableSessionClaims = claims;
    logAuthDebug('customer session token accepted', {
      session_id: Number(claims.session_id),
      table_id: Number(claims.table_id)
    });
    next();
  });
};

const touchTableSession = async (sessionId, tableId) => {
  const { rows } = await pool.query(
    `UPDATE table_sessions
     SET last_active_at = CURRENT_TIMESTAMP
     WHERE id = $1::int
       AND table_id = $2::int
       AND UPPER(session_status) IN ('ACTIVE', 'OPEN')
     RETURNING id`,
    [sessionId, tableId]
  );

  return rows.length > 0;
};

const touchSessionFromToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return next();
  }

  const token = getBearerToken(authHeader);
  if (!token) {
    logAuthDebug('table bill token rejected', { reason: 'invalid_authorization_header' });
    return res.status(401).json({ success: false, message: 'Invalid authorization header.' });
  }

  let claims;
  try {
    claims = jwt.verify(token, JWT_SECRET);
  } catch (error) {
    logAuthDebug('table bill token rejected', { reason: 'invalid_or_expired_token' });
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }

  if (claims.purpose !== 'table_session') {
    return next();
  }

  const sessionId = Number(claims.session_id);
  const tableId = Number(claims.table_id);
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 ||
      !Number.isSafeInteger(tableId) || tableId <= 0) {
    return res.status(401).json({ success: false, message: 'Invalid table session token.' });
  }

  try {
    const touched = await touchTableSession(sessionId, tableId);
    if (!touched) {
      logAuthDebug('table bill token rejected', {
        session_id: sessionId,
        table_id: tableId,
        reason: 'inactive_session'
      });
      return res.status(401).json({ success: false, message: 'Table session is no longer active.' });
    }
    logAuthDebug('table bill session touched', { session_id: sessionId, table_id: tableId });
    return next();
  } catch (error) {
    console.error('Touch table session activity error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to update table session activity.' });
  }
};

const touchAuthenticatedSession = async (req, res, next) => {
  const sessionId = Number(req.params.session_id);
  const tableId = Number(req.tableSessionClaims?.table_id);

  try {
    const touched = await touchTableSession(sessionId, tableId);
    if (!touched) {
      logAuthDebug('customer session rejected', {
        session_id: sessionId,
        table_id: tableId,
        reason: 'inactive_session'
      });
      return res.status(401).json({ success: false, message: 'Table session is no longer active.' });
    }
    logAuthDebug('customer session activity confirmed', { session_id: sessionId, table_id: tableId });
    return next();
  } catch (error) {
    console.error('Touch authenticated session error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to update table session activity.' });
  }
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

app.get('/', (req, res) => {
  res.json({ message: 'LMCO Backend Engine active.' });
});

app.get('/api/session/scan/:qr_token', async (req, res) => {
  const { qr_token } = req.params;

  try {
    let tableId;
    
    try {
      const decoded = jwt.verify(qr_token, JWT_SECRET);
      if (decoded && decoded.table_id) {
        tableId = decoded.table_id;
      }
    } catch (jwtErr) {
      // Plain string qr_token fallback
    }

    let tableResult;
    if (tableId) {
      tableResult = await pool.query('SELECT * FROM tables WHERE id = $1', [tableId]);
    } else {
      tableResult = await pool.query('SELECT * FROM tables WHERE qr_token = $1', [qr_token]);
    }

    if (tableResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid QR Code token.' });
    }

    const foundTable = tableResult.rows[0];

    const sessionResult = await pool.query(
      "SELECT * FROM table_sessions WHERE table_id = $1 AND UPPER(session_status) IN ('ACTIVE', 'OPEN') ORDER BY id DESC LIMIT 1",
      [foundTable.id]
    );

    let session;

    if (sessionResult.rows.length > 0) {
      session = sessionResult.rows[0];
      await pool.query(
        "UPDATE table_sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = $1",
        [session.id]
      );
    } else {
      const newSessionResult = await pool.query(
        "INSERT INTO table_sessions (table_id, session_status, last_active_at) VALUES ($1, 'ACTIVE', CURRENT_TIMESTAMP) RETURNING *",
        [foundTable.id]
      );
      session = newSessionResult.rows[0];
    }

    return res.status(200).json({
      success: true,
      table_id: foundTable.id,
      table_number: foundTable.table_number,
      session_id: session.id,
      session_token: jwt.sign(
        {
          purpose: 'table_session',
          session_id: session.id,
          table_id: foundTable.id
        },
        JWT_SECRET,
        { expiresIn: '12h' }
      ),
      message: `Table session established for Table ${foundTable.table_number}`
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Server error processing QR scan.' });
  }
});

app.post('/api/v1/dev/force-active-session', async (req, res) => {
  const { table_id } = req.body;
  if (!table_id) {
    return res.status(400).json({ success: false, message: 'table_id is required.' });
  }
  try {
    const sessionRes = await pool.query(
      "INSERT INTO table_sessions (table_id, session_status, last_active_at) VALUES ($1::int, 'ACTIVE', CURRENT_TIMESTAMP) RETURNING id",
      [Number(table_id)]
    );
    return res.status(200).json({
      success: true,
      message: 'Active session forced successfully.',
      session_id: sessionRes.rows[0].id
    });
  } catch (error) {
    console.error('Force active session error:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/v1/orders', createOrder);
app.get('/api/v1/orders/unfinished', getUnfinishedOrders);
app.get('/api/v1/orders/:id', getOrderById);
// TEMP DISABLED (Bill Request feature on hold)
// app.get('/api/v1/tables/:table_id/bill', touchSessionFromToken, getTableSessionBill);
app.get('/api/v1/orders', authenticateToken, authorizeRoles('ADMIN', 'WAITER', 'KITCHEN', 'CASHIER'), getOrders);

app.get('/api/v1/customer/orders/live', getCustomerLiveOrders);

app.get('/api/v1/customer/sessions/:session_id/orders/:order_id', authenticateSessionToken, touchAuthenticatedSession, getSessionOrder);
app.get('/api/v1/customer/sessions/:session_id/orders-summary', authenticateSessionToken, touchAuthenticatedSession, getSessionOrdersSummary);
app.post('/api/v1/customer/sessions/:session_id/activity', authenticateSessionToken, touchAuthenticatedSession, (req, res) => {
  const sessionId = Number(req.params.session_id);
  return res.status(200).json({ success: true, session_id: sessionId });
});
app.patch('/api/v1/orders/:id/status', authenticateToken, authorizeRoles('ADMIN', 'WAITER', 'KITCHEN'), updateOrderStatus);
app.post('/api/v1/orders/:id/pay', authenticateToken, authorizeRoles('ADMIN', 'CASHIER', 'WAITER'), processOrderPayment);
app.get('/api/v1/reports/daily-sales', authenticateToken, authorizeRoles('ADMIN', 'CASHIER'), getDailySalesReport);

app.post('/api/v1/reservations', createReservation);
app.get('/api/v1/reservations', authenticateToken, authorizeRoles('ADMIN', 'WAITER', 'CASHIER'), getReservations);
app.patch('/api/v1/reservations/:id/check-in', authenticateToken, authorizeRoles('ADMIN', 'WAITER'), checkInReservation);

app.post('/api/v1/event-reservations', createEventReservation);
app.get('/api/v1/event-reservations', getEventReservations);
app.put('/api/v1/event-reservations/:id', authenticateToken, authorizeRoles('ADMIN', 'WAITER', 'CASHIER'), updateEventReservation);         
app.patch('/api/v1/event-reservations/:id/cancel', authenticateToken, authorizeRoles('ADMIN', 'WAITER', 'CASHIER'), cancelEventReservation);

app.get('/api/v1/menu', touchSessionFromToken, async (req, res) => {
  try {
    const { category_id, search } = req.query;

    let query = `
      SELECT 
        m.id, 
        m.name, 
        m.price, 
        m.is_available,
        m.stock_quantity,
        m.low_stock_threshold,
        m.category_id,
        m.image_url,
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

app.get('/api/v1/menu/:id/add-ons', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT id, name, price FROM menu_addons WHERE menu_item_id = $1 ORDER BY id ASC',
      [id]
    );
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching menu add-ons:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch menu add-ons.' });
  }
});

app.post('/api/v1/menu', authenticateToken, authorizeRoles('ADMIN'), async (req, res) => {
  const { category_id, name, price, is_available, stock_quantity, low_stock_threshold, image_url } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO menu_items (category_id, name, price, is_available, stock_quantity, low_stock_threshold, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [category_id || null, name, price, is_available ?? true, stock_quantity ?? 50, low_stock_threshold ?? 10, image_url || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create menu item.' });
  }
});

app.put('/api/v1/menu/:id', authenticateToken, authorizeRoles('ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { category_id, name, price, is_available, stock_quantity, low_stock_threshold, image_url } = req.body;

  try {
    const query = `
      UPDATE menu_items
      SET category_id = $1, name = $2, price = $3, is_available = $4, stock_quantity = $5, low_stock_threshold = $6, image_url = $7
      WHERE id = $8
      RETURNING *
    `;
    const result = await pool.query(query, [category_id, name, price, is_available, stock_quantity ?? 50, low_stock_threshold ?? 10, image_url, id]);

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

app.patch('/api/v1/menu/:id/stock', authenticateToken, authorizeRoles('ADMIN', 'KITCHEN', 'CASHIER'), updateItemStock);

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

// TEMP DISABLED (Bill Request feature on hold)
// app.get('/api/v1/customer/sessions/:session_id/bill', touchSessionFromToken, requestBill);
// app.get('/api/v1/tables/:table_id/bill', touchSessionFromToken, getTableSessionBill);

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
    const jwtSecret = JWT_SECRET;
    
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
        qr_url: `http://10.128.25.7:5000/api/session/scan/${signedQrToken}`
      },
      message: `Signed QR code successfully generated for Table ${table.table_number}`
    });

  } catch (err) {
    console.error('❌ [LMCO QR Generator Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate QR token.' });
  }
});

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
      DO UPDATE SET qr_token = EXCLUDED.qr_token
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
      JWT_SECRET,
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

app.get('/api/v1/customer/menu', async (req, res) => {
  try {
    const { category_id, search } = req.query;

    let query = `
      SELECT 
        m.id, 
        m.name, 
        m.price, 
        m.is_available,
        m.stock_quantity,
        m.low_stock_threshold,
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
    res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error('Error fetching menu:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch menu items.',
      details: error.message,
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[LMCO Backend] Server running on http://10.128.25.7:${PORT}`);
});