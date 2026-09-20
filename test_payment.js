const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'lmco',
  password: 'frinz108357100150',
  port: 5432,
});

async function processTestPayment(orderId, amountPaid) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch Order details
    const orderRes = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (orderRes.rows.length === 0) {
      throw new Error(`Order #${orderId} not found.`);
    }

    const order = orderRes.rows[0];
    const totalAmount = parseFloat(order.total_amount);

    if (amountPaid < totalAmount) {
      throw new Error(`Insufficient payment. Total is ₱${totalAmount}, but received ₱${amountPaid}.`);
    }

    const changeGiven = amountPaid - totalAmount;

    // 2. Insert transaction record into payments table
    const paymentRes = await client.query(
      `INSERT INTO payments (
        order_id, table_id, cashier_id, payment_method, 
        amount_due, amount_paid, change_given, status
      ) VALUES ($1, $2, $3, 'CASH', $4, $5, $6, 'COMPLETED')
      RETURNING *;`,
      [order.id, order.table_id, null, totalAmount, amountPaid, changeGiven]
    );

    // 3. Update Order status to COMPLETED
    await client.query(
      `UPDATE orders SET order_status = 'COMPLETED' WHERE id = $1`,
      [orderId]
    );

    // 4. Close the Table Session
    await client.query(
      `UPDATE table_sessions 
       SET session_status = 'CLOSED', closed_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND session_status = 'ACTIVE'`,
      [order.session_id]
    );

    await client.query('COMMIT');

    console.log(`Payment successful for Order #${orderId}!`);
    console.log('Payment Ledger Record:', paymentRes.rows[0]);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Payment Error:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
}

// Run payment test for Order #4 with ₱500 cash
processTestPayment(4, 500.00);