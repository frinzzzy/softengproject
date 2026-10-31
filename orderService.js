const pool = require('./db');
const crypto = require('crypto');
const inventoryService = require('./inventoryService');

const updateOrderStatus = async (orderId, status, declineReason) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const checkResult = await client.query(
            'SELECT id, table_id, order_status, decline_reason FROM orders WHERE id = $1::int FOR UPDATE',
            [orderId]
        );

        if (checkResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return { notFound: true };
        }

        const previousStatus = checkResult.rows[0].order_status;

        const shouldRestock = status === 'DECLINED' && previousStatus !== 'DECLINED' && previousStatus !== 'CANCELLED';

        if (shouldRestock) {
            await inventoryService.restockOrderItems(client, orderId, 'MANUAL_ADJUSTMENT', `Restocked due to Decline of Order #${orderId}`);
        }

        const updateQuery = `
            UPDATE orders 
            SET order_status = $1,
                decline_reason = $2
            WHERE id = $3::int
            RETURNING id, table_id, order_status, decline_reason, total_amount, created_at;
        `;

        const { rows } = await client.query(updateQuery, [
            status,
            status === 'DECLINED' ? declineReason.trim() : null,
            orderId
        ]);

        const updatedOrder = rows[0];

        await client.query('COMMIT');

        return { order: updatedOrder, previousStatus, shouldRestock };
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Order status rollback error:', rollbackError.message);
        }
        throw error;
    } finally {
        client.release();
    }
};

const cancelOrder = async (orderId) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const checkResult = await client.query(
            'SELECT id, table_id, order_status FROM orders WHERE id = $1::int FOR UPDATE',
            [orderId]
        );

        if (checkResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return { ok: false, error: 'ORDER_NOT_FOUND', message: 'Order not found.' };
        }

        const currentStatus = checkResult.rows[0].order_status;

        if (currentStatus !== 'PENDING' && currentStatus !== 'NEW') {
            await client.query('ROLLBACK');
            return { ok: false, error: 'INVALID_STATUS', message: `Cannot cancel order. Current status is '${currentStatus}'. Only PENDING or NEW orders can be cancelled directly.` };
        }

        await inventoryService.restockOrderItems(client, orderId, 'ORDER_CANCELLED_RESTOCK', `Restocked due to Cancellation of Order #${orderId}`);

        const updateQuery = `
            UPDATE orders 
            SET order_status = 'CANCELLED' 
            WHERE id = $1::int
            RETURNING id, table_id, order_status, total_amount, created_at;
        `;

        const { rows } = await client.query(updateQuery, [orderId]);
        const cancelledOrder = rows[0];

        await client.query('COMMIT');

        return { ok: true, order: cancelledOrder };
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Cancel order rollback error:', rollbackError.message);
        }
        throw error;
    } finally {
        client.release();
    }
};

const createOrder = async ({
    tableId,
    sessionId,
    parentOrderId,
    isAdditional,
    items,
    clientOrderId,
    idempotencyKey
}) => {
    const finalTableId = Number(tableId);
    const finalSessionId = sessionId == null ? null : Number(sessionId);
    const finalParentOrderId = parentOrderId == null ? null : Number(parentOrderId);
    const finalIsAdditional = isAdditional === true;

    if (!Number.isSafeInteger(finalTableId) || finalTableId <= 0 ||
        (finalSessionId !== null && (!Number.isSafeInteger(finalSessionId) || finalSessionId <= 0))) {
        return { ok: false, error: 'INVALID_REQUEST', message: 'A valid table_id and session_id are required.' };
    }

    if (isAdditional != null && typeof isAdditional !== 'boolean') {
        return { ok: false, error: 'INVALID_REQUEST', message: 'is_additional_order must be a boolean.' };
    }

    if ((finalIsAdditional && (!Number.isSafeInteger(finalParentOrderId) || finalParentOrderId <= 0)) ||
        (!finalIsAdditional && parentOrderId !== null)) {
        return { ok: false, error: 'INVALID_REQUEST', message: 'A valid parent_order_id is required only for an additional order.' };
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
        return { ok: false, error: 'INVALID_REQUEST', message: 'Order items must have valid menu_item_id values, positive quantities, and valid add-ons.' };
    }

    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
        return { ok: false, error: 'INVALID_REQUEST', message: 'An x-idempotency-key header or client_order_id is required.' };
    }

    const trimmedIdempotencyKey = idempotencyKey.trim();
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let finalClientOrderId = trimmedIdempotencyKey;
    if (!uuidPattern.test(finalClientOrderId)) {
        const bytes = crypto.createHash('sha256').update(finalClientOrderId).digest().subarray(0, 16);
        bytes[6] = (bytes[6] & 0x0f) | 0x50;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        finalClientOrderId = [
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
            [finalTableId]
        );

        if (tableResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return { ok: false, error: 'NOT_FOUND', message: 'Table not found.' };
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
            [finalClientOrderId]
        );

        if (existingOrder.rows.length > 0) {
            await client.query('COMMIT');
            return { ok: true, replayed: true, order: existingOrder.rows[0] };
        }

        let targetSessionId = finalSessionId;
        if (targetSessionId !== null) {
            const sessionRes = await client.query(
                `SELECT id
                 FROM table_sessions
                 WHERE id = $1::int
                   AND table_id = $2::int
                 FOR UPDATE`,
                [targetSessionId, finalTableId]
            );

            if (sessionRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return { ok: false, error: 'INVALID_REQUEST', message: 'The requested table session does not belong to this table.' };
            }

            const activeSessionRes = await client.query(
                `SELECT id
                 FROM table_sessions
                 WHERE table_id = $1::int
                   AND id <> $2::int
                   AND UPPER(session_status) IN ('ACTIVE', 'OPEN')
                 LIMIT 1
                 FOR UPDATE`,
                [finalTableId, targetSessionId]
            );

            if (activeSessionRes.rows.length > 0) {
                await client.query('ROLLBACK');
                return { ok: false, error: 'CONFLICT', message: 'Another active session already exists for this table.' };
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
                [targetSessionId, finalTableId]
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
                [finalTableId]
            );

            if (sessionRes.rows.length === 0) {
                const newSession = await client.query(
                    `INSERT INTO table_sessions (table_id, session_status)
                     VALUES ($1::int, 'ACTIVE')
                     RETURNING id`,
                    [finalTableId]
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
        if (finalIsAdditional) {
            const parentCheck = await client.query(
                `SELECT *
                 FROM orders
                 WHERE id = $1::int
                   AND session_id = $2::int
                   AND table_id = $3::int
                   AND (order_status IN ('PENDING', 'PREPARING', 'READY', 'SERVED', 'NEW') AND order_status NOT IN ('CANCELLED', 'DECLINED', 'COMPLETED'))
                 FOR UPDATE`,
                [parentOrderId, targetSessionId, finalTableId]
            );

            if (parentCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                return { ok: false, error: 'NOT_FOUND', message: 'Active parent order not found for this table session.' };
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
                        finalTableId,
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
                    finalTableId,
                    finalClientOrderId,
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
        }

        await inventoryService.deductStock(client, verifiedItems, targetOrder.id);

        if (finalIsAdditional) {
            await client.query(
                `INSERT INTO order_submissions (client_order_id, order_id)
                 VALUES ($1::uuid, $2::int)`,
                [finalClientOrderId, targetOrder.id]
            );
        }

        await client.query(
            'UPDATE table_sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = $1::int',
            [targetSessionId]
        );

        await client.query('COMMIT');

        return { ok: true, isAdditional: finalIsAdditional, order: targetOrder, added_items: verifiedItems };
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Order creation rollback error:', rollbackError.message);
        }
        const statusCode = error.statusCode === 400 ? 400 : 500;
        return { ok: false, error: statusCode === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', statusCode, message: statusCode === 400 ? error.message : 'Failed to create order.' };
    } finally {
        client.release();
    }
};

module.exports = { updateOrderStatus, cancelOrder, createOrder };
