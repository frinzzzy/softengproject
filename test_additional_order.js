const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'lmco',
  password: 'frinz108357100150',
  port: 5432,
});

async function sendNewRoundOrder(tableId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Check for active session OR create a new one automatically
    let sessionRes = await client.query(
      `SELECT id FROM table_sessions WHERE table_id = $1 AND session_status = 'ACTIVE'`,
      [tableId]
    );

    let sessionId;
    if (sessionRes.rows.length === 0) {
      console.log(`No active session found for Table #${tableId}. Opening new session...`);
      const newSession = await client.query(
        `INSERT INTO table_sessions (table_id, session_status) VALUES ($1, 'ACTIVE') RETURNING id`,
        [tableId]
      );
      sessionId = newSession.rows[0].id;
    } else {
      sessionId = sessionRes.rows[0].id;
    }

    const clientOrderId = crypto.randomUUID();
    const totalAmount = 180.00;

    // 2. Insert new order bound to active session
    const orderRes = await client.query(
      `INSERT INTO orders (session_id, table_id, client_order_id, total_amount, order_status)
       VALUES ($1, $2, $3, $4, 'PENDING')
       RETURNING *;`,
      [sessionId, tableId, clientOrderId, totalAmount]
    );

    // 3. Insert items for this order
    await client.query(
      `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price)
       VALUES ($1, $2, $3, $4);`,
      [orderRes.rows[0].id, 2, 1, 180.00]
    );

    await client.query('COMMIT');

    console.log(`Successfully created order under Session #${sessionId}!`);
    console.log('New Order Output:', orderRes.rows[0]);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating order:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
}

// Run test on Table 1
sendNewRoundOrder(1);