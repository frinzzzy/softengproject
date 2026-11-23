const pool = require('./db');
const { getMessaging } = require('firebase-admin/messaging');
const { firebaseApp } = require('./firebaseAdmin');

const STAFF_TOKEN_TABLE = 'staff_fcm_tokens';
const CUSTOMER_TOKEN_TABLE = 'customer_fcm_tokens';
let staffTokenTableReady = null;
/// Isang device = isang role sa isang pagkakataon. Kapag nag-register ang
/// device bilang customer, tanggalin ang staff/admin row ng parehong FCM
/// token para hindi ito makasagap ng admin alerts habang nasa customer app.
const removeStaffTokenForDevice = async (token) => {
    try {
        await pool.query(
            `DELETE FROM ${STAFF_TOKEN_TABLE} WHERE token = $1`,
            [token]
        );
    } catch (_) {
        // Baka wala pang staff token table (bagong deploy) — safe lang.
    }
};

/// Kabaligtaran: kapag admin/staff ang nag-register, alisin ang customer
/// registration ng parehong token para wala nang customer push sa device na
/// ito habang naka-admin.
const removeCustomerTokenForDevice = async (token) => {
    try {
        await ensureCustomerTokenTable();
        await pool.query(
            `DELETE FROM ${CUSTOMER_TOKEN_TABLE} WHERE token = $1`,
            [token]
        );
    } catch (_) {
        // Best-effort — hindi dapat harangin ang staff registration.
    }
};

/// Self-heal para sa legacy na `customer_fcm_tokens` schema. Sa lumang DB,
/// ang table ay `(customer_id, fcm_token)` — kaya lahat ng customer push
/// registration ay nag-500 at walang customer notification na gumagana.
/// Ginagawa itong `(session_id, token)` schema na inaasahan ng code.
let customerTokenTableReady = null;
const ensureCustomerTokenTable = async () => {
    if (!customerTokenTableReady) {
        customerTokenTableReady = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS ${CUSTOMER_TOKEN_TABLE} (
                    id BIGSERIAL PRIMARY KEY,
                    session_id INT,
                    token TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
            `);

            const { rows } = await pool.query(
                `SELECT
                    BOOL_OR(column_name = 'session_id') AS has_session,
                    BOOL_OR(column_name = 'token') AS has_token,
                    BOOL_OR(column_name = 'fcm_token') AS has_legacy_token,
                    BOOL_OR(column_name = 'customer_id') AS has_customer
                   FROM information_schema.columns
                  WHERE table_schema = current_schema()
                    AND table_name = $1`,
                [CUSTOMER_TOKEN_TABLE]
            );
            const info = rows[0] || {};

            if (info.has_legacy_token && !info.has_token) {
                await pool.query(
                    `ALTER TABLE ${CUSTOMER_TOKEN_TABLE} RENAME COLUMN fcm_token TO token`
                );
            }
            if (!info.has_session) {
                await pool.query(
                    `ALTER TABLE ${CUSTOMER_TOKEN_TABLE} ADD COLUMN IF NOT EXISTS session_id INT`
                );
            }
            if (!info.has_token) {
                await pool.query(
                    `ALTER TABLE ${CUSTOMER_TOKEN_TABLE} ADD COLUMN IF NOT EXISTS token TEXT`
                );
            }
            if (info.has_customer) {
                // Legacy NOT NULL constraint — hindi na ito kailangan.
                await pool.query(
                    `ALTER TABLE ${CUSTOMER_TOKEN_TABLE} ALTER COLUMN customer_id DROP NOT NULL`
                );
                // Ang lumang row na walang session_id ay hindi na magagamit sa
                // session-scoped push. Ligtas itong alisin.
                await pool.query(
                    `DELETE FROM ${CUSTOMER_TOKEN_TABLE} WHERE session_id IS NULL`
                );
            }

            // Legacy unique(token) ay pumipigil sa parehong device sa iba't
            // ibang session. Palitan ng composite unique(session_id, token).
            await pool.query(`
                DO $$
                DECLARE c record;
                BEGIN
                    FOR c IN
                        SELECT conname, pg_get_constraintdef(oid) AS def
                          FROM pg_constraint
                         WHERE conrelid = '${CUSTOMER_TOKEN_TABLE}'::regclass
                           AND contype = 'u'
                    LOOP
                        IF c.def NOT LIKE '%session_id%' THEN
                            EXECUTE format(
                                'ALTER TABLE ${CUSTOMER_TOKEN_TABLE} DROP CONSTRAINT %I',
                                c.conname
                            );
                        END IF;
                    END LOOP;
                END $$;
            `);
            await pool.query(`
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                         WHERE conrelid = '${CUSTOMER_TOKEN_TABLE}'::regclass
                           AND conname = 'uq_customer_fcm_tokens_session_token'
                    ) THEN
                        ALTER TABLE ${CUSTOMER_TOKEN_TABLE}
                            ADD CONSTRAINT uq_customer_fcm_tokens_session_token
                            UNIQUE (session_id, token);
                    END IF;
                END $$;
            `);
            await pool.query(
                `CREATE INDEX IF NOT EXISTS idx_customer_fcm_tokens_session_id
                    ON ${CUSTOMER_TOKEN_TABLE}(session_id)`
            );
            await pool.query(
                `CREATE INDEX IF NOT EXISTS idx_customer_fcm_tokens_token
                    ON ${CUSTOMER_TOKEN_TABLE}(token)`
            );
        })().catch((error) => {
            customerTokenTableReady = null;
            throw error;
        });
    }
    return customerTokenTableReady;
};

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
        await ensureCustomerTokenTable();
        await pool.query(
            `INSERT INTO customer_fcm_tokens (session_id, token)
             VALUES ($1::int, $2)
             ON CONFLICT (session_id, token)
             DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
            [sessionId, token.trim()]
        );
        // Kung admin device dati ang phone na ito, alisin ang staff row para
        // hindi na tumanggap ng admin notifications sa customer APK.
        await removeStaffTokenForDevice(token.trim());
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
    await ensureCustomerTokenTable();
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
            // Data-only para tumakbo ang Flutter background handler kahit
            // killed/background ang app — doon natin nire-record sa history
            // bago i-display ang local notification.
            data: {
                title: message.title,
                body: message.body,
                type: 'order_status',
                order_id: String(order_id ?? ''),
                session_id: String(session_id ?? ''),
                table_id: String(table_id ?? ''),
                status: normalizedStatus
            },
            android: {
                priority: 'high'
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

// Siguraduhing existing ang staff token table kahit nakalimutan i-run ang
// migration sa deployment. Isang beses lang ito tumatakbo bawat process.
const ensureStaffTokenTable = async () => {
    if (!staffTokenTableReady) {
        staffTokenTableReady = pool.query(`
            CREATE TABLE IF NOT EXISTS ${STAFF_TOKEN_TABLE} (
                id BIGSERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                token TEXT NOT NULL UNIQUE,
                role VARCHAR(20),
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_staff_fcm_tokens_user_id
                ON ${STAFF_TOKEN_TABLE}(user_id);
        `).catch((error) => {
            staffTokenTableReady = null;
            throw error;
        });
    }
    return staffTokenTableReady;
};

const registerStaffFcmToken = async (req, res) => {
    const token = req.body?.fcm_token;
    const userId = req.user?.id;
    const role = req.user?.role ? String(req.user.role).toUpperCase() : null;

    if (typeof token !== 'string' || !token.trim() || token.trim().length > 4096) {
        return res.status(400).json({ success: false, message: 'A valid fcm_token is required.' });
    }
    if (!userId) {
        return res.status(401).json({ success: false, message: 'Staff authentication required.' });
    }

    try {
        await ensureStaffTokenTable();
        await pool.query(
            `INSERT INTO ${STAFF_TOKEN_TABLE} (user_id, token, role)
             VALUES ($1::int, $2, $3)
             ON CONFLICT (token)
             DO UPDATE SET user_id = EXCLUDED.user_id,
                           role = EXCLUDED.role,
                           updated_at = CURRENT_TIMESTAMP`,
            [userId, token.trim(), role]
        );
        // Alisin ang customer registration ng parehong device para hindi na
        // ito makakuha ng customer pushes habang naka-admin login.
        await removeCustomerTokenForDevice(token.trim());
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('[FCM] Staff token registration failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to register staff FCM token.' });
    }
};

const unregisterStaffFcmToken = async (req, res) => {
    const token = req.body?.fcm_token || req.query?.fcm_token;
    const userId = req.user?.id;

    if (typeof token !== 'string' || !token.trim()) {
        return res.status(400).json({ success: false, message: 'A valid fcm_token is required.' });
    }

    try {
        await ensureStaffTokenTable();
        await pool.query(
            `DELETE FROM ${STAFF_TOKEN_TABLE} WHERE token = $1 AND user_id = $2::int`,
            [token.trim(), userId || null]
        );
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('[FCM] Staff token removal failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to remove staff FCM token.' });
    }
};

const sendStaffNotification = async ({ title, body, data = {} }) => {
    if (!firebaseApp) return { sent: 0, failed: 0, skipped: true, reason: 'not_configured' };

    try {
        await ensureStaffTokenTable();
        // Iwasan ang pagpapadala ng admin alerts sa device na kasalukuyang
        // naka-register bilang customer (customer APK). Kahit may stale staff
        // row na naiwan mula sa dating admin test, hindi na ito padadalhan.
        const { rows } = await pool.query(
            `SELECT s.token
               FROM ${STAFF_TOKEN_TABLE} s
              WHERE s.token IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM ${CUSTOMER_TOKEN_TABLE} c
                     WHERE c.token = s.token
                )`
        );
        const tokens = [...new Set((rows || []).map((row) => row.token).filter(Boolean))];
        if (tokens.length === 0) return { sent: 0, failed: 0, skipped: true, reason: 'no_tokens' };

        const messaging = getMessaging(firebaseApp);
        const normalizedData = {};
        Object.entries(data || {}).forEach(([key, value]) => {
            normalizedData[key] = value == null ? '' : String(value);
        });

        const invalidTokens = [];
        let sent = 0;
        let failed = 0;

        for (let start = 0; start < tokens.length; start += 500) {
            const batch = tokens.slice(start, start + 500);
            const response = await messaging.sendEachForMulticast({
                tokens: batch,
                notification: { title, body },
                data: normalizedData,
                android: {
                    priority: 'high',
                    notification: {
                        channelId: 'balai_silayan_orders_v2',
                        icon: 'ic_stat_balai',
                        sound: 'default'
                    }
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
                `DELETE FROM ${STAFF_TOKEN_TABLE} WHERE token = ANY($1::text[])`,
                [invalidTokens]
            );
        }

        return { sent, failed };
    } catch (error) {
        console.error('[FCM] Staff notification failed:', error.message);
        return { sent: 0, failed: 0, skipped: true, reason: 'error' };
    }
};

const sendCustomerOrderPlacedNotification = async ({
    session_id,
    table_id,
    order_id,
    fulfillment_type,
    is_additional
} = {}) => {
    if (!firebaseApp) return { sent: 0, failed: 0, skipped: true, reason: 'not_configured' };
    if (!session_id) return { sent: 0, failed: 0, skipped: true, reason: 'no_session' };

    const isAdditional = Boolean(is_additional);
    const message = {
        title: isAdditional
            ? `Additional items received for Order #${order_id}`
            : `Order received! #${order_id}`,
        body: isAdditional
            ? 'The kitchen has received the additional items for your order.'
            : 'We received your order — the kitchen is now preparing it.'
    };

    await ensureCustomerTokenTable();
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
            // Data-only din: kailangan itong pumasok sa background handler
            // para ma-save sa notification history kahit patay ang app.
            data: {
                title: message.title,
                body: message.body,
                type: isAdditional ? 'additional_order' : 'new_order',
                order_id: String(order_id ?? ''),
                session_id: String(session_id ?? ''),
                table_id: String(table_id ?? ''),
                fulfillment_type: String(fulfillment_type || ''),
                is_additional: isAdditional ? '1' : '0'
            },
            android: {
                priority: 'high'
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

/// Diagnostic para malaman kung naka-configure ang FCM at kung may naka-register
/// na staff device — walang secrets na ibinabalik.
const getStaffFcmStatus = async () => {
    try {
        await ensureStaffTokenTable();
        const { rows } = await pool.query(
            `SELECT COUNT(*)::int AS token_count FROM ${STAFF_TOKEN_TABLE}`
        );
        return {
            fcmConfigured: isFcmConfigured(),
            tokenCount: rows && rows[0] ? Number(rows[0].token_count) : 0
        };
    } catch (error) {
        console.error('[FCM] Status check failed:', error.message);
        return { fcmConfigured: isFcmConfigured(), tokenCount: 0, error: error.message };
    }
};

/// Test push mula sa Admin UI para ma-verify agad ang delivery + deep-link.
const sendTestStaffNotification = async ({ type = 'new_order' } = {}) => {
    const normalized = String(type || 'new_order').toLowerCase();
    const presets = {
        new_order: {
            title: 'TEST: New Order',
            body: 'Ito ay test push. I-tap para pumunta sa Order Queue.',
            data: { type: 'new_order', order_id: 'TEST', source: 'test' }
        },
        additional_order: {
            title: 'TEST: Additional Order',
            body: 'Ito ay test push. I-tap para pumunta sa Order Queue.',
            data: { type: 'additional_order', order_id: 'TEST', source: 'test' }
        },
        low_stock: {
            title: 'TEST: Low Stock',
            body: 'Ito ay test push. I-tap para pumunta sa Low Stock.',
            data: { type: 'low_stock', item_name: 'TEST ITEM', item_id: '0', source: 'test' }
        },
        bill_requested: {
            title: 'TEST: Bill Requested',
            body: 'Ito ay test push. I-tap para pumunta sa Bill.',
            data: { type: 'bill_requested', order_id: 'TEST', source: 'test' }
        }
    };
    const preset = presets[normalized] || presets.new_order;
    return sendStaffNotification(preset);
};

module.exports = {
    isFcmConfigured,
    registerFcmToken,
    registerStaffFcmToken,
    unregisterStaffFcmToken,
    getStaffFcmStatus,
    sendTestStaffNotification,
    sendOrderStatusNotification,
    sendCustomerOrderPlacedNotification,
    sendStaffNotification
};
