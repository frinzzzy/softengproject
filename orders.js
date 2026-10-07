const pool = require('./db');

const getBasket = async (req, res) => {
    const { session_id } = req.params;
    const sessionId = Number(session_id);

    if (!Number.isInteger(sessionId) || sessionId < 1) {
        return res.status(400).json({ success: false, message: 'A valid session_id is required.' });
    }

    try {
        const sessionResult = await pool.query(
            "SELECT id FROM table_sessions WHERE id = $1 AND session_status = 'ACTIVE'",
            [sessionId]
        );

        if (sessionResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Active table session not found.' });
        }

        const { rows } = await pool.query(
            `SELECT bi.id AS basket_item_id, bi.menu_item_id, m.name, bi.quantity, bi.unit_price,
                    COALESCE((
                        SELECT JSON_AGG(JSON_BUILD_OBJECT(
                            'addon_id', bia.addon_id,
                            'name', ma.name,
                            'price', bia.price
                        ))
                        FROM basket_item_addons bia
                        JOIN menu_addons ma ON ma.id = bia.addon_id
                        WHERE bia.basket_item_id = bi.id
                    ), '[]'::json) AS addons,
                    ROUND((bi.quantity * (bi.unit_price + COALESCE((
                        SELECT SUM(bia.price)
                        FROM basket_item_addons bia
                        WHERE bia.basket_item_id = bi.id
                    ), 0)))::numeric, 2) AS subtotal
             FROM basket_items bi
             JOIN menu_items m ON m.id = bi.menu_item_id
             WHERE bi.session_id = $1
             ORDER BY bi.id ASC`,
            [sessionId]
        );

        const total = rows.reduce((sum, item) => sum + Number(item.subtotal), 0);
        return res.status(200).json({
            success: true,
            data: { session_id: sessionId, items: rows, total: Number(total.toFixed(2)) }
        });
    } catch (error) {
        console.error('Fetch basket error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch basket.' });
    }
};

const addBasketItem = async (req, res) => {
    const { session_id, menu_item_id, quantity, addons = [] } = req.body;
    const sessionId = Number(session_id);
    const menuItemId = Number(menu_item_id);
    const itemQuantity = Number(quantity);

    if (!Number.isInteger(sessionId) || sessionId < 1 ||
        !Number.isInteger(menuItemId) || menuItemId < 1 ||
        !Number.isInteger(itemQuantity) || itemQuantity < 1 || !Array.isArray(addons)) {
        return res.status(400).json({
            success: false,
            message: 'session_id, menu_item_id, positive quantity, and an addons array are required.'
        });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const sessionResult = await client.query(
            "SELECT id FROM table_sessions WHERE id = $1 AND session_status = 'ACTIVE'",
            [sessionId]
        );
        if (sessionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Active table session not found.' });
        }

        const menuResult = await client.query(
            'SELECT id, name, price FROM menu_items WHERE id = $1 AND is_available = TRUE',
            [menuItemId]
        );
        if (menuResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Menu item not found or unavailable.' });
        }

        const verifiedAddons = [];
        for (const addonRef of addons) {
            const addonId = Number(typeof addonRef === 'object' && addonRef !== null
                ? (addonRef.addon_id ?? addonRef.id)
                : addonRef);
            if (!Number.isInteger(addonId) || addonId < 1) {
                throw new Error('Each add-on must have a valid addon_id.');
            }

            const addonResult = await client.query(
                'SELECT id, name, price FROM menu_addons WHERE id = $1 AND menu_item_id = $2',
                [addonId, menuItemId]
            );
            if (addonResult.rows.length === 0) {
                throw new Error(`Add-on ${addonId} is not available for this menu item.`);
            }
            verifiedAddons.push(addonResult.rows[0]);
        }

        const itemResult = await client.query(
            `INSERT INTO basket_items (session_id, menu_item_id, quantity, unit_price)
             VALUES ($1, $2, $3, $4)
             RETURNING id, session_id, menu_item_id, quantity, unit_price`,
            [sessionId, menuItemId, itemQuantity, menuResult.rows[0].price]
        );
        const basketItem = itemResult.rows[0];

        for (const addon of verifiedAddons) {
            await client.query(
                'INSERT INTO basket_item_addons (basket_item_id, addon_id, price) VALUES ($1, $2, $3)',
                [basketItem.id, addon.id, addon.price]
            );
        }

        await client.query('COMMIT');
        return res.status(201).json({
            success: true,
            message: 'Item added to basket.',
            data: {
                basket_item_id: basketItem.id,
                session_id: sessionId,
                menu_item_id: menuItemId,
                name: menuResult.rows[0].name,
                quantity: itemQuantity,
                unit_price: Number(menuResult.rows[0].price),
                addons: verifiedAddons.map(addon => ({
                    addon_id: addon.id,
                    name: addon.name,
                    price: Number(addon.price)
                }))
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Add basket item error:', error.message);
        return res.status(400).json({ success: false, message: error.message || 'Failed to add item to basket.' });
    } finally {
        client.release();
    }
};

const removeBasketItem = async (req, res) => {
    const sessionId = Number(req.params.session_id);
    const itemId = Number(req.params.item_id);

    if (!Number.isInteger(sessionId) || sessionId < 1 || !Number.isInteger(itemId) || itemId < 1) {
        return res.status(400).json({ success: false, message: 'Valid session_id and item_id are required.' });
    }

    try {
        const { rows } = await pool.query(
            `DELETE FROM basket_items bi
             USING table_sessions ts
             WHERE bi.id = $1
               AND bi.session_id = $2
               AND ts.id = bi.session_id
               AND ts.session_status = 'ACTIVE'
             RETURNING bi.id AS basket_item_id`,
            [itemId, sessionId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Basket item not found in an active session.' });
        }

        return res.status(200).json({ success: true, message: 'Item removed from basket.', data: rows[0] });
    } catch (error) {
        console.error('Remove basket item error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to remove basket item.' });
    }
};

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

        // Validate/Resolve active session ID for the table
        let targetSessionId = session_id;
        if (!targetSessionId) {
            const activeSessionRes = await client.query(
                `SELECT id FROM table_sessions WHERE table_id = $1 AND session_status = 'ACTIVE' LIMIT 1`,
                [table_id]
            );

            if (activeSessionRes.rows.length === 0) {
                const newSession = await client.query(
                    `INSERT INTO table_sessions (table_id, session_status) VALUES ($1, 'ACTIVE') RETURNING id`,
                    [table_id]
                );
                targetSessionId = newSession.rows[0].id;
            } else {
                targetSessionId = activeSessionRes.rows[0].id;
            }
        }

        // Mark table as OCCUPIED for live dine-in tracking
        await client.query(
            `UPDATE tables SET status = 'OCCUPIED' WHERE id = $1 AND status != 'OCCUPIED'`,
            [table_id]
        );

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

            const verifiedAddons = [];

            if (item.addons && Array.isArray(item.addons)) {
                for (const addonRef of item.addons) {
                    const addonId = typeof addonRef === 'object'
                        ? (addonRef.addon_id || addonRef.id)
                        : addonRef;

                    const addonResult = await client.query(
                        'SELECT id, menu_item_id, price FROM menu_addons WHERE id = $1 AND menu_item_id = $2',
                        [addonId, menuItem.id]
                    );

                    if (addonResult.rows.length === 0) {
                        throw new Error(`Add-on ID ${addonId} not found or not applicable to item ID ${menuItem.id}.`);
                    }

                    const addon = addonResult.rows[0];
                    const addonPrice = parseFloat(addon.price);

                    itemTotal += addonPrice * quantity;

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

        const orderInsertQuery = `
            INSERT INTO orders (session_id, table_id, client_order_id, total_amount, order_status)
            VALUES ($1, $2, $3, $4, 'PENDING')
            RETURNING id, session_id, table_id, client_order_id, total_amount, order_status, created_at;
        `;

        const orderResult = await client.query(
            orderInsertQuery,
            [targetSessionId, table_id, clientOrderId, totalAmount]
        );

        const newOrder = orderResult.rows[0];

        for (const vItem of verifiedItems) {
            const orderItemRes = await client.query(
                `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price)
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [newOrder.id, vItem.menu_item_id, vItem.quantity, vItem.unit_price]
            );

            const orderItemId = orderItemRes.rows[0].id;

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

        const io = req.app.get('io');
        if (io) {
            io.emit('new_order', {
                order_id: newOrder.id,
                table_id: newOrder.table_id,
                status: newOrder.order_status,
                total_amount: newOrder.total_amount,
                message: `New order #${newOrder.id} placed for Table #${newOrder.table_id}`
            });
        }

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
        const query = `
            SELECT 
                o.id AS order_id,
                o.table_id,
                COALESCE(t.table_number, o.table_id) AS table_number,
                o.total_amount,
                o.order_status,
                o.created_at,
                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'item_id', oi.menu_item_id,
                            'name', COALESCE(m.name, 'Item #' || oi.menu_item_id),
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
                    ) FILTER (WHERE oi.id IS NOT NULL), '[]'::json
                ) AS items
            FROM orders o
            LEFT JOIN tables t ON o.table_id = t.id
            LEFT JOIN order_items oi ON o.id = oi.order_id
            LEFT JOIN menu_items m ON oi.menu_item_id = m.id
            WHERE o.order_status IN ('PENDING', 'PREPARING', 'READY', 'NEW')
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
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error.'
        });
    }
};

const getActiveOrdersByTable = async (req, res) => {
    const tableId = Number(req.params.table_id);

    if (!Number.isInteger(tableId) || tableId <= 0) {
        return res.status(400).json({
            success: false,
            message: 'A valid table_id is required.'
        });
    }

    try {
        const query = `
            SELECT
                o.id AS order_id,
                o.table_id,
                COALESCE(t.table_number, o.table_id) AS table_number,
                o.total_amount,
                o.order_status,
                o.created_at,
                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'item_id', oi.menu_item_id,
                            'name', COALESCE(m.name, 'Item #' || oi.menu_item_id),
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
                    ) FILTER (WHERE oi.id IS NOT NULL), '[]'::json
                ) AS items
            FROM orders o
            JOIN table_sessions ts
                ON ts.id = o.session_id
                AND ts.table_id = o.table_id
                AND ts.session_status = 'ACTIVE'
            LEFT JOIN tables t ON o.table_id = t.id
            LEFT JOIN order_items oi ON o.id = oi.order_id
            LEFT JOIN menu_items m ON oi.menu_item_id = m.id
            WHERE o.table_id = $1
                AND o.order_status IN ('PENDING', 'PREPARING', 'READY', 'SERVED')
            GROUP BY o.id, t.table_number
            ORDER BY o.created_at ASC;
        `;

        const { rows } = await pool.query(query, [tableId]);

        return res.status(200).json({
            success: true,
            data: rows,
            message: 'Active orders for table retrieved successfully.'
        });
    } catch (error) {
        console.error('Fetch active orders by table error:', error.message);
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error.'
        });
    }
};

const getUnfinishedOrders = async (req, res) => {
    const tableId = Number(req.query.table_id);

    if (req.query.table_id === undefined || req.query.table_id === '') {
        return res.status(400).json({ error: 'table_id is required' });
    }

    if (!Number.isInteger(tableId) || tableId <= 0) {
        return res.status(400).json({ error: 'table_id must be a valid positive integer' });
    }

    try {
        const query = `
            SELECT
                o.id AS order_id,
                o.order_type,
                o.order_status AS status,
                o.total_amount,
                COALESCE(SUM(oi.quantity), 0)::INT AS item_count,
                o.created_at
            FROM orders o
            JOIN table_sessions ts ON o.session_id = ts.id
            LEFT JOIN order_items oi ON o.id = oi.order_id
            WHERE o.table_id = $1
                AND ts.session_status = 'ACTIVE'
                AND o.order_status NOT IN ('COMPLETED', 'CANCELLED', 'DECLINED')
            GROUP BY o.id, o.order_type, o.order_status, o.total_amount, o.created_at
            ORDER BY o.created_at DESC;
        `;

        const { rows } = await pool.query(query, [tableId]);
        return res.status(200).json({ orders: rows });
    } catch (error) {
        console.error('Fetch unfinished orders error:', error.message);
        return res.status(500).json({ error: 'Failed to fetch unfinished orders' });
    }
};

// 3. UPDATE ORDER STATUS (For Kitchen Staff & Waiters)
const updateOrderStatus = async (req, res) => {
    const { id } = req.params;
    const { status, decline_reason } = req.body;

    const validStatuses = [
        'PENDING',
        'PREPARING',
        'READY',
        'SERVED',
        'COMPLETED',
        'CANCELLED',
        'DECLINED'
    ];

    const formattedStatus = status?.toUpperCase();

    if (!formattedStatus || !validStatuses.includes(formattedStatus)) {
        return res.status(400).json({
            success: false,
            message: `Invalid status. Allowed values: ${validStatuses.join(', ')}`
        });
    }

    if (formattedStatus === 'DECLINED' && !decline_reason?.trim()) {
        return res.status(400).json({
            success: false,
            message: 'decline_reason is required when declining an order.'
        });
    }

    try {
        const query = `
            UPDATE orders 
            SET order_status = $1,
                decline_reason = $2
            WHERE id = $3 
            RETURNING id, table_id, order_status, decline_reason, total_amount, created_at;
        `;

        const { rows } = await pool.query(query, [
            formattedStatus,
            formattedStatus === 'DECLINED' ? decline_reason.trim() : null,
            id
        ]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Order not found.'
            });
        }

        const updatedOrder = rows[0];

        const io = req.app.get('io');
        if (io) {
            io.emit('order_status_updated', {
                order_id: updatedOrder.id,
                table_id: updatedOrder.table_id,
                status: updatedOrder.order_status,
                decline_reason: updatedOrder.decline_reason,
                message: `Order #${updatedOrder.id} status is now ${updatedOrder.order_status}`
            });
        }

        return res.status(200).json({
            success: true,
            message: `Order #${id} status updated to ${formattedStatus}.`,
            data: updatedOrder
        });
    } catch (error) {
        console.error('Update status error:', error.message);
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error.'
        });
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
        return res.status(400).json({
            success: false,
            message: 'Payment method must be CASH or GCASH.'
        });
    }

    const formattedDiscountType = (discount_type || 'NONE').toUpperCase();
    const validDiscounts = ['NONE', 'SENIOR_CITIZEN', 'PWD'];

    if (!validDiscounts.includes(formattedDiscountType)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid discount type. Allowed: NONE, SENIOR_CITIZEN, PWD.'
        });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const orderRes = await client.query(
            'SELECT * FROM orders WHERE id = $1',
            [id]
        );

        if (orderRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Order not found.'
            });
        }

        const order = orderRes.rows[0];

        if (['CANCELLED', 'DECLINED'].includes(order.order_status)) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: `Cannot process payment for an order with status '${order.order_status}'.`
            });
        }

        const grossTotal = parseFloat(order.total_amount);
        const paidAmount = parseFloat(amount_paid);

        const isEligible =
            formattedDiscountType === 'SENIOR_CITIZEN' ||
            formattedDiscountType === 'PWD';

        const { netTotal, discount: discountAmount } =
            computeStatutoryDiscount(grossTotal, isEligible);

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
                discount_type, discount_amount, sc_pwd_name, sc_pwd_id, status
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

        // Only close the session when no other active orders remain.
        if (order.session_id) {
            const remainingOrders = await client.query(
                `SELECT COUNT(*) AS count
                 FROM orders
                 WHERE session_id = $1
                   AND id != $2
                   AND order_status IN ('PENDING', 'PREPARING', 'READY', 'SERVED')`,
                [order.session_id, id]
            );

            if (parseInt(remainingOrders.rows[0].count, 10) === 0) {
                await client.query(
                    `UPDATE table_sessions
                     SET session_status = 'CLOSED',
                         closed_at = CURRENT_TIMESTAMP
                     WHERE id = $1 AND session_status = 'ACTIVE'`,
                    [order.session_id]
                );
                await client.query(
                    `UPDATE tables SET status = 'AVAILABLE' WHERE id = $1`,
                    [order.table_id]
                );
            }
        }

        await client.query('COMMIT');

        const io = req.app.get('io');

        if (io) {
            io.emit('order_paid', {
                order_id: order.id,
                table_id: order.table_id,
                status: 'COMPLETED',
                message: `Order #${order.id} has been paid and completed.`
            });
        }

        return res.status(200).json({
            success: true,
            message: `Order #${id} paid successfully with ${formattedDiscountType} discount applied.`,
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
                    customer_info: formattedDiscountType !== 'NONE'
                        ? { customer_name, id_number }
                        : null
                }
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Payment processing error:', error.message);
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error.'
        });
    } finally {
        client.release();
    }
};

// 5. GET DAILY SALES REPORT (From Payments Ledger)
const getDailySalesReport = async (req, res) => {
    try {
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
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error.'
        });
    }
};

// 6. CANCEL ORDER (Customer or Staff with Queue Check)
const cancelOrder = async (req, res) => {
    const { id } = req.params;

    try {
        const checkQuery = 'SELECT id, table_id, order_status FROM orders WHERE id = $1';
        const checkResult = await pool.query(checkQuery, [id]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Order not found.'
            });
        }

        const currentStatus = checkResult.rows[0].order_status;

        if (currentStatus !== 'PENDING') {
            return res.status(400).json({
                success: false,
                message: `Cannot cancel order. Current status is '${currentStatus}'. Only PENDING orders can be cancelled directly. Please approach a waiter for assistance.`
            });
        }

        const updateQuery = `
            UPDATE orders 
            SET order_status = 'CANCELLED' 
            WHERE id = $1 
            RETURNING id, table_id, order_status, total_amount, created_at;
        `;

        const { rows } = await pool.query(updateQuery, [id]);
        const cancelledOrder = rows[0];

        const io = req.app.get('io');

        if (io) {
            io.emit('order_cancelled', {
                order_id: cancelledOrder.id,
                table_id: cancelledOrder.table_id,
                status: cancelledOrder.order_status,
                message: `Order #${cancelledOrder.id} has been cancelled.`
            });
        }

        return res.status(200).json({
            success: true,
            message: `Order #${id} has been successfully cancelled.`,
            data: cancelledOrder
        });

    } catch (error) {
        console.error('Cancel order error:', error.message);
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error.'
        });
    }
};

// 7. CLOSE ACTIVE TABLE SESSION
const cancelTableSession = async (req, res) => {
    const { session_id } = req.params;

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const sessionResult = await client.query(
            "SELECT * FROM table_sessions WHERE id = $1 AND session_status = 'ACTIVE'",
            [session_id]
        );

        if (sessionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Active session not found or already closed.'
            });
        }

        const sessionData = sessionResult.rows[0];

        const updateResult = await client.query(
            "UPDATE table_sessions SET session_status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *",
            [session_id]
        );

        await client.query(
            "UPDATE tables SET status = 'AVAILABLE' WHERE id = $1",
            [sessionData.table_id]
        );

        await client.query('COMMIT');

        const io = req.app.get('io');

        if (io) {
            io.emit('table_session_closed', {
                session_id: sessionData.id,
                table_id: sessionData.table_id,
                status: 'CLOSED',
                message: `Table session #${session_id} has been closed.`
            });
        }

        return res.status(200).json({
            success: true,
            message: `Table session #${session_id} has been successfully closed.`,
            data: updateResult.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Close table session error:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to close table session.'
        });
    } finally {
        client.release();
    }
};

// 8. REQUEST BILL BREAKDOWN (Formal bill preview prior to cashier settlement)
const requestBill = async (req, res) => {
    const { session_id } = req.params;

    try {
        const sessionRes = await pool.query(
            `SELECT ts.id AS session_id, ts.table_id, t.table_number, ts.session_status 
             FROM table_sessions ts 
             JOIN tables t ON ts.table_id = t.id 
             WHERE ts.id = $1 AND ts.session_status = 'ACTIVE'`,
            [session_id]
        );

        if (sessionRes.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Active table session not found.'
            });
        }

        const session = sessionRes.rows[0];

        const ordersRes = await pool.query(
            `SELECT id, total_amount, order_status, created_at 
             FROM orders 
             WHERE session_id = $1 AND order_status NOT IN ('CANCELLED', 'DECLINED')`,
            [session_id]
        );

        const orders = ordersRes.rows;
        const totalAmount = orders.reduce((sum, o) => sum + parseFloat(o.total_amount), 0);

        return res.status(200).json({
            success: true,
            data: {
                session,
                orders,
                total_amount: Number(totalAmount.toFixed(2))
            },
            message: 'Bill breakdown retrieved successfully.'
        });
    } catch (error) {
        console.error('Request bill error:', error.message);
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error.'
        });
    }
};

const getBillByTable = async (req, res) => {
    const { table_id } = req.params;

    try {
        // 1. Find the active session for the table
        const sessionRes = await pool.query(
            `SELECT ts.id AS session_id, ts.table_id, t.table_number, ts.session_status 
             FROM table_sessions ts 
             JOIN tables t ON ts.table_id = t.id 
             WHERE ts.table_id = $1 AND ts.session_status = 'ACTIVE'
             LIMIT 1`,
            [table_id]
        );

        if (sessionRes.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No active session found for this table.'
            });
        }

        const session = sessionRes.rows[0];

        // 2. Fetch orders and detailed order items with add-ons
        const ordersRes = await pool.query(
            `SELECT 
                o.id AS order_id,
                o.client_order_id,
                o.total_amount,
                o.order_status AS status,
                o.created_at,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'name', mi.name,
                            'quantity', oi.quantity,
                            'price', (oi.unit_price * oi.quantity),
                            'details', COALESCE(
                                (
                                    SELECT string_agg(ma.name, ' • ') 
                                    FROM order_item_addons oia 
                                    JOIN menu_addons ma ON oia.addon_id = ma.id 
                                    WHERE oia.order_item_id = oi.id
                                ), 'Standard serving'
                            )
                        )
                    ) FILTER (WHERE oi.id IS NOT NULL), '[]'
                ) AS items
             FROM orders o
             LEFT JOIN order_items oi ON oi.order_id = o.id
             LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
             WHERE o.session_id = $1 AND o.order_status NOT IN ('CANCELLED', 'DECLINED')
             GROUP BY o.id`,
            [session.session_id]
        );

        const orders = ordersRes.rows;
        const grandTotal = orders.reduce((sum, o) => sum + parseFloat(o.total_amount || 0), 0);

        return res.status(200).json({
            success: true,
            data: {
                session,
                orders,
                grand_total: Number(grandTotal.toFixed(2))
            },
            message: 'Bill breakdown retrieved successfully.'
        });
    } catch (error) {
        console.error('Request bill error:', error.message);
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error.'
        });
    }
};

module.exports = {
    getBasket,
    addBasketItem,
    removeBasketItem,
    createOrder,
    getOrders,
    getActiveOrdersByTable,
    getUnfinishedOrders,
    updateOrderStatus,
    processOrderPayment,
    getDailySalesReport,
    getBillByTable,
    cancelOrder,
    cancelTableSession,
    requestBill
};