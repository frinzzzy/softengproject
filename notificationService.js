const pool = require('./db');
const { getMessaging } = require('firebase-admin/messaging');
const { firebaseApp } = require('./firebaseAdmin');

const STATUS_NOTIFICATION_MESSAGES = {
    PREPARING: { title: 'Order is being prepared!', body: 'The kitchen started preparing your order.' },
    READY: { title: 'Your order is READY!', body: 'Please proceed to pickup.' },
    SERVED: { title: 'Order served', body: 'Your order has been served. Enjoy!' },
    COMPLETED: { title: 'Order completed', body: 'Thank you for dining with us!' },
    PAID: { title: 'Payment received', body: 'Your order has been paid. Thank you!' },
    CANCELLED: { title: 'Order cancelled', body: 'Your order was cancelled.' },
    DECLINED: { title: 'Order declined', body: 'Please ask the staff for details.' }
};

const isFcmConfigured = () => Boolean(firebaseApp);

const registerFcmToken = async (req, res) => {
    const sessionId = Number(req.params.session_id);
    const token = req.body?.fcm_token;

    if (typeof token !== 'string' || !token.trim() || token.trim().length > 4096) {
        return res.status(400).json({ success: false, message: 'A valid fcm_token is required.' });
    }

    try {
        await pool.query(
            `INSERT INTO customer_fcm_tokens (session_id, token)
             VALUES ($1::int, $2)
             ON CONFLICT (session_id, token)
             DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
            [sessionId, token.trim()]
        );
        return res.status(200).json({ success: true, session_id: sessionId });
    } catch (error) {
        console.error('[FCM] Token registration failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to register FCM token.' });
    }
};

const sendOrderStatusNotification = async ({ session_id, table_id, order_id, status }) => {
    if (!firebaseApp) return { sent: 0, failed: 0, skipped: true, reason: 'not_configured' };
    if (!session_id) return { sent: 0, failed: 0, skipped: true, reason: 'no_session' };

    const normalizedStatus = String(status || '').toUpperCase();
    const message = STATUS_NOTIFICATION_MESSAGES[normalizedStatus] || {
        title: `Order #${order_id} update`,
        body: 'There is an update on your order.'
    };
    const { rows } = await pool.query(
        'SELECT token FROM customer_fcm_tokens WHERE session_id = $1::int AND token IS NOT NULL',
        [session_id]
    );
    const tokens = [...new Set((rows || []).map((row) => row.token).filter(Boolean))];
    if (tokens.length === 0) return { sent: 0, failed: 0, skipped: true, reason: 'no_tokens' };

    const messaging = getMessaging(firebaseApp);
    const invalidTokens = [];
    let sent = 0;
    let failed = 0;

    for (let start = 0; start < tokens.length; start += 500) {
        const batch = tokens.slice(start, start + 500);
        const response = await messaging.sendEachForMulticast({
            tokens: batch,
            notification: message,
            data: {
                order_id: String(order_id ?? ''),
                session_id: String(session_id ?? ''),
                table_id: String(table_id ?? ''),
                status: normalizedStatus
            }
        });

        sent += response.successCount;
        failed += response.failureCount;
        response.responses.forEach((result, index) => {
            if (result.error?.code === 'messaging/registration-token-not-registered') {
                invalidTokens.push(batch[index]);
            }
        });
    }

    if (invalidTokens.length > 0) {
        await pool.query(
            'DELETE FROM customer_fcm_tokens WHERE session_id = $1::int AND token = ANY($2::text[])',
            [session_id, invalidTokens]
        );
    }

    return { sent, failed };
};

module.exports = { isFcmConfigured, registerFcmToken, sendOrderStatusNotification };
