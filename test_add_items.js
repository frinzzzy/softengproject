const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'lmco',
  password: 'frinz108357100150',
  port: 5432,
});

async function addItemsToOrder(orderId, newMenuItemId, quantity, unitPrice) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verify order exists and is not completed
    const orderRes = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND order_status IN ('PENDING', 'PREPARING')`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      throw new Error(`Order #${orderId} is either closed, completed, or missing.`);
    }

    const additionalCost = quantity * unitPrice;

    // 2. Insert new item into order_items
    const itemRes = await client.query(
      `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price)
       VALUES ($1, $2, $3, $4)
       RETURNING *;`,
      [orderId, newMenuItemId, quantity, unitPrice]
    );

    // 3. Update total_amount in orders table
    const updatedOrderRes = await client.query(
      `UPDATE orders 
       SET total_amount = total_amount + $1 
       WHERE id = $2 
       RETURNING *;`,
      [additionalCost, orderId]
    );

    await client.query('COMMIT');

    console.log(`Successfully added item to Order #${orderId}!`);
    console.log('Added Line Item:', itemRes.rows[0]);
    console.log('Updated Order Total:', updatedOrderRes.rows[0]);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding items:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
}

// Test: Add 1 extra order of Item #2 (₱180.00) to Order #5
addItemsToOrder(5, 2, 1, 180.00);