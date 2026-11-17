const jwt = require('jsonwebtoken');
const pool = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;

const authenticateToken = async (req, res, next) => {
    const authorization = req.headers.authorization;
    const token = typeof authorization === 'string'
        ? authorization.match(/^Bearer\s+(\S+)\s*$/i)?.[1]
        : null;

    if (!token) {
        return res.status(401).json({ success: false, message: 'Access token required.' });
    }

    let claims;
    try {
        claims = jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
    }

    const userId = Number(claims.id);
    const sessionId = Number(claims.sid);
    const tokenVersion = Number(claims.token_version);
    if (!Number.isSafeInteger(userId) || userId <= 0 ||
        !Number.isSafeInteger(sessionId) || sessionId <= 0 ||
        !Number.isSafeInteger(tokenVersion) || tokenVersion < 0) {
        return res.status(401).json({ success: false, message: 'Invalid staff session.' });
    }

    try {
        const { rows } = await pool.query(
            `UPDATE staff_sessions ss
                SET last_seen_at = CURRENT_TIMESTAMP
               FROM users u
              WHERE ss.id = $1::bigint
                AND ss.user_id = u.id
                AND ss.user_id = $2::int
                AND ss.logout_at IS NULL
                AND u.is_active = TRUE
                AND u.token_version = $3::int
          RETURNING u.id, u.username, u.role, u.full_name, u.is_active, ss.id AS session_id`,
            [sessionId, userId, tokenVersion]
        );

        if (rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Staff session is no longer active.' });
        }

        req.user = rows[0];
        return next();
    } catch (error) {
        console.error('[Auth] Staff token validation failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to validate staff session.' });
    }
};

const authorizeRoles = (...allowedRoles) => (req, res, next) => {
    const role = String(req.user?.role || '').toUpperCase();
    if (!allowedRoles.map((item) => item.toUpperCase()).includes(role)) {
        return res.status(403).json({
            success: false,
            message: 'Access denied: Insufficient permissions for this route.'
        });
    }
    return next();
};

module.exports = { authenticateToken, authorizeRoles };
