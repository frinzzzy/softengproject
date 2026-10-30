const pool = require('./db');
const crypto = require('crypto');

const logApiResponse = (endpoint, details) => {
    if (process.env.DEBUG_API_RESPONSES === 'true') {
        console.log(`[API Debug] ${endpoint}`, details);
    }
};

function computeStatutoryDiscount(grossAmount, isEligible) {
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
}

const createOrder = async (req, res) => {
    const {
        table_id,
        session_id,
        parent_order_id,
        is_additional_order,
        items,
        client_order_id
    } = req.body || {};

    const tableId = Number(table_id);
    const sessionId = session_id == null ? null : Number(session_id);
    const parentOrderId = parent_order_id == null ? null : Number(parent_order_id);
    const isAdditional = is_additional_order === true;

    if (!Number.isSafeInteger(tableId) || tableId <= 0 ||
        (sessionId !== null && (!Number.isSafeInteger(sessionId) || sessionId <= 0))) {
        return res.status(400).json({
            success: false,
            message: 'A valid table_id and session_id are required.'
        });
    }

    if (is_additional_order != null && typeof is_additional_order !== 'boolean') {
        return res.status(400).json({
            success: false,
            message: 'is_additional_order must be a boolean.'
        });
    }

    if ((isAdditional && (!Number.isSafeInteger(parentOrderId) || parentOrderId <= 0)) ||
        (!isAdditional && parentOrderId !== null)) {
        return res.status(400).json({
            success: false,
            message: 'A valid parent_order_id is required only for an additional order.'
        });
    }

    if (!Array.isArray(items) || items.length === 0 || items.some(item =>
        !item ||
        !Number.isSafeInteger(Number(item.menu_item_id)) ||
        Number(item.menu_item_id) <= 0 ||
        !Number.isSafeInteger(Number(item.quantity)) ||
        Number(item.quantity) <= 0 ||
        (item.addons != null && !Array.isArray(item.addons)) ||
        (Array.isArray(item.addons) && item.addons.some(addon =>
            !addon ||
            !Number.isSafeInteger(Number(addon.addon_id)) ||
            Number(addon.addon_id) <= 0
        ))
    )) {
        return res.status(400).json({
            success: false,
            message: 'Order items must have valid menu_item_id values, positive quantities, and valid add-ons.'
        });
    }

    const idempotencyKey = req.headers['x-idempotency-key'] || client_order_id;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
        return res.status(400).json({
            success: false,
            message: 'An x-idempotency-key header or client_order_id is required.'
        });
    }

    const trimmedIdempotencyKey = idempotencyKey.trim();
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let clientOrderId = trimmedIdempotencyKey;
    if (!uuidPattern.test(clientOrderId)) {
        const bytes = crypto.createHash('sha256').update(clientOrderId).digest().subarray(0, 16);
        bytes[6] = (bytes[6] & 0x0f) | 0x50;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        clientOrderId = [
            bytes.subarray(0, 4).toString('hex'),
            bytes.subarray(4, 6).toString('hex'),
            bytes.subarray(6, 8).toString('hex'),
            bytes.subarray(8, 10).toString('hex'),
            bytes.subarray(10, 16).toString('hex')
        ].join('-');
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const tableResult = await client.query(
            'SELECT id FROM tables WHERE id = $1::int FOR UPDATE',
            [tableId]
        );

        if (tableResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Table not found.' });
        }

        const existingOrder = await client.query(
            `SELECT o.*
             FROM orders o
             WHERE o.client_order_id = $1::uuid
             UNION ALL
             SELECT o.*
             FROM order_submissions os
             JOIN orders o ON o.id = os.order_id
             WHERE os.client_order_id = $1::uuid
             LIMIT 1`,
            [clientOrderId]
        );

        if (existingOrder.rows.length > 0) {
            await client.query('COMMIT');
            return res.status(200).json({
                success: true,
                message: 'Order replay handled.',
                data: { order: existingOrder.rows[0] }
            });
        }

        let targetSessionId = sessionId;
        if (targetSessionId !== null) {
            const sessionRes = await client.query(
                `SELECT id
                 FROM table_sessions
                 WHERE id = $1::int
                   AND table_id = $2::int
                 FOR UPDATE`,
                [targetSessionId, tableId]
            );

            if (sessionRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'The requested table session does not belong to this table.'
                });
            }

            const activeSessionRes = await client.query(
                `SELECT id
                 FROM table_sessions
                 WHERE table_id = $1::int
                   AND id <> $2::int
                   AND UPPER(session_status) IN ('ACTIVE', 'OPEN')
                 LIMIT 1
                 FOR UPDATE`,
                [tableId, targetSessionId]
            );

            if (activeSessionRes.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    success: false,
                    message: 'Another active session already exists for this table.'
                });
            }

            await client.query(
                `UPDATE table_sessions
                 SET session_status = 'ACTIVE',
                     closed_at = NULL,
                     last_active_at = CURRENT_TIMESTAMP,
                     bill_requested_at = NULL
                 WHERE id = $1::int
                   AND table_id = $2::int
                   AND UPPER(session_status) NOT IN ('ACTIVE', 'OPEN')`,
                [targetSessionId, tableId]
            );
        } else {
            const sessionRes = await client.query(
                `SELECT id
                 FROM table_sessions
                 WHERE table_id = $1::int
                   AND UPPER(session_status) IN ('ACTIVE', 'OPEN')
                 ORDER BY id DESC
                 LIMIT 1
                 FOR UPDATE`,
                [tableId]
            );

            if (sessionRes.rows.length === 0) {
                const newSession = await client.query(
                    `INSERT INTO table_sessions (table_id, session_status)
                     VALUES ($1::int, 'ACTIVE')
                     RETURNING id`,
                    [tableId]
                );
                targetSessionId = newSession.rows[0].id;
            } else {
                targetSessionId = sessionRes.rows[0].id;
            }
        }

        let additionalTotalCents = 0;
        const verifiedItems = [];

        for (const item of items) {
            const menuRes = await client.query(
                'SELECT id, name, price, is_available, stock_quantity FROM menu_items WHERE id = $1::int FOR UPDATE',
                [Number(item.menu_item_id)]
            );

            if (menuRes.rows.length === 0) {
                throw Object.assign(new Error(`Menu item #${item.menu_item_id} not found.`), { statusCode: 400 });
            }

            const menuItem = menuRes.rows[0];
            if (!menuItem.is_available) {
                throw Object.assign(new Error(`Menu item #${item.menu_item_id} is unavailable.`), { statusCode: 400 });
            }

            const qty = Number(item.quantity);
            const currentStock = menuItem.stock_quantity ?? 50;

            if (currentStock < qty) {
                throw Object.assign(new Error(`Insufficient stock for ${menuItem.name}. Only ${currentStock} left.`), { statusCode: 400 });
            }

            const unitPrice = parseFloat(menuItem.price);
            const unitPriceCents = Math.round(unitPrice * 100);
            additionalTotalCents += unitPriceCents * qty;

            const verifiedAddons = [];
            for (const addon of item.addons || []) {
                const addonId = Number(addon.addon_id);
                const addonRes = await client.query(
                    `SELECT price
                     FROM menu_addons
                     WHERE id = $1::int AND menu_item_id = $2::int`,
                    [addonId, menuItem.id]
                );

                if (addonRes.rows.length === 0) {
                    throw Object.assign(
                        new Error(`Add-on #${addonId} is invalid for menu item #${menuItem.id}.`),
                        { statusCode: 400 }
                    );
                }

                const addonPrice = parseFloat(addonRes.rows[0].price);
                additionalTotalCents += Math.round(addonPrice * 100) * qty;
                verifiedAddons.push({
                    addon_id: addonId,
                    price: addonPrice
                });
            }

            verifiedItems.push({
                menu_item_id: menuItem.id,
                item_name: menuItem.name,
                name: menuItem.name,
                quantity: qty,
                unit_price: unitPrice,
                current_stock: currentStock,
                addons: verifiedAddons
            });
        }

        const additionalTotal = (additionalTotalCents / 100).toFixed(2);

        let targetOrder;
        if (isAdditional) {
            const parentCheck = await client.query(
                `SELECT *
                 FROM orders
                 WHERE id = $1::int
                   AND session_id = $2::int
                   AND table_id = $3::int
                   AND (order_status IN ('PENDING', 'PREPARING', 'READY', 'SERVED', 'NEW') AND order_status NOT IN ('CANCELLED', 'DECLINED', 'COMPLETED'))
                 FOR UPDATE`,
                [parentOrderId, targetSessionId, tableId]
            );

            if (parentCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Active parent order not found for this table session.'
                });
            }

            const parentStatus = parentCheck.rows[0].order_status;

            if (parentStatus === 'PENDING' || parentStatus === 'NEW') {
                const parentRes = await client.query(
                    `UPDATE orders
                     SET total_amount = total_amount + $1::numeric,
                         is_additional_order = TRUE
                     WHERE id = $2::int
                     RETURNING *`,
                    [additionalTotal, parentOrderId]
                );
                targetOrder = parentRes.rows[0];
            } else {
                const additionalOrderRes = await client.query(
                    `INSERT INTO orders (session_id, table_id, parent_order_id, is_additional_order, client_order_id, total_amount, order_status)
                     VALUES ($1::int, $2::int, $3::int, TRUE, $4::uuid, $5::numeric, 'PENDING')
                     RETURNING *`,
                    [
                        targetSessionId,
                        tableId,
                        parentOrderId,
                        crypto.randomUUID(),
                        additionalTotal
                    ]
                );
                targetOrder = additionalOrderRes.rows[0];
            }
        } else {
            const newOrderRes = await client.query(
                `INSERT INTO orders (session_id, table_id, parent_order_id, is_additional_order, client_order_id, total_amount, order_status)
                 VALUES ($1::int, $2::int, NULL, FALSE, $3::uuid, $4::numeric, 'PENDING')
                 RETURNING *`,
                [
                    targetSessionId,
                    tableId,
                    clientOrderId,
                    additionalTotal
                ]
            );
            targetOrder = newOrderRes.rows[0];
        }

        for (const vItem of verifiedItems) {
            const orderItem = await client.query(
                `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price)
                 VALUES ($1::int, $2::int, $3::int, $4::numeric)
                 RETURNING id`,
                [targetOrder.id, vItem.menu_item_id, vItem.quantity, vItem.unit_price]
            );

            for (const addon of vItem.addons) {
                await client.query(
                    `INSERT INTO order_item_addons (order_item_id, addon_id, price)
                     VALUES ($1::int, $2::int, $3::numeric)`,
                    [orderItem.rows[0].id, addon.addon_id, addon.price]
                );
            }

            const newStock = vItem.current_stock - vItem.quantity;
            const makeUnavailable = newStock > 0;

            await client.query(
                `UPDATE menu_items 
                 SET stock_quantity = $1::int, is_available = $2::boolean 
                 WHERE id = $3::int`,
                [newStock, makeUnavailable, vItem.menu_item_id]
            );

            await client.query(
                `INSERT INTO inventory_logs (menu_item_id, previous_quantity, new_quantity, adjustment_type, notes)
                 VALUES ($1::int, $2::int, $3::int, 'ORDER_DEDUCTION', $4)`,
                [vItem.menu_item_id, vItem.current_stock, newStock, `Deducted for Order #${targetOrder.id}`]
            );
        }

        if (isAdditional) {
            await client.query(
                `INSERT INTO order_submissions (client_order_id, order_id)
                 VALUES ($1::uuid, $2::int)`,
                [clientOrderId, targetOrder.id]
            );
        }

        await client.query(
            'UPDATE table_sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = $1::int',
            [targetSessionId]
        );

        await client.query('COMMIT');

        const io = req.app.get('io');
        if (io) {
            const updatePayload = {
                order_id: targetOrder.id,
                session_id: targetOrder.session_id,
                table_id: targetOrder.table_id,
                status: targetOrder.order_status,
                total_amount: targetOrder.total_amount,
                items: verifiedItems,
                added_items: isAdditional ? verifiedItems : [],
                is_additional_order: isAdditional,
                message: `Order #${targetOrder.id} updated for Table #${targetOrder.table_id}`
            };
            io.emit('order_updated', updatePayload);
            io.emit('stock_updated', updatePayload);
            if (isAdditional) {
                io.emit('additional_items_added', updatePayload);
            }
        }

        return res.status(201).json({
            success: true,
            message: isAdditional ? 'Additional items added to the parent order.' : 'New order created.',
            data: {
                order: targetOrder,
                added_items: verifiedItems
            }
        });

    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Order creation rollback error:', rollbackError.message);
        }
        console.error('Order creation error:', error.message);
        const statusCode = error.statusCode === 400 ? 400 : 500;
        return res.status(statusCode).json({
            success: false,
            message: statusCode === 400 ? error.message : 'Failed to create order.'
        });
    } finally {
        client.release();
    }
};

const getOrderById = async (req, res) => {
    try {
        const rawId = req.params.id;
        if (!rawId) {
            return res.status(400).json({ success: false, message: 'Order ID is required.' });
        }

        const cleanIdStr = rawId.toString().replace('#BS-', '').trim();
        const numericId = parseInt(cleanIdStr, 10);
        const validNumericId = !isNaN(numericId) ? numericId : 0;

        let query = `
            SELECT 
                o.id AS order_id,
                o.id,
                o.session_id,
                o.table_id,
                o.parent_order_id,
                CASE
                    WHEN COALESCE(o.is_additional_order, FALSE) OR o.parent_order_id IS NOT NULL
                    THEN 'ADDITIONAL'
                    ELSE 'NEW'
                END AS order_type,
                COALESCE(t.table_number, o.table_id) AS table_number,
                o.total_amount,
                o.total_amount AS grand_total,
                o.order_status,
                o.decline_reason,
                o.created_at,
                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'id', oi.id,
                            'item_id', oi.menu_item_id,
                            'menu_item_id', oi.menu_item_id,
                            'name', COALESCE(m.name, 'Item #' || oi.menu_item_id),
                            'item_name', COALESCE(m.name, 'Item #' || oi.menu_item_id),
                            'quantity', oi.quantity,
                            'unit_price', oi.unit_price,
                            'price', oi.unit_price,
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
            WHERE o.id = $1::int OR o.client_order_id::text = $2
            GROUP BY o.id, t.table_number;
        `;

        const { rows } = await pool.query(query, [validNumericId, rawId]);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Order not found.' });
        }

        return res.status(200).json({
            success: true,
            data: rows[0],
            order: rows[0]
        });
    } catch (error) {
        console.error('Fetch order by ID error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch order details.' });
    }
};

const getUnfinishedOrders = async (req, res) => {
    const { table_id } = req.query;
    if (!table_id) {
        return res.status(400).json({ success: false, message: 'table_id is required.' });
    }

    try {
        const query = `
            SELECT 
                o.id AS order_id,
                o.id,
                o.session_id,
                o.table_id,
                COALESCE(t.table_number, o.table_id) AS table_number,
                o.total_amount,
                o.order_status,
                o.created_at,
                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'id', oi.id,
                            'item_id', oi.menu_item_id,
                            'name', COALESCE(m.name, 'Item #' || oi.menu_item_id),
                            'item_name', COALESCE(m.name, 'Item #' || oi.menu_item_id),
                            'quantity', oi.quantity,
                            'unit_price', oi.unit_price
                        )
                    ) FILTER (WHERE oi.id IS NOT NULL), '[]'::json
                ) AS items
            FROM orders o
            LEFT JOIN tables t ON o.table_id = t.id
            LEFT JOIN order_items oi ON o.id = oi.order_id
            LEFT JOIN menu_items m ON oi.menu_item_id = m.id
            WHERE (o.table_id = $1 OR t.table_number = $1)
              AND o.order_status IN ('PENDING', 'PREPARING', 'READY', 'SERVED', 'NEW')
              AND o.order_status NOT IN ('CANCELLED', 'DECLINED', 'COMPLETED')
            GROUP BY o.id, t.table_number
            ORDER BY o.created_at DESC;
        `;

        const { rows } = await pool.query(query, [Number(table_id)]);

        return res.status(200).json({
            success: true,
            count: rows.length,
            orders: rows,
            data: rows
        });
    } catch (error) {
        console.error('Fetch unfinished orders error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch unfinished orders.' });
    }
};

const getTableSessionBill = async (req, res) => {
    const tableId = Number(req.params.table_id);

    if (!Number.isSafeInteger(tableId) || tableId <= 0) {
        return res.status(400).json({
            success: false,
            message: 'A valid table_id is required.'
        });
    }

    try {
        const query = `
            SELECT
                ts.id AS session_id,
                t.id AS table_id,
                t.table_number,
                COALESCE(ts.session_status, 'ACTIVE') AS session_status,
                COALESCE(ts.bill_requested_at, NULL) AS bill_requested_at,
                COALESCE(SUM(o.total_amount), 0) AS grand_total,
                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'order_id', o.id,
                            'order_code', '#BS-' || o.id,
                            'status', o.order_status,
                            'order_total', o.total_amount,
                            'time', TO_CHAR(o.created_at, 'HH12:MI AM - Mon DD'),
                            'items', COALESCE(
                                (
                                    SELECT JSON_AGG(
                                        JSON_BUILD_OBJECT(
                                            'name', COALESCE(m.name, 'Item #' || oi.menu_item_id),
                                            'item_name', COALESCE(m.name, 'Item #' || oi.menu_item_id),
                                            'quantity', oi.quantity,
                                            'unit_price', oi.unit_price,
                                            'price', (oi.unit_price + COALESCE(
                                                (
                                                    SELECT SUM(oia.price)
                                                    FROM order_item_addons oia
                                                    WHERE oia.order_item_id = oi.id
                                                ), 0
                                            )) * oi.quantity,
                                            'addons', COALESCE(
                                                (
                                                    SELECT JSON_AGG(
                                                        JSON_BUILD_OBJECT(
                                                            'addon_id', oia.addon_id,
                                                            'name', ma.name,
                                                            'price', oia.price
                                                        )
                                                        ORDER BY oia.id
                                                    )
                                                    FROM order_item_addons oia
                                                    JOIN menu_addons ma ON ma.id = oia.addon_id
                                                    WHERE oia.order_item_id = oi.id
                                                ), '[]'::json
                                            )
                                        )
                                    )
                                    FROM order_items oi
                                    LEFT JOIN menu_items m ON m.id = oi.menu_item_id
                                    WHERE oi.order_id = o.id
                                ),
                                '[]'::json
                            )
                        )
                        ORDER BY o.created_at DESC
                    ) FILTER (WHERE o.id IS NOT NULL),
                    '[]'::json
                ) AS orders
            FROM tables t
            LEFT JOIN table_sessions ts
                ON ts.table_id = t.id
               AND UPPER(ts.session_status) IN ('ACTIVE', 'OPEN')
            LEFT JOIN orders o
                ON o.session_id = ts.id
               AND (o.order_status IN ('PENDING', 'PREPARING', 'READY', 'SERVED', 'NEW') AND o.order_status NOT IN ('CANCELLED', 'DECLINED', 'COMPLETED'))
            WHERE t.id = $1::int OR t.table_number = $1::int
            GROUP BY ts.id, ts.session_status, ts.bill_requested_at, t.id, t.table_number;
        `;

        const { rows } = await pool.query(query, [tableId]);

        if (rows.length === 0) {
            return res.status(200).json({
                success: true,
                data: {
                    table_id: tableId,
                    table_number: tableId,
                    grand_total: 0,
                    orders: [],
                    bill_requested_at: null,
                    bill_requested: false
                }
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                ...rows[0],
                bill_requested: rows[0].bill_requested_at != null
            }
        });
    } catch (error) {
        console.error('Fetch table session bill error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch table session bill.'
        });
    }
};

const getOrders = async (req, res) => {
    try {
        const { table_id, session_id, status, all } = req.query;

        let query = `
            SELECT 
                o.id AS order_id,
                o.id,
                o.session_id,
                o.table_id,
                o.parent_order_id,
                CASE
                    WHEN COALESCE(o.is_additional_order, FALSE) OR o.parent_order_id IS NOT NULL
                    THEN 'ADDITIONAL'
                    ELSE 'NEW'
                END AS order_type,
                COALESCE(t.table_number, o.table_id) AS table_number,
                o.total_amount,
                o.total_amount AS grand_total,
                o.order_status,
                o.created_at,
                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'id', oi.id,
                            'item_id', oi.menu_item_id,
                            'menu_item_id', oi.menu_item_id,
                            'name', COALESCE(m.name, 'Item #' || oi.menu_item_id),
                            'item_name', COALESCE(m.name, 'Item #' || oi.menu_item_id),
                            'quantity', oi.quantity,
                            'unit_price', oi.unit_price,
                            'price', oi.unit_price,
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
                ) AS items,
                ts.bill_requested_at AS bill_requested_at
            FROM orders o
            LEFT JOIN tables t ON o.table_id = t.id
            LEFT JOIN table_sessions ts ON o.session_id = ts.id
            LEFT JOIN order_items oi ON o.id = oi.order_id
            LEFT JOIN menu_items m ON oi.menu_item_id = m.id
        `;

        const conditions = [];
        const values = [];

        if (table_id) {
            values.push(Number(table_id));
            conditions.push(`(o.table_id = $${values.length}::int OR t.table_number = $${values.length}::int)`);
        }

        if (session_id) {
            values.push(Number(session_id));
            conditions.push(`o.session_id = $${values.length}::int`);
        }

        if (status) {
            values.push(status.toUpperCase());
            conditions.push(`UPPER(o.order_status) = $${values.length}`);
        } else if (!all && !table_id && !session_id) {
            conditions.push(`o.order_status NOT IN ('CANCELLED', 'DECLINED', 'COMPLETED')`);
        }

        if (conditions.length > 0) {
            query += ` WHERE ` + conditions.join(' AND ');
        }

        query += ` GROUP BY o.id, t.table_number, ts.bill_requested_at ORDER BY o.created_at DESC;`;

        const { rows } = await pool.query(query, values);

        return res.status(200).json({
            success: true,
            count: rows.length,
            data: rows,
            message: 'Orders retrieved successfully.'
        });
    } catch (error) {
        console.error('Fetch orders error:', error.message);
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error.'
        });
    }
};

const getCustomerLiveOrders = async (req, res) => {
    try {
        const { table_id, session_id, order_id } = req.query;

        if (!table_id && !session_id && !order_id) {
            return res.status(400).json({
                success: false,
                message: 'At least table_id, session_id, or order_id is required.'
            });
        }

        let query = `
            SELECT 
                o.id AS order_id,
                o.id,
                o.session_id,
                o.table_id,
                o.parent_order_id,
                CASE
                    WHEN COALESCE(o.is_additional_order, FALSE) OR o.parent_order_id IS NOT NULL
                    THEN 'ADDITIONAL'
                    ELSE 'NEW'
                END AS order_type,
                COALESCE(t.table_number, o.table_id) AS table_number,
                o.total_amount,
                o.total_amount AS grand_total,
                o.order_status,
                o.created_at,
                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'id', oi.id,
                            'item_id', oi.menu_item_id,
                            'menu_item_id', oi.menu_item_id,
                            'name', COALESCE(m.name, 'Item #' || oi.menu_item_id),
                            'item_name', COALESCE(m.name, 'Item #' || oi.menu_item_id),
                            'quantity', oi.quantity,
                            'unit_price', oi.unit_price,
                            'price', oi.unit_price,
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
        `;

        const conditions = [];
        const values = [];

        if (table_id) {
            values.push(Number(table_id));
            conditions.push(`(o.table_id = $${values.length}::int OR t.table_number = $${values.length}::int)`);
        }

        if (session_id) {
            values.push(Number(session_id));
            conditions.push(`o.session_id = $${values.length}::int`);
        }

        if (order_id) {
            values.push(Number(order_id));
            conditions.push(`o.id = $${values.length}::int`);
        }

        conditions.push(`o.order_status NOT IN ('CANCELLED', 'DECLINED', 'COMPLETED')`);

        if (conditions.length > 0) {
            query += ` WHERE ` + conditions.join(' AND ');
        }

        query += ` GROUP BY o.id, t.table_number ORDER BY o.created_at DESC;`;

        const { rows } = await pool.query(query, values);

        return res.status(200).json({
            success: true,
            count: rows.length,
            data: rows,
            message: 'Customer live orders retrieved successfully.'
        });
    } catch (error) {
        console.error('Fetch customer live orders error:', error.message);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch customer live orders.'
        });
    }
};

const getSessionOrder = async (req, res) => {
    const sessionId = Number(req.params.session_id);
    const orderId = Number(req.params.order_id);

    if (!Number.isSafeInteger(sessionId) || sessionId <= 0 ||
        !Number.isSafeInteger(orderId) || orderId <= 0) {
        return res.status(400).json({
            success: false,
            message: 'Valid session_id and order_id are required.'
        });
    }

    try {
        const { rows } = await pool.query(
            `SELECT
                o.id AS order_id,
                o.session_id,
                o.table_id,
                o.parent_order_id,
                o.total_amount,
                o.order_status,
                o.created_at,
                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'id', oi.id,
                            'menu_item_id', oi.menu_item_id,
                            'quantity', oi.quantity,
                            'unit_price', oi.unit_price,
                            'name', COALESCE(m.name, 'Item #' || oi.menu_item_id),
                            'item_name', COALESCE(m.name, 'Item #' || oi.menu_item_id),
                            'addons', COALESCE(
                                (
                                    SELECT JSON_AGG(
                                        JSON_BUILD_OBJECT(
                                            'addon_id', oia.addon_id,
                                            'name', ma.name,
                                            'price', oia.price
                                        )
                                        ORDER BY oia.addon_id
                                    )
                                    FROM order_item_addons oia
                                    JOIN menu_addons ma ON ma.id = oia.addon_id
                                    WHERE oia.order_item_id = oi.id
                                ),
                                '[]'::json
                            )
                        )
                        ORDER BY oi.id
                    ) FILTER (WHERE oi.id IS NOT NULL),
                    '[]'::json
                ) AS items
             FROM orders o
             JOIN table_sessions ts
               ON ts.id = o.session_id
              AND UPPER(ts.session_status) IN ('ACTIVE', 'OPEN')
             LEFT JOIN order_items oi ON oi.order_id = o.id
             LEFT JOIN menu_items m ON m.id = oi.menu_item_id
             WHERE o.id = $1::int
               AND o.session_id = $2::int
             GROUP BY o.id`,
            [orderId, sessionId]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Active order not found for this table session.'
            });
        }

        return res.status(200).json({
            success: true,
            data: rows[0]
        });
    } catch (error) {
        console.error('Fetch session order error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch order.'
        });
    }
};

const getSessionOrdersSummary = async (req, res) => {
    const sessionId = Number(req.params.session_id);
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json({
            success: false,
            message: 'A valid session_id is required.'
        });
    }

    try {
        const { rows } = await pool.query(
            `SELECT
                o.id AS order_id,
                CASE
                    WHEN COALESCE(o.is_additional_order, FALSE) OR o.parent_order_id IS NOT NULL
                    THEN 'ADDITIONAL'
                    ELSE 'NEW'
                END AS order_type,
                o.order_status,
                o.total_amount,
                o.total_amount AS grand_total,
                o.created_at,
                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'item_id', oi.id,
                            'menu_item_id', oi.menu_item_id,
                            'name', COALESCE(mi.name, 'Item #' || oi.menu_item_id),
                            'item_name', COALESCE(mi.name, 'Item #' || oi.menu_item_id),
                            'quantity', oi.quantity,
                            'unit_price', oi.unit_price,
                            'item_status', o.order_status,
                            'addons', COALESCE(
                                (
                                    SELECT JSON_AGG(
                                        JSON_BUILD_OBJECT(
                                            'addon_id', oia.addon_id,
                                            'name', ma.name,
                                            'price', oia.price
                                        )
                                        ORDER BY oia.id
                                    )
                                    FROM order_item_addons oia
                                    JOIN menu_addons ma ON ma.id = oia.addon_id
                                    WHERE oia.order_item_id = oi.id
                                ), '[]'::json
                            )
                        )
                        ORDER BY oi.id
                    ) FILTER (WHERE oi.id IS NOT NULL),
                    '[]'::json
                ) AS items
             FROM orders o
             LEFT JOIN order_items oi ON oi.order_id = o.id
             LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
             WHERE o.session_id = $1::int
               AND o.order_status NOT IN ('COMPLETED', 'CANCELLED', 'DECLINED')
             GROUP BY o.id
             ORDER BY o.created_at ASC`,
            [sessionId]
        );

        return res.status(200).json({
            success: true,
            count: rows.length,
            orders: rows
        });
    } catch (error) {
        console.error('Fetch session orders summary error:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch orders summary.'
        });
    }
};

const updateOrderStatus = async (req, res) => {
    const { id } = req.params;
    const { status, decline_reason } = req.body;

    const validStatuses = [
        'PENDING', 'PREPARING', 'READY', 'SERVED',
        'COMPLETED', 'PAID', 'CANCELLED', 'DECLINED'
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

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const checkResult = await client.query(
            'SELECT id, table_id, order_status, decline_reason FROM orders WHERE id = $1::int FOR UPDATE',
            [id]
        );

        if (checkResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Order not found.'
            });
        }

        const previousStatus = checkResult.rows[0].order_status;

        const shouldRestock = formattedStatus === 'DECLINED'
            && previousStatus !== 'DECLINED'
            && previousStatus !== 'CANCELLED';

        if (shouldRestock) {
            const itemsResult = await client.query(
                'SELECT menu_item_id, quantity FROM order_items WHERE order_id = $1::int',
                [id]
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
                         VALUES ($1::int, $2::int, $3::int, 'MANUAL_ADJUSTMENT', $4)`,
                        [item.menu_item_id, prevStock, newStock, `Restocked due to Decline of Order #${id}`]
                    );
                }
            }
        }

        const updateQuery = `
            UPDATE orders 
            SET order_status = $1,
                decline_reason = $2
            WHERE id = $3::int
            RETURNING id, table_id, order_status, decline_reason, total_amount, created_at;
        `;

        const { rows } = await client.query(updateQuery, [
            formattedStatus,
            formattedStatus === 'DECLINED' ? decline_reason.trim() : null,
            id
        ]);

        const updatedOrder = rows[0];

        await client.query('COMMIT');

        const io = req.app.get('io');
        if (io) {
            io.emit('order_status_updated', {
                order_id: updatedOrder.id,
                table_id: updatedOrder.table_id,
                status: updatedOrder.order_status,
                decline_reason: updatedOrder.decline_reason,
                message: `Order #${updatedOrder.id} status is now ${updatedOrder.order_status}`
            });

            if (shouldRestock) {
                io.emit('stock_updated', {
                    order_id: updatedOrder.id,
                    message: `Stocks refilled after Order #${updatedOrder.id} was declined.`
                });
            }
        }

        return res.status(200).json({
            success: true,
            message: `Order #${id} status updated to ${formattedStatus}.`,
            data: updatedOrder
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Update status error:', error.message);
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error.'
        });
    } finally {
        client.release();
    }
};

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

        const orderContextRes = await client.query(
            'SELECT table_id, session_id FROM orders WHERE id = $1::int',
            [id]
        );

        if (orderContextRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Order not found.'
            });
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
            [netTotal, id]
        );
        
        if (order.session_id) {
            const remainingOrders = await client.query(
                `SELECT COUNT(*) AS count
                 FROM orders
                 WHERE session_id = $1::int
                   AND id != $2::int
                   AND (order_status IN ('PENDING', 'PREPARING', 'READY', 'SERVED', 'NEW') AND order_status NOT IN ('CANCELLED', 'DECLINED', 'COMPLETED'))`,
                [order.session_id, id]
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

const getDailySalesReport = async (req, res) => {
    try {
        const { period = 'today', start_date, end_date } = req.query;
        let dateCondition = "created_at::date = CURRENT_DATE";
        let groupBy = "TO_CHAR(created_at, 'YYYY-MM-DD')";
        let queryParams = [];

        if (period === 'monthly' && start_date && end_date) {
            dateCondition = "created_at::date BETWEEN $1 AND $2";
            queryParams = [start_date, end_date];
            groupBy = "TO_CHAR(created_at, 'YYYY-MM-DD')";
        } else if (period === 'monthly') {
            dateCondition = "DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)";
            groupBy = "TO_CHAR(created_at, 'YYYY-MM-DD')";
        } else if (period === 'yearly' && start_date && end_date) {
            dateCondition = "created_at::date BETWEEN $1 AND $2";
            queryParams = [start_date, end_date];
            groupBy = "TO_CHAR(created_at, 'YYYY-MM')";
        } else if (period === 'yearly') {
            dateCondition = "DATE_TRUNC('year', created_at) = DATE_TRUNC('year', CURRENT_DATE)";
            groupBy = "TO_CHAR(created_at, 'YYYY-MM')";
        } else if (period === 'custom' && start_date && end_date) {
            dateCondition = "created_at::date BETWEEN $1 AND $2";
            queryParams = [start_date, end_date];
            groupBy = "TO_CHAR(created_at, 'YYYY-MM-DD')";
        }

        const query = `
            SELECT 
                COUNT(id) AS total_transactions,
                COALESCE(SUM(amount_due), 0) AS gross_sales,
                COALESCE(SUM(CASE WHEN payment_method = 'CASH' THEN amount_due ELSE 0 END), 0) AS cash_sales,
                COALESCE(SUM(CASE WHEN payment_method = 'GCASH' THEN amount_due ELSE 0 END), 0) AS gcash_sales
            FROM payments
            WHERE status = 'COMPLETED' 
              AND ${dateCondition};
        `;

        const { rows } = await pool.query(query, queryParams);

        let graphQuery = `
            SELECT 
                ${groupBy} AS label,
                COALESCE(SUM(amount_due), 0) AS total_sales
            FROM payments
            WHERE status = 'COMPLETED' 
              AND ${dateCondition}
            GROUP BY ${groupBy}
            ORDER BY label ASC;
        `;
        let graphRes = await pool.query(graphQuery, queryParams);

        if (graphRes.rows.length === 0 && parseFloat(rows[0].gross_sales) > 0) {
            graphRes.rows = [{
                label: start_date || new Date().toISOString().split('T')[0],
                total_sales: parseFloat(rows[0].gross_sales)
            }];
        }

        const topDishesQuery = `
            SELECT 
                m.name,
                SUM(oi.quantity)::int AS quantity,
                COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric AS revenue
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            JOIN payments p ON p.order_id = o.id
            JOIN menu_items m ON m.id = oi.menu_item_id
            WHERE p.status = 'COMPLETED' 
              AND ${dateCondition.replace(/created_at/g, 'p.created_at')}
            GROUP BY m.id, m.name
            ORDER BY quantity DESC, revenue DESC
            LIMIT 5;
        `;
        
        let topDishesRes;
        try {
            topDishesRes = await pool.query(topDishesQuery, queryParams);
        } catch (err) {
            const fallbackTopQuery = `
                SELECT 
                    m.name,
                    SUM(oi.quantity)::int AS quantity,
                    COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric AS revenue
                FROM order_items oi
                JOIN orders o ON o.id = oi.order_id
                JOIN menu_items m ON m.id = oi.menu_item_id
                WHERE o.order_status = 'COMPLETED'
                GROUP BY m.id, m.name
                ORDER BY quantity DESC, revenue DESC
                LIMIT 5;
            `;
            topDishesRes = await pool.query(fallbackTopQuery);
        }

        return res.status(200).json({
            success: true,
            data: {
                period: period,
                total_transactions: parseInt(rows[0].total_transactions, 10),
                gross_sales: parseFloat(rows[0].gross_sales),
                cash_sales: parseFloat(rows[0].cash_sales),
                gcash_sales: parseFloat(rows[0].gcash_sales),
                chart_breakdown: graphRes.rows,
                top_items: topDishesRes.rows
            },
            message: 'Sales analytics generated successfully.'
        });
    } catch (error) {
        console.error('Sales report error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const cancelOrder = async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const checkResult = await client.query(
            'SELECT id, table_id, order_status FROM orders WHERE id = $1::int FOR UPDATE',
            [id]
        );

        if (checkResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Order not found.'
            });
        }

        const currentStatus = checkResult.rows[0].order_status;

        if (currentStatus !== 'PENDING' && currentStatus !== 'NEW') {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: `Cannot cancel order. Current status is '${currentStatus}'. Only PENDING or NEW orders can be cancelled directly.`
            });
        }

        const itemsResult = await client.query(
            'SELECT menu_item_id, quantity FROM order_items WHERE order_id = $1::int',
            [id]
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
                     VALUES ($1::int, $2::int, $3::int, 'ORDER_CANCELLED_RESTOCK', $4)`,
                    [item.menu_item_id, prevStock, newStock, `Restocked due to Cancellation of Order #${id}`]
                );
            }
        }

        const updateQuery = `
            UPDATE orders 
            SET order_status = 'CANCELLED' 
            WHERE id = $1::int
            RETURNING id, table_id, order_status, total_amount, created_at;
        `;

        const { rows } = await client.query(updateQuery, [id]);
        const cancelledOrder = rows[0];

        await client.query('COMMIT');

        const io = req.app.get('io');
        if (io) {
            io.emit('order_cancelled', {
                order_id: cancelledOrder.id,
                table_id: cancelledOrder.table_id,
                status: cancelledOrder.order_status,
                message: `Order #${cancelledOrder.id} has been cancelled.`
            });

            io.emit('stock_updated', {
                order_id: cancelledOrder.id,
                message: `Stocks refilled after Order #${cancelledOrder.id} cancellation.`
            });
        }

        return res.status(200).json({
            success: true,
            message: `Order #${id} has been successfully cancelled and items were restocked.`,
            data: cancelledOrder
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Cancel order error:', error.message);
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error.'
        });
    } finally {
        client.release();
    }
};

const cancelTableSession = async (req, res) => {
    const { session_id } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const sessionResult = await client.query(
            "SELECT * FROM table_sessions WHERE id = $1::int AND UPPER(session_status) IN ('ACTIVE', 'OPEN')",
            [session_id]
        );

        if (sessionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Active table session not found.'
            });
        }

        const session = sessionResult.rows[0];

        await client.query(
            `UPDATE orders 
             SET order_status = 'CANCELLED' 
             WHERE session_id = $1::int 
               AND (order_status IN ('PENDING', 'PREPARING', 'READY', 'SERVED', 'NEW') AND order_status NOT IN ('CANCELLED', 'DECLINED', 'COMPLETED'))`,
            [session_id]
        );

        const updatedSessionResult = await client.query(
            `UPDATE table_sessions 
             SET session_status = 'CLOSED', 
                 closed_at = CURRENT_TIMESTAMP 
             WHERE id = $1::int
             RETURNING *`,
            [session_id]
        );

        await client.query('COMMIT');

        const io = req.app.get('io');
        if (io) {
            io.emit('session_cancelled', {
                session_id: session.id,
                table_id: session.table_id,
                message: `Table session #${session.id} has been closed and associated active orders cancelled.`
            });
        }

        return res.status(200).json({
            success: true,
            message: `Table session #${session_id} has been successfully closed.`,
            data: updatedSessionResult.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Cancel table session error:', error.message);
        return res.status(500).json({
            success: false,
            message: error.message || 'Internal server error.'
        });
    } finally {
        client.release();
    }
};

const requestBill = async (req, res) => {
    const body = req.body || {};
    const rawSessionId = req.params.session_id ?? body.session_id ?? null;
    const rawTableId = body.table_id ?? null;
    const sessionId = rawSessionId == null ? null : Number(rawSessionId);
    const requestedTableId = rawTableId == null ? null : Number(rawTableId);

    if ((sessionId === null && requestedTableId === null) ||
        (sessionId !== null && (!Number.isSafeInteger(sessionId) || sessionId <= 0)) ||
        (requestedTableId !== null && (!Number.isSafeInteger(requestedTableId) || requestedTableId <= 0))) {
        return res.status(400).json({
            success: false,
            message: 'A valid session_id or table_id is required to request bill.'
        });
    }

    try {
        const activeSessionQuery = sessionId !== null
            ? `SELECT id, table_id
               FROM table_sessions
               WHERE id = $1::int
                 AND UPPER(session_status) IN ('ACTIVE', 'OPEN')
                 ${requestedTableId !== null ? 'AND table_id = $2::int' : ''}`
            : `SELECT id, table_id
               FROM table_sessions
               WHERE table_id = $1::int
                 AND UPPER(session_status) IN ('ACTIVE', 'OPEN')
               ORDER BY id DESC
               LIMIT 1`;

        const params = sessionId !== null
            ? (requestedTableId !== null ? [sessionId, requestedTableId] : [sessionId])
            : [requestedTableId];
        const sessionRes = await pool.query(activeSessionQuery, params);

        if (sessionRes.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No active session found for this session or table.'
            });
        }

        const activeSession = sessionRes.rows[0];
        const tableId = Number(activeSession.table_id);

        // I-update ang table session para ma-record ang bill request activity
        // (session-level state; hindi natin binabago ang core order_status para
        //  hindi masira ang kitchen/cashier workflows)
        await pool.query(
            `UPDATE table_sessions
             SET last_active_at = CURRENT_TIMESTAMP,
                 bill_requested_at = CURRENT_TIMESTAMP
             WHERE id = $1::int
               AND UPPER(session_status) IN ('ACTIVE', 'OPEN')`,
            [activeSession.id]
        );

        const billSummaryQuery = `
            SELECT 
                COUNT(o.id) AS total_orders,
                COALESCE(SUM(o.total_amount), 0) AS grand_total
            FROM orders o
            WHERE o.session_id = $1::int
              AND (o.order_status IN ('PENDING', 'PREPARING', 'READY', 'SERVED', 'NEW') AND o.order_status NOT IN ('CANCELLED', 'DECLINED', 'COMPLETED'));
        `;

        const billSummaryRes = await pool.query(billSummaryQuery, [activeSession.id]);
        const summary = billSummaryRes.rows[0];

        const grandTotal = parseFloat(summary.grand_total);
        const totalOrders = parseInt(summary.total_orders, 10);

        const io = req.app.get('io');
        if (io) {
            io.emit('bill_requested', {
                table_id: tableId,
                session_id: activeSession.id,
                bill_requested_at: new Date().toISOString(),
                bill_status: 'REQUESTED',
                total_orders: totalOrders,
                grand_total: grandTotal,
                requested_at: new Date().toISOString(),
                message: `Table #${tableId} requested bill out. Total: ₱${grandTotal.toFixed(2)}`
            });
        }

        const responseData = {
            table_id: tableId,
            session_id: activeSession.id,
            total_orders: totalOrders,
            grand_total: grandTotal.toFixed(2),
            bill_requested_at: new Date().toISOString(),
            bill_status: 'REQUESTED'
        };

        return res.status(200).json({
            success: true,
            message: `Bill request sent successfully for Table #${tableId}.`,
            data: responseData
        });

    } catch (error) {
        console.error('Request bill error:', error.message);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to process bill request.'
        });
    }
};

const updateItemStock = async (req, res) => {
    const { id } = req.params;
    const { stock_quantity, adjustment_type = 'MANUAL_ADJUSTMENT', notes } = req.body;
    const userId = req.user?.id || null;

    if (stock_quantity === undefined || isNaN(Number(stock_quantity)) || Number(stock_quantity) < 0) {
        return res.status(400).json({
            success: false,
            message: 'A valid non-negative stock_quantity is required.'
        });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const itemRes = await client.query(
            'SELECT id, name, stock_quantity FROM menu_items WHERE id = $1::int FOR UPDATE',
            [id]
        );

        if (itemRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Menu item not found.' });
        }

        const currentItem = itemRes.rows[0];
        const previousQuantity = currentItem.stock_quantity ?? 50;
        const newQuantity = Number(stock_quantity);
        const isAvailable = newQuantity > 0;

        const updateRes = await client.query(
            `UPDATE menu_items 
             SET stock_quantity = $1::int, is_available = $2::boolean 
             WHERE id = $3::int 
             RETURNING id, name, stock_quantity, is_available`,
            [newQuantity, isAvailable, id]
        );

        await client.query(
            `INSERT INTO inventory_logs (menu_item_id, user_id, previous_quantity, new_quantity, adjustment_type, notes)
             VALUES ($1::int, $2::int, $3::int, $4::int, $5, $6)`,
            [id, userId, previousQuantity, newQuantity, adjustment_type.toUpperCase(), notes || null]
        );

        await client.query('COMMIT');

        const io = req.app.get('io');
        if (io) {
            io.emit('stock_updated', {
                item_id: id,
                stock_quantity: newQuantity,
                is_available: isAvailable,
                message: `Stock updated for ${currentItem.name}`
            });
        }

        return res.status(200).json({
            success: true,
            message: `Stock updated successfully for ${currentItem.name}.`,
            data: updateRes.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Update item stock error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to update stock.' });
    } finally {
        client.release();
    }
};

module.exports = {
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
};