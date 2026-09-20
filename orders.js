const pool = require('./db');

// Helper function for statutory Senior Citizen / PWD calculations
function computeStatutoryDiscount(grossAmount, isEligible) {
    if (!isEligible) {
        return { netTotal: grossAmount, discount: 0 };
    }

    // Step 1: Remove 12% VAT
    const vatExemptSales = grossAmount / 1.12;

    // Step 2: Apply 20% discount on VAT-exempt sales
    const discount = vatExemptSales * 0.20;

    // Step 3: Final net total
    const netTotal = grossAmount - discount;

    return {
        netTotal: parseFloat(netTotal.toFixed(2)),
        discount: parseFloat(discount.toFixed(2))
    };
}

// 1. CREATE ORDER (With Idempotency, Session Tracking, Stock Validation & Add-ons Persistence)
const createOrder = async (req, res) => {
    const { table_id, session_id, items } = req.body;
    const clientOrderId = req.headers['x-idempotency-key'] || req.body.client_order_id;

    if (!table_id || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'Invalid order payload or missing table ID.' });
    }

    if (!clientOrderId) {
        return res.status(400).json({ success: false, message: 'Idempotency key header (x-idempotency-key) is required.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // FIX 1: Match `client_order_id` from updated schema
        const existingOrder = await client.query(
            'SELECT * FROM orders WHERE client_order_id = $1',
            [clientOrderId]
        );

        if (existingOrder.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(200).json({
                success: true,
                message: 'Order already processed (Idempotent replay).',
                data: existingOrder.rows[0]
            });
        }

        // FIX 2: Validate/Resolve active session ID for the table
        let targetSessionId = session_id;
        if (!targetSessionId) {
            const activeSessionRes = await client.query(
                `SELECT id FROM table_sessions WHERE table_id = $1 AND session_status = 'ACTIVE' LIMIT 1`,
                [table_id]
            );

            if (activeSessionRes.rows.length === 0) {
                // Auto-create session if none exists
                const newSession = await client.query(
                    `INSERT INTO table_sessions (table_id, session_status) VALUES ($1, 'ACTIVE') RETURNING id`,
                    [table_id]
                );
                targetSessionId = newSession.rows[0].id;
            } else {
                targetSessionId = activeSessionRes.rows[0].id;
            }
        }

        let totalAmount = 0;
        const verifiedItems = [];

        for (const item of items) {
            const menuResult = await client.query(
                'SELECT id, price, is_available FROM menu_items WHERE id = $1',
                [item.menu_item_id]
            );

            if (menuResult.rows.length === 0) {
                throw new Error(`Menu item with ID ${item.menu_item_id} not found.`);
            }

            const menuItem = menuResult.rows[0];

            if (!menuItem.is_available) {
                throw new Error(`Item ID ${item.menu_item_id} is currently out of stock.`);
            }

            const unitPrice = parseFloat(menuItem.price);
            const quantity = parseInt(item.quantity, 10);
            let itemTotal = unitPrice * quantity;

            // FEATURE #4 ADD-ON LOGIC: Validate and compute add-ons for this item
            const verifiedAddons = [];
            if (item.addons && Array.isArray(item.addons)) {
                for (const addonRef of item.addons) {
                    const addonId = typeof addonRef === 'object' ? (addonRef.addon_id || addonRef.id) : addonRef;
                    const addonResult = await client.query(
                        'SELECT id, menu_item_id, price FROM menu_addons WHERE id = $1 AND menu_item_id = $2',
                        [addonId, menuItem.id]
                    );

                    if (addonResult.rows.length === 0) {
                        throw new Error(`Add-on ID ${addonId} not found or not applicable to item ID ${menuItem.id}.`);
                    }

                    const addon = addonResult.rows[0];
                    const addonPrice = parseFloat(addon.price);
                    itemTotal += addonPrice * quantity; // Add-on price multiplied by item quantity

                    verifiedAddons.push({
                        addon_id: addon.id,
                        price: addonPrice
                    });
                }
            }

            totalAmount += itemTotal;

            verifiedItems.push({
                menu_item_id: menuItem.id,
                quantity,
                unit_price: unitPrice,
                addons: verifiedAddons
            });
        }

        // FIX 3: Match schema columns `session_id`, `client_order_id`, and `order_status`
        const orderInsertQuery = `
            INSERT INTO orders (session_id, table_id, client_order_id, total_amount, order_status)
            VALUES ($1, $2, $3, $4, 'PENDING')
            RETURNING id, session_id, table_id, client_order_id, total_amount, order_status, created_at;
        `;
        const orderResult = await client.query(orderInsertQuery, [targetSessionId, table_id, clientOrderId, totalAmount]);
        const newOrder = orderResult.rows[0];

        for (const vItem of verifiedItems) {
            // Insert order item and get its generated ID
            const orderItemRes = await client.query(
                `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price)
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [newOrder.id, vItem.menu_item_id, vItem.quantity, vItem.unit_price]
            );
            const orderItemId = orderItemRes.rows[0].id;

            // FEATURE #4 ADD-ON PERSISTENCE: Save each verified add-on to order_item_addons
            if (vItem.addons && vItem.addons.length > 0) {
                for (const vAddon of vItem.addons) {
                    await client.query(
                        `INSERT INTO order_item_addons (order_item_id, addon_id, price)
                         VALUES ($1, $2, $3)`,
                        [orderItemId, vAddon.addon_id, vAddon.price]
                    );
                }
            }
        }

        await client.query('COMMIT');

        return res.status(201).json({
            success: true,
            message: 'Order created successfully with add-ons.',
            data: {
                order: newOrder,
                items: verifiedItems
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Order creation error:', error.message);
        return res.status(400).json({
            success: false,
            message: error.message || 'Failed to process order.'
        });
    } finally {
        client.release();
    }
};

// 2. GET ACTIVE ORDERS (For Kitchen Display System - with Add-ons included)
const getOrders = async (req, res) => {
    try {
        // FIX 4: Match `order_status` column and enum check ('PENDING', 'PREPARING')
        const query = `
            SELECT 
                o.id AS order_id,
                o.table_id,
                t.table_number,
                o.total_amount,
                o.order_status,
                o.created_at,
                JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'item_id', oi.menu_item_id,
                        'name', m.name,
                        'quantity', oi.quantity,
                        'unit_price', oi.unit_price,
                        'addons', COALESCE(
                            (
                                SELECT JSON_AGG(
                                    JSON_BUILD_OBJECT(
                                        'addon_id', oia.addon_id,
                                        'name', ma.name,
                                        'price', oia.price
                                    )
                                )
                                FROM order_item_addons oia
                                JOIN menu_addons ma ON oia.addon_id = ma.id
                                WHERE oia.order_item_id = oi.id
                            ), '[]'::json
                        )
                    )
                ) AS items
            FROM orders o
            JOIN tables t ON o.table_id = t.id
            JOIN order_items oi ON o.id = oi.order_id
            JOIN menu_items m ON oi.menu_item_id = m.id
            WHERE o.order_status IN ('PENDING', 'PREPARING')
            GROUP BY o.id, t.table_number
            ORDER BY o.created_at ASC;
        `;

        const { rows } = await pool.query(query);

        return res.status(200).json({
            success: true,
            data: rows,
            message: 'Active orders retrieved successfully.'
        });
    } catch (error) {
        console.error('Fetch orders error:', error.message);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
    }
};

// 3. UPDATE ORDER STATUS (For Kitchen Staff & Waiters)
const updateOrderStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    // FIX 5: Use enum values matching CHECK constraint
    const validStatuses = ['PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED'];

    if (!status || !validStatuses.includes(status.toUpperCase())) {
        return res.status(400).json({
            success: false,
            message: `Invalid status. Allowed values: ${validStatuses.join(', ')}`
        });
    }

    try {
        const query = `
            UPDATE orders 
            SET order_status = $1 
            WHERE id = $2 
            RETURNING id, table_id, order_status, total_amount, created_at;
        `;

        const { rows } = await pool.query(query, [status.toUpperCase(), id]);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Order not found.' });
        }

        return res.status(200).json({
            success: true,
            message: `Order #${id} status updated to ${status.toUpperCase()}.`,
            data: rows[0]
        });
    } catch (error) {
        console.error('Update status error:', error.message);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
    }
};

// 4. PROCESS ORDER PAYMENT & LOG TO PAYMENTS LEDGER (With Senior/PWD Pro-Rata Discount)
const processOrderPayment = async (req, res) => {
    const { id } = req.params;
    const { 
        payment_method, 
        amount_paid, 
        gcash_reference_no, 
        discount_type = 'NONE', 
        customer_name, 
        id_number 
    } = req.body;
    const cashier_id = req.user?.id || null;

    if (!payment_method || amount_paid === undefined) {
        return res.status(400).json({
            success: false,
            message: 'payment_method and amount_paid are required.'
        });
    }

    const formattedMethod = payment_method.toUpperCase();
    if (!['CASH', 'GCASH'].includes(formattedMethod)) {
        return res.status(400).json({ success: false, message: 'Payment method must be CASH or GCASH.' });
    }

    const formattedDiscountType = (discount_type || 'NONE').toUpperCase();
    const validDiscounts = ['NONE', 'SENIOR_CITIZEN', 'PWD'];
    if (!validDiscounts.includes(formattedDiscountType)) {
        return res.status(400).json({ success: false, message: 'Invalid discount type. Allowed: NONE, SENIOR_CITIZEN, PWD.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const orderRes = await client.query('SELECT * FROM orders WHERE id = $1', [id]);
        if (orderRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Order not found.' });
        }

        const order = orderRes.rows[0];
        const grossTotal = parseFloat(order.total_amount);
        const paidAmount = parseFloat(amount_paid);

        const isEligible = formattedDiscountType === 'SENIOR_CITIZEN' || formattedDiscountType === 'PWD';
        const { netTotal, discount: discountAmount } = computeStatutoryDiscount(grossTotal, isEligible);

        if (paidAmount < netTotal) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: `Insufficient payment. Discounted total is ₱${netTotal.toFixed(2)}, but received ₱${paidAmount.toFixed(2)}.`
            });
        }

        const changeAmount = paidAmount - netTotal;

        const paymentInsertQuery = `
            INSERT INTO payments (
                order_id, table_id, cashier_id, payment_method, 
                amount_due, amount_paid, change_given, gcash_reference_no, 
                discount_type, discount_amount, sc_pwd_name, sc_pwd_id_no, status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'COMPLETED')
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
            id_number || null
        ]);

        const updatedOrderRes = await client.query(
            `UPDATE orders SET order_status = 'COMPLETED' WHERE id = $1 RETURNING *`,
            [id]
        );

        // SAFEGUARD: I-check muna kung may session_id para hindi mag-hang ang query kung null/undefined
        if (order.session_id) {
            await client.query(
                `UPDATE table_sessions 
                 SET session_status = 'CLOSED', closed_at = CURRENT_TIMESTAMP 
                 WHERE id = $1 AND session_status = 'ACTIVE'`,
                [order.session_id]
            );
        }

        await client.query('COMMIT');

        return res.status(200).json({
            success: true,
            message: `Order #${id} paid successfully with ${formattedDiscountType} discount applied. Table session closed.`,
            data: {
                order: updatedOrderRes.rows[0],
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
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Payment processing error:', error.message);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
    } finally {
        client.release();
    }
};

// 5. GET DAILY SALES REPORT (From Payments Ledger)
const getDailySalesReport = async (req, res) => {
    try {
        // FIX 9: Aggregate from `payments` ledger table for audit accuracy
        const query = `
            SELECT 
                COUNT(id) AS total_transactions,
                COALESCE(SUM(amount_due), 0) AS gross_sales,
                COALESCE(SUM(CASE WHEN payment_method = 'CASH' THEN amount_due ELSE 0 END), 0) AS cash_sales,
                COALESCE(SUM(CASE WHEN payment_method = 'GCASH' THEN amount_due ELSE 0 END), 0) AS gcash_sales
            FROM payments
            WHERE status = 'COMPLETED' 
              AND created_at::date = CURRENT_DATE;
        `;

        const { rows } = await pool.query(query);

        return res.status(200).json({
            success: true,
            data: {
                date: new Date().toISOString().split('T')[0],
                total_transactions: parseInt(rows[0].total_transactions, 10),
                gross_sales: parseFloat(rows[0].gross_sales),
                cash_sales: parseFloat(rows[0].cash_sales),
                gcash_sales: parseFloat(rows[0].gcash_sales)
            },
            message: 'Daily sales summary generated successfully.'
        });
    } catch (error) {
        console.error('Daily sales report error:', error.message);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
    }
};

module.exports = {
    createOrder,
    getOrders,
    updateOrderStatus,
    processOrderPayment,
    getDailySalesReport
};