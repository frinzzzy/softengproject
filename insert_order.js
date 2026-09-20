const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'lmco',
  password: 'frinz108357100150',
  port: 5432,
});

async function sendOrder() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Seed Table 1 if missing
    let tableRes = await client.query(`SELECT id FROM tables WHERE id = 1`);
    if (tableRes.rows.length === 0) {
      await client.query(`INSERT INTO tables (id, table_number, qr_token) VALUES (1, 1, 'token_tbl_1')`);
    }

    // 2. Seed Menu Item 2 if missing
    let menuRes = await client.query(`SELECT id FROM menu_items WHERE id = 2`);
    if (menuRes.rows.length === 0) {
      await client.query(`INSERT INTO menu_items (id, name, price) VALUES (2, 'Burger Meal', 180.00)`);
    }

    // 3. Ensure active session for Table 1
    let sessionRes = await client.query(
      `SELECT id FROM table_sessions WHERE table_id = $1 AND session_status = 'ACTIVE'`,
      [1]
    );

    let sessionId;
    if (sessionRes.rows.length === 0) {
      const newSession = await client.query(
        `INSERT INTO table_sessions (table_id, session_status) VALUES ($1, 'ACTIVE') RETURNING id`,
        [1]
      );
      sessionId = newSession.rows[0].id;
    } else {
      sessionId = sessionRes.rows[0].id;
    }

    // 4. Insert Order
    const clientOrderId = crypto.randomUUID();
    const totalAmount = 360.00;

    const orderRes = await client.query(
      `INSERT INTO orders (session_id, table_id, client_order_id, total_amount, order_status)
       VALUES ($1, $2, $3, $4, 'PENDING')
       RETURNING *;`,
      [sessionId, 1, clientOrderId, totalAmount]
    );

    // 5. Insert Order Item
    await client.query(
      `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price)
       VALUES ($1, $2, $3, $4);`,
      [orderRes.rows[0].id, 2, 2, 180.00]
    );

    await client.query('COMMIT');

    console.log('Successfully sent order to PostgreSQL!');
    console.log('Inserted Order:', orderRes.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error inserting order:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
}

sendOrder();