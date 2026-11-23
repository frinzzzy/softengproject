const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const pool = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const googleClient = new OAuth2Client();

/// Puwedeng isa o marami (comma-separated) na Google OAuth client IDs —
/// Android, iOS, at Web clients kung may web demo.
const googleAudiences = String(
    process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || ''
)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const getBearerToken = (authorizationHeader) => {
    if (typeof authorizationHeader !== 'string') return null;
    return authorizationHeader.match(/^Bearer\s+(\S+)\s*$/i)?.[1] || null;
};

const verifyGoogleIdToken = async (idToken) => {
    const ticket = await googleClient.verifyIdToken({
        idToken,
        ...(googleAudiences.length > 0 ? { audience: googleAudiences } : {})
    });
    return ticket.getPayload();
};

/// Bawat online customer ay may sariling virtual table para hindi mag-collide
/// ang sessions at para hindi makita ang orders ng ibang tao.
const ensureVirtualTable = async (client, customerId) => {
    const existing = await client.query(
        `SELECT t.*
           FROM virtual_table_owners v
           JOIN tables t ON t.id = v.table_id
          WHERE v.customer_id = $1::int`,
        [customerId]
    );
    if (existing.rows.length > 0) return existing.rows[0];

    const preferredNumber = 900000 + Number(customerId);
    const taken = await client.query(
        'SELECT id, is_virtual FROM tables WHERE table_number = $1::int',
        [preferredNumber]
    );

    let tableNumber = preferredNumber;
    if (taken.rows.length > 0) {
        const maxVirtual = await client.query(
            `SELECT COALESCE(MAX(table_number), 900000) AS max_number
               FROM tables
              WHERE is_virtual = TRUE`
        );
        tableNumber = Math.max(
            Number(maxVirtual.rows[0].max_number) + 1,
            900001
        );
    }

    const qrToken = `virtual_${crypto.randomUUID()}`;
    const inserted = await client.query(
        `INSERT INTO tables (table_number, qr_token, status, is_virtual)
         VALUES ($1::int, $2::text, 'AVAILABLE', TRUE)
         RETURNING *`,
        [tableNumber, qrToken]
    );

    await client.query(
        `INSERT INTO virtual_table_owners (customer_id, table_id)
         VALUES ($1::int, $2::int)
         ON CONFLICT (customer_id) DO UPDATE SET table_id = EXCLUDED.table_id`,
        [customerId, inserted.rows[0].id]
    );

    return inserted.rows[0];
};

const ensureActiveSession = async (client, tableId) => {
    const active = await client.query(
        `SELECT *
           FROM table_sessions
          WHERE table_id = $1::int
            AND UPPER(session_status) IN ('ACTIVE', 'OPEN')
          ORDER BY id DESC
          LIMIT 1
          FOR UPDATE`,
        [tableId]
    );

    if (active.rows.length > 0) {
        await client.query(
            `UPDATE table_sessions
                SET last_active_at = CURRENT_TIMESTAMP
              WHERE id = $1::int`,
            [active.rows[0].id]
        );
        return active.rows[0];
    }

    const created = await client.query(
        `INSERT INTO table_sessions (table_id, session_status, last_active_at)
         VALUES ($1::int, 'ACTIVE', CURRENT_TIMESTAMP)
         RETURNING *`,
        [tableId]
    );
    return created.rows[0];
};

const upsertCustomer = async (client, payload) => {
    const account = await client.query(
        `INSERT INTO customer_accounts (google_sub, email, last_login_at)
         VALUES ($1::text, $2::text, CURRENT_TIMESTAMP)
         ON CONFLICT (google_sub) DO UPDATE
            SET email = COALESCE(EXCLUDED.email, customer_accounts.email),
                last_login_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [payload.sub, payload.email || null]
    );

    const customer = account.rows[0];
    const displayName = String(payload.name || '').trim();
    let givenName = String(payload.given_name || '').trim();
    let familyName = String(payload.family_name || '').trim();

    if (!givenName && !familyName && displayName) {
        const parts = displayName.split(/\s+/);
        givenName = parts.shift() || '';
        familyName = parts.join(' ');
    }

    await client.query(
        `INSERT INTO customer_profiles (customer_id, given_name, family_name, avatar_url, updated_at)
         VALUES ($1::int, $2::text, $3::text, $4::text, CURRENT_TIMESTAMP)
         ON CONFLICT (customer_id) DO UPDATE
            SET given_name = COALESCE(NULLIF(EXCLUDED.given_name, ''), customer_profiles.given_name),
                family_name = COALESCE(NULLIF(EXCLUDED.family_name, ''), customer_profiles.family_name),
                avatar_url = COALESCE(EXCLUDED.avatar_url, customer_profiles.avatar_url),
                updated_at = CURRENT_TIMESTAMP`,
        [
            customer.id,
            givenName || null,
            familyName || null,
            payload.picture || null
        ]
    );

    return {
        id: customer.id,
        email: customer.email,
        given_name: givenName,
        family_name: familyName,
        avatar_url: payload.picture || null
    };
};

/// POST /api/v1/customer/auth/google
/// Body: { id_token }
/// Returns the same shape as a table QR scan, pero para sa online takeout.
const googleSignIn = async (req, res) => {
    const idToken = req.body?.id_token || req.body?.idToken;

    if (!idToken) {
        return res.status(400).json({
            success: false,
            message: 'Google ID token is required.'
        });
    }

    if (googleAudiences.length === 0) {
        console.error('[Google Auth] GOOGLE_CLIENT_IDS/GOOGLE_CLIENT_ID is not set.');
        return res.status(503).json({
            success: false,
            message: 'Google Sign-In is not configured on the server yet.'
        });
    }

    try {
        const payload = await verifyGoogleIdToken(idToken);
        if (!payload?.sub) {
            return res.status(401).json({
                success: false,
                message: 'Google account could not be verified.'
            });
        }

        if (payload.email_verified === false) {
            return res.status(401).json({
                success: false,
                message: 'Please verify your Google email first.'
            });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const customer = await upsertCustomer(client, payload);
            const virtualTable = await ensureVirtualTable(client, customer.id);
            const session = await ensureActiveSession(client, virtualTable.id);

            await client.query('COMMIT');

            const sessionToken = jwt.sign(
                {
                    purpose: 'table_session',
                    session_id: session.id,
                    table_id: virtualTable.id,
                    channel: 'TAKEOUT',
                    customer_id: customer.id
                },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            return res.status(200).json({
                success: true,
                customer,
                channel: 'TAKEOUT',
                fulfillment_type: 'TAKEOUT',
                table_id: virtualTable.id,
                table_number: virtualTable.table_number,
                session_id: session.id,
                session_token: sessionToken,
                message: 'Online takeout session ready.'
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('[Google Auth] Sign-in failed:', error.message);

        const isVerificationError = /token|audience|issuer|expired|signature/i.test(
            error.message || ''
        );
        return res.status(isVerificationError ? 401 : 500).json({
            success: false,
            message: isVerificationError
                ? 'Invalid or expired Google token. Please sign in again.'
                : 'Unable to sign in with Google right now.'
        });
    }
};

/// POST /api/v1/customer/auth/google/identity
/// Bagong login-first flow: i-verify ang Google account at mag-issue ng
/// customer identity token. Hindi ito gumagawa ng virtual table/session —
/// ang physical table session ay makuha lang sa QR scan.
const customerIdentitySignIn = async (req, res) => {
    const idToken = req.body?.id_token || req.body?.idToken;

    if (!idToken) {
        return res.status(400).json({
            success: false,
            message: 'Google ID token is required.'
        });
    }

    if (googleAudiences.length === 0) {
        console.error('[Google Auth] GOOGLE_CLIENT_IDS/GOOGLE_CLIENT_ID is not set.');
        return res.status(503).json({
            success: false,
            message: 'Google Sign-In is not configured on the server yet.'
        });
    }

    try {
        const payload = await verifyGoogleIdToken(idToken);
        if (!payload?.sub) {
            return res.status(401).json({
                success: false,
                message: 'Google account could not be verified.'
            });
        }

        if (payload.email_verified === false) {
            return res.status(401).json({
                success: false,
                message: 'Please verify your Google email first.'
            });
        }

        const client = await pool.connect();
        let customer;
        try {
            await client.query('BEGIN');
            customer = await upsertCustomer(client, payload);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

        const identityToken = jwt.sign(
            {
                purpose: 'customer_identity',
                customer_id: customer.id,
                email: customer.email || null
            },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        return res.status(200).json({
            success: true,
            customer,
            identity_token: identityToken,
            message: 'Google identity verified.'
        });
    } catch (error) {
        console.error('[Google Auth] Identity sign-in failed:', error.message);

        const isVerificationError = /token|audience|issuer|expired|signature/i.test(
            error.message || ''
        );
        return res.status(isVerificationError ? 401 : 500).json({
            success: false,
            message: isVerificationError
                ? 'Invalid or expired Google token. Please sign in again.'
                : 'Unable to sign in with Google right now.'
        });
    }
};

/// Middleware para sa customer orders.
/// - Virtual table (legacy takeout): i-override ang table/session/customer at
///   forced TAKEOUT — pinapanatili ang lumang paggawi.
/// - Physical table (bagong QR flow): kung may customer_id ang session token,
///   i-attach ang customer identity pero hayaang ang checkout ang magpili ng
///   DINE_IN o TAKEOUT.
const attachCustomerSession = async (req, res, next) => {
    const token = getBearerToken(req.headers['authorization']);
    if (!token) return next();

    let claims;
    try {
        claims = jwt.verify(token, JWT_SECRET);
    } catch (_) {
        return next();
    }

    if (
        claims.purpose !== 'table_session' ||
        !Number.isSafeInteger(Number(claims.session_id)) ||
        !Number.isSafeInteger(Number(claims.table_id))
    ) {
        return next();
    }

    const tableId = Number(claims.table_id);
    const sessionId = Number(claims.session_id);
    const tokenCustomerId = Number(claims.customer_id);
    const hasTokenCustomer =
        Number.isSafeInteger(tokenCustomerId) && tokenCustomerId > 0;

    try {
        const tableResult = await pool.query(
            `SELECT t.is_virtual, v.customer_id
               FROM tables t
               LEFT JOIN virtual_table_owners v ON v.table_id = t.id
              WHERE t.id = $1::int`,
            [tableId]
        );
        if (tableResult.rows.length === 0) return next();

        const table = tableResult.rows[0];

        // Physical table na walang Google identity: hayaang tanggihan ito ng
        // createOrder na may AUTH_REQUIRED (hindi SESSION_CLOSED).
        if (!table.is_virtual && !hasTokenCustomer) return next();

        const sessionResult = await pool.query(
            `SELECT id
               FROM table_sessions
              WHERE id = $1::int
                AND table_id = $2::int
                AND UPPER(session_status) IN ('ACTIVE', 'OPEN')`,
            [sessionId, tableId]
        );

        if (sessionResult.rows.length === 0) {
            return res.status(409).json({
                success: false,
                error: 'SESSION_CLOSED',
                message: table.is_virtual
                    ? 'This takeout session is already closed. Please sign in again.'
                    : 'This table session is already closed. Please scan the table QR again.'
            });
        }

        if (table.is_virtual) {
            const virtualCustomerId = hasTokenCustomer
                ? tokenCustomerId
                : Number(table.customer_id);
            if (!Number.isSafeInteger(virtualCustomerId) || virtualCustomerId <= 0) {
                return next();
            }
            req.customerSession = {
                customerId: virtualCustomerId,
                tableId,
                sessionId,
                channel: 'TAKEOUT',
                fulfillmentType: 'TAKEOUT'
            };
            return next();
        }

        req.customerSession = {
            customerId: tokenCustomerId,
            tableId,
            sessionId,
            channel: String(claims.channel || 'DINE_IN').toUpperCase()
        };
        return next();
    } catch (_) {
        return next();
    }
};

module.exports = {
    googleSignIn,
    customerIdentitySignIn,
    attachCustomerSession,
    verifyGoogleIdToken
};
