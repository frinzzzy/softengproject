const pool = require('./db');

const deductStock = async (client, items, orderId) => {
    for (const item of items) {
        const menuRes = await client.query(
            'SELECT id, stock_quantity FROM menu_items WHERE id = $1::int FOR UPDATE',
            [item.menu_item_id]
        );

        if (menuRes.rows.length > 0) {
            const prevStock = menuRes.rows[0].stock_quantity ?? 0;
            const newStock = prevStock - item.quantity;
            const makeUnavailable = newStock > 0;

            await client.query(
                `UPDATE menu_items 
                 SET stock_quantity = $1::int, is_available = $2::boolean 
                 WHERE id = $3::int`,
                [newStock, makeUnavailable, item.menu_item_id]
            );

            await client.query(
                `INSERT INTO inventory_logs (menu_item_id, previous_quantity, new_quantity, adjustment_type, notes)
                 VALUES ($1::int, $2::int, $3::int, 'ORDER_DEDUCTION', $4)`,
                [item.menu_item_id, prevStock, newStock, `Deducted for Order #${orderId}`]
            );
        }
    }
};

const restockOrderItems = async (client, orderId, adjustmentType, notes) => {
    const itemsResult = await client.query(
        'SELECT menu_item_id, quantity FROM order_items WHERE order_id = $1::int',
        [orderId]
    );

    for (const item of itemsResult.rows) {
        const menuItemRes = await client.query(
            'SELECT stock_quantity FROM menu_items WHERE id = $1::int FOR UPDATE',
            [item.menu_item_id]
        );

        if (menuItemRes.rows.length > 0) {
            const prevStock = menuItemRes.rows[0].stock_quantity ?? 0;
            const newStock = prevStock + item.quantity;
            const isAvailable = newStock > 0;

            await client.query(
                `UPDATE menu_items 
                 SET stock_quantity = $1::int, is_available = $2::boolean 
                 WHERE id = $3::int`,
                [newStock, isAvailable, item.menu_item_id]
            );

            await client.query(
                `INSERT INTO inventory_logs (menu_item_id, previous_quantity, new_quantity, adjustment_type, notes)
                 VALUES ($1::int, $2::int, $3::int, $4, $5)`,
                [item.menu_item_id, prevStock, newStock, adjustmentType, notes]
            );
        }
    }
};

module.exports = { deductStock, restockOrderItems };
