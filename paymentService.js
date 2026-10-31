const pool = require('./db');

const computeStatutoryDiscount = (grossAmount, isEligible) => {
    if (!isEligible) {
        return { netTotal: grossAmount, discount: 0 };
    }

    const vatExemptSales = grossAmount / 1.12;
    const discount = vatExemptSales * 0.20;
    const netTotal = grossAmount - discount;

    return {
        netTotal: parseFloat(netTotal.toFixed(2)),
        discount: parseFloat(discount.toFixed(2))
    };
};

const processOrderPayment = async ({
    orderId,
    payment_method,
    amount_paid,
    gcash_reference_no,
    discount_type = 'NONE',
    customer_name,
    id_number,
    cashier_id
}) => {
    const formattedMethod = payment_method.toUpperCase();
    const formattedDiscountType = (discount_type || 'NONE').toUpperCase();

    if (!['CASH', 'GCASH'].includes(formattedMethod)) {
        return { ok: false, error: 'INVALID_PAYMENT_METHOD', message: 'Payment method must be CASH or GCASH.' };
    }

    const validDiscounts = ['NONE', 'SENIOR_CITIZEN', 'PWD'];

    if (!validDiscounts.includes(formattedDiscountType)) {
        return { ok: false, error: 'INVALID_DISCOUNT', message: 'Invalid discount type. Allowed: NONE, SENIOR_CITIZEN, PWD.' };
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const orderContextRes = await client.query(
            'SELECT table_id, session_id FROM orders WHERE id = $1::int',
            [orderId]
        );

        if (orderContextRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return { ok: false, error: 'ORDER_NOT_FOUND', message: 'Order not found.' };
        }

        const orderContext = orderContextRes.rows[0];
        if (orderContext.table_id != null) {
            await client.query(
                'SELECT id FROM tables WHERE id = $1::int FOR UPDATE',
                [orderContext.table_id]
            );
        }
        if (orderContext.session_id != null) {
            await client.query(
                'SELECT id FROM table_sessions WHERE id = $1::int FOR UPDATE',
                [orderContext.session_id]
            );
        }

        const orderRes = await client.query(
            'SELECT * FROM orders WHERE id = $1::int FOR UPDATE',
            [orderId]
        );

        if (orderRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return { ok: false, error: 'ORDER_NOT_FOUND', message: 'Order not found.' };
        }

        const order = orderRes.rows[0];

        if (['CANCELLED', 'DECLINED'].includes(order.order_status)) {
            await client.query('ROLLBACK');
            return { ok: false, error: 'INVALID_ORDER_STATUS', message: `Cannot process payment for an order with status '${order.order_status}'.` };
        }

        const grossTotal = parseFloat(order.total_amount);
        const paidAmount = parseFloat(amount_paid);
        const isEligible = formattedDiscountType === 'SENIOR_CITIZEN' || formattedDiscountType === 'PWD';
        const { netTotal, discount: discountAmount } = computeStatutoryDiscount(grossTotal, isEligible);

        if (paidAmount < netTotal) {
            await client.query('ROLLBACK');
            return { ok: false, error: 'INSUFFICIENT_PAYMENT', message: `Insufficient payment. Discounted total is ₱${netTotal.toFixed(2)}, but received ₱${paidAmount.toFixed(2)}.` };
        }

        const changeAmount = paidAmount - netTotal;

        const paymentInsertQuery = `
            INSERT INTO payments (
                order_id, table_id, cashier_id, payment_method,
                amount_due, amount_paid, change_given, gcash_reference_no,
                discount_type, discount_amount, sc_pwd_name, sc_pwd_id, status
            )
            VALUES ($1::int, $2::int, $3::int, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *;
        `;

        const paymentRes = await client.query(paymentInsertQuery, [
            order.id,
            order.table_id,
            cashier_id,
            formattedMethod,
            netTotal,
            paidAmount,
            changeAmount,
            gcash_reference_no || null,
            formattedDiscountType,
            discountAmount,
            customer_name || null,
            id_number || null,
            'COMPLETED'
        ]);

        const updatedOrderRes = await client.query(
            `UPDATE orders 
             SET order_status = 'COMPLETED', 
                 total_amount = $1::numeric 
             WHERE id = $2::int 
             RETURNING *`,
            [netTotal, orderId]
        );

        const updatedOrder = updatedOrderRes.rows[0];

        if (order.session_id) {
            const remainingOrders = await client.query(
                `SELECT COUNT(*) AS count
                 FROM orders
                 WHERE session_id = $1::int
                   AND id != $2::int
                   AND (order_status IN ('PENDING', 'PREPARING', 'READY', 'SERVED', 'NEW') AND order_status NOT IN ('CANCELLED', 'DECLINED', 'COMPLETED'))`,
                [order.session_id, orderId]
            );

            if (parseInt(remainingOrders.rows[0].count, 10) === 0) {
                await client.query(
                    `UPDATE table_sessions
                     SET session_status = 'CLOSED', 
                         closed_at = CURRENT_TIMESTAMP 
                     WHERE id = $1::int AND UPPER(session_status) IN ('ACTIVE', 'OPEN')`,
                    [order.session_id]
                );
            }
        }

        await client.query('COMMIT');

        return {
            ok: true,
            order: updatedOrder,
            payment: paymentRes.rows[0],
            discount_breakdown: {
                gross_total: grossTotal,
                discount_type: formattedDiscountType,
                discount_applied: discountAmount,
                final_amount_due: netTotal,
                amount_paid: paidAmount,
                change_given: changeAmount,
                customer_info: formattedDiscountType !== 'NONE' ? { customer_name, id_number } : null
            }
        };
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Payment rollback error:', rollbackError.message);
        }
        throw error;
    } finally {
        client.release();
    }
};

module.exports = { computeStatutoryDiscount, processOrderPayment };
