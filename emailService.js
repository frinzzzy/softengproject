const crypto = require('crypto');
const pool = require('./db');

let nodemailer = null;
try {
    // Optional dependency — kailangan nito ang Gmail SMTP credentials (GMAIL_USER + GMAIL_APP_PASSWORD).
    nodemailer = require('nodemailer');
} catch (_) {
    nodemailer = null;
}

let transporter = null;

const getEnv = (key, fallback = '') => (process.env[key] || fallback).toString().trim();

const isEmailConfigured = () =>
    Boolean(nodemailer && getEnv('GMAIL_USER') && getEnv('GMAIL_APP_PASSWORD'));

const getTransporter = () => {
    if (!isEmailConfigured()) return null;
    if (!transporter) {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: getEnv('GMAIL_USER'),
                pass: getEnv('GMAIL_APP_PASSWORD')
            }
        });
    }
    return transporter;
};

const formatPeso = (value) => `₱${Number(value || 0).toFixed(2)}`;

const formatOrderCode = (orderId) => {
    const n = Number(orderId);
    if (!Number.isFinite(n)) return `#BS-${orderId}`;
    return `#BS-${String(n).padStart(4, '0')}`;
};

const escapeHtml = (value) =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const formatDateTime = (iso) => {
    if (!iso) return 'N/A';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'N/A';
    return d.toLocaleString('en-PH', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
};

/// ---------------------------------------------------------------------------
/// Signed "View ticket" link
/// ---------------------------------------------------------------------------
/// Hindi ito nangangailangan ng bagong hosting — nasa iisang Express app ang
/// /t/:token route. JWT_SECRET ang fallback kung walang espesipikong secret,
/// kaya walang bagong env var na kailangang i-set para gumana.
const TICKET_LINK_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 taon

const base64UrlEncode = (value) =>
    Buffer.from(value)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

const base64UrlDecode = (value) =>
    Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

const getTicketLinkSecret = () => getEnv('TICKET_LINK_SECRET') || getEnv('JWT_SECRET');

const signTicketToken = (orderId) => {
    const secret = getTicketLinkSecret();
    if (!secret) return null;
    const payload = base64UrlEncode(JSON.stringify({
        oid: Number(orderId),
        exp: Math.floor(Date.now() / 1000) + TICKET_LINK_TTL_SECONDS
    }));
    const signature = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    return `${payload}.${signature}`;
};

const verifyTicketToken = (token) => {
    const secret = getTicketLinkSecret();
    if (!secret || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

    const [payload, signature] = parts;
    const expected = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    const receivedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (receivedBuffer.length !== expectedBuffer.length) return null;
    if (!crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) return null;

    try {
        const claims = JSON.parse(base64UrlDecode(payload));
        const orderId = Number(claims.oid);
        const expiresAt = Number(claims.exp);
        if (!Number.isSafeInteger(orderId) || orderId <= 0) return null;
        if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return null;
        return orderId;
    } catch (_) {
        return null;
    }
};

const buildViewTicketUrl = (orderId) => {
    const token = signTicketToken(orderId);
    if (!token) return null;
    const base = getEnv('PUBLIC_BASE_URL') || 'https://softengproject.onrender.com';
    return `${base.replace(/\/+$/, '')}/t/${token}`;
};

const fetchOrderTicket = async (orderId) => {
    const orderRes = await pool.query(
        `SELECT
            o.id,
            o.total_amount,
            o.order_status,
            o.notes,
            o.created_at,
            o.is_additional_order,
            o.parent_order_id,
            COALESCE(t.table_number, o.table_id) AS table_number,
            COALESCE(o.fulfillment_type, 'DINE_IN') AS fulfillment_type,
            ca.email AS customer_email,
            cp.given_name AS customer_given_name,
            cp.family_name AS customer_family_name
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN customer_accounts ca ON o.customer_id = ca.id
       LEFT JOIN customer_profiles cp ON cp.customer_id = ca.id
      WHERE o.id = $1::int`,
        [Number(orderId)]
    );

    if (orderRes.rows.length === 0) {
        return null;
    }

    const order = orderRes.rows[0];
    const itemsRes = await pool.query(
        `SELECT
            oi.id AS order_item_id,
            oi.menu_item_id,
            oi.quantity,
            oi.unit_price,
            mi.name AS item_name,
            oia.addon_id,
            ma.name AS addon_name,
            oia.price AS addon_price
           FROM order_items oi
           LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
           LEFT JOIN order_item_addons oia ON oia.order_item_id = oi.id
           LEFT JOIN menu_addons ma ON oia.addon_id = ma.id
          WHERE oi.order_id = $1::int
          ORDER BY oi.id`,
        [Number(orderId)]
    );

    const items = [];
    const byItem = new Map();
    for (const row of itemsRes.rows) {
        if (!byItem.has(row.order_item_id)) {
            const item = {
                order_item_id: row.order_item_id,
                menu_item_id: row.menu_item_id,
                quantity: Number(row.quantity),
                unit_price: Number(row.unit_price || 0),
                item_name: row.item_name || `Item #${row.menu_item_id}`,
                addons: []
            };
            byItem.set(row.order_item_id, item);
            items.push(item);
        }
        const item = byItem.get(row.order_item_id);
        if (row.addon_id != null && row.addon_id !== undefined) {
            item.addons.push({
                addon_id: row.addon_id,
                addon_name: row.addon_name,
                price: Number(row.addon_price || 0)
            });
        }
    }

    return {
        order,
        items,
        customerEmail: order.customer_email || null,
        customerName: [order.customer_given_name, order.customer_family_name]
            .filter((part) => part)
            .join(' ')
            .trim()
    };
};

const getPickupDetails = () => ({
    address:
        getEnv('RESTAURANT_PICKUP_ADDRESS') ||
        'Balai Silayan Heritage Restaurant',
    instructions:
        getEnv('RESTAURANT_PICKUP_INSTRUCTIONS') ||
        'Please present this ticket / order code during pickup.',
    phone: getEnv('RESTAURANT_CONTACT_NUMBER') || ''
});

const buildTicketText = ({ order, items, isAdditional }) => {
    const pickupDetails = getPickupDetails();
    const lines = [];
    lines.push(isAdditional
        ? 'ADDITIONAL ITEMS TICKET - Balai Silayan'
        : 'ORDER TICKET - Balai Silayan');
    lines.push(`Order Code: ${formatOrderCode(order.id)}`);
    lines.push(`Date: ${formatDateTime(order.created_at)}`);
    lines.push(`Type: ${isAdditional ? 'Additional Order' : 'New Order'}`);
    lines.push(`Fulfillment: ${order.fulfillment_type || 'DINE_IN'}`);
    if (order.table_number) {
        lines.push(`Table: ${order.table_number}`);
    }
    lines.push(`Pickup: ${pickupDetails.address}`);
    if (pickupDetails.phone) {
        lines.push(`Contact: ${pickupDetails.phone}`);
    }
    lines.push(pickupDetails.instructions);
    lines.push('');
    lines.push('Items:');
    for (const item of items) {
        lines.push(`- ${item.quantity}x ${item.item_name} - ${formatPeso(item.unit_price * item.quantity)}`);
        for (const addon of item.addons) {
            lines.push(`    + ${addon.addon_name} - ${formatPeso(addon.price)}`);
        }
    }
    lines.push('');
    lines.push(`Total: ${formatPeso(order.total_amount)}`);
    if (order.notes) {
        lines.push(`Notes: ${order.notes}`);
    }
    return lines.join('\n');
};

const buildTicketHtml = ({ order, items, isAdditional, viewTicketUrl }) => {
    const pickupDetails = getPickupDetails();
    const itemRows = items
        .map((item) => {
            const addonParts = (item.addons || [])
                .map((addon) => `${addon.addon_name}: ${formatPeso(addon.price)}`)
                .join(', ');
            const addonsHtml = addonParts
                ? `<div style="font-size: 12px; color: #555;">Add-ons: ${escapeHtml(addonParts)}</div>`
                : '';
            return `<tr>
                <td style="padding: 6px 8px;">${escapeHtml(item.quantity)}x ${escapeHtml(item.item_name)}</td>
                <td style="padding: 6px 8px; text-align: right;">${formatPeso(item.unit_price * item.quantity)}</td>
                <td style="padding: 6px 8px; text-align: right; background-color: #f6f0e7;">${addonsHtml}</td>
            </tr>`;
        })
        .join('');

    const headerRow =
        '<tr><th style="text-align: left; padding: 6px 8px;">Item</th>' +
        '<th style="text-align: right; padding: 6px 8px;">Amount</th>' +
        '<th style="text-align: right; padding: 6px 8px;">Add-ons</th></tr>';

    const itemsTable = items.length > 0
        ? `<table class="ticket-table" role="presentation" cellpadding="0" cellspacing="0" border="0" align="left" style="width: 100%; border-collapse: collapse;">${headerRow}${itemRows}</table>`
        : '<p style="font-size: 13px;">No items recorded.</p>';

    const ticketNote = isAdditional
        ? 'This ticket covers the <b>additional items</b> added to the parent order.'
        : 'This ticket covers the <b>new order</b>.';

    return `<div class="ticket-container" style="font-family: Arial, Helvetica, sans-serif; color: #203F35; width: 100%; max-width: 560px; margin: 0 auto; padding: 24px; border: 1px solid #e5dccb; border-radius: 12px; box-sizing: border-box;">
        <h2 class="ticket-title" style="margin: 0; color: #203F35;">${isAdditional ? 'Additional Items Ticket' : 'Order Ticket'}</h2>
        <p class="ticket-sub" style="font-size: 14px; margin: 8px 0;">Balai Silayan Heritage Restaurant</p>
        <p style="font-size: 13px;">${escapeHtml(ticketNote)}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="left" style="width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px;">
            <tr>
                <td style="padding: 4px 0;"><b>Order Code:</b></td>
                <td style="text-align: right;"><b>${escapeHtml(formatOrderCode(order.id))}</b></td>
            </tr>
            <tr>
                <td style="padding: 4px 0;">Date</td>
                <td style="text-align: right;">${escapeHtml(formatDateTime(order.created_at))}</td>
            </tr>
            <tr>
                <td style="padding: 4px 0;">Type</td>
                <td style="text-align: right;">${escapeHtml(isAdditional ? 'Additional Order' : 'New Order')}</td>
            </tr>
            <tr>
                <td style="padding: 4px 0;">Fulfillment</td>
                <td style="text-align: right;">${escapeHtml(order.fulfillment_type || 'DINE_IN')}</td>
            </tr>
            ${order.table_number ? `<tr><td style="padding: 4px 0;">Table</td><td style="text-align: right;">${escapeHtml(String(order.table_number))}</td></tr>` : ''}
            <tr>
                <td style="padding: 4px 0;"><b>Total</b></td>
                <td style="text-align: right;"><b>${formatPeso(order.total_amount)}</b></td>
            </tr>
        </table>
        <h4 style="margin-bottom: 4px;">Items</h4>
        ${itemsTable}
        ${order.notes ? `<p style="font-size: 13px; margin-top: 12px;"><b>Notes:</b> ${escapeHtml(order.notes)}</p>` : ''}
        <p style="font-size: 12px; margin-top: 12px;">
            Pickup: ${escapeHtml(pickupDetails.address)}
            ${pickupDetails.phone ? ` • Contact: ${escapeHtml(pickupDetails.phone)}` : ''}
        </p>
        <p style="font-size: 12px; margin-top: 4px;">${escapeHtml(pickupDetails.instructions)}</p>
        ${viewTicketUrl
            ? `<p style="margin-top: 16px; text-align: center;">
                <a href="${escapeHtml(viewTicketUrl)}"
                   style="display: inline-block; background: #203F35; color: #ffffff; text-decoration: none;
                          padding: 11px 20px; border-radius: 10px; font-size: 14px; font-weight: bold;">
                   View ticket
                </a>
               </p>`
            : ''}
        <p style="font-size: 12px; margin-top: 16px; text-align: center;">Please show this ticket / order code to the staff during pickup.</p>
        <style>
            @media screen and (max-width: 480px) {
                .ticket-container { width: 100% !important; max-width: 100% !important; }
                .ticket-title { font-size: 20px !important; }
                .ticket-sub { font-size: 12px !important; }
                .ticket-table td, .ticket-table th { font-size: 13px !important; padding: 6px !important; }
            }
        </style>
    </div>`;
};

/// Buong pickup ticket: parent order + lahat ng additional orders. Kaya kapag
/// "additional items" ang email, makikita pa rin ang buong ticket sa page.
const fetchOrderTicketBundle = async (orderId) => {
    const requested = await fetchOrderTicket(orderId);
    if (!requested) return null;

    const parentId = Number(requested.order.parent_order_id);
    const hasParent = Number.isSafeInteger(parentId) && parentId > 0;
    const rootId = hasParent ? parentId : Number(requested.order.id);
    const root = hasParent ? await fetchOrderTicket(rootId) : requested;
    const orders = root ? [root] : [requested];

    try {
        const additionsRes = await pool.query(
            `SELECT id FROM orders WHERE parent_order_id = $1::int ORDER BY id ASC`,
            [rootId]
        );
        for (const row of additionsRes.rows) {
            const addId = Number(row.id);
            if (orders.some((entry) => Number(entry.order.id) === addId)) continue;
            const addition = await fetchOrderTicket(addId);
            if (addition) orders.push(addition);
        }
    } catch (error) {
        console.warn('[Email] Could not load additional tickets for page:', error.message);
    }

    return {
        rootId,
        orders,
        customerEmail: requested.customerEmail || root?.customerEmail || null
    };
};

const buildTicketPageHtml = ({ bundle }) => {
    const rootId = Number(bundle.rootId);
    const cards = bundle.orders
        .map((entry) => buildTicketHtml({
            order: entry.order,
            items: entry.items,
            isAdditional: Number(entry.order.id) !== rootId
        }))
        .join('<div style="height: 14px;"></div>');

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ticket ${escapeHtml(formatOrderCode(rootId))} - Balai Silayan</title>
</head>
<body style="margin: 0; padding: 16px; background: #f8f4ec;">
    <div style="max-width: 600px; margin: 0 auto;">
        ${cards}
        <p style="text-align: center; font-size: 12px; color: #788078; margin: 18px 0 0;">
            Balai Silayan Heritage Restaurant • Show this ticket at pickup
        </p>
    </div>
</body>
</html>`;
};

/// Ipinapadala ang order ticket sa customer (Google sign-in email). Best-effort —
/// hindi ito ang nagdidikta ng order; kung mag-fail ay mag-log lang.
const sendOrderTicketEmail = async ({ customerId, orderId, isAdditional }) => {
    try {
        const ticket = await fetchOrderTicket(orderId);
        if (!ticket) {
            return { sent: false, reason: 'order_not_found' };
        }
        const customerEmail = ticket.customerEmail;
        if (!customerEmail) {
            return { sent: false, reason: 'no_customer_email' };
        }

        const transporterInstance = getTransporter();
        if (!transporterInstance) {
            console.warn('[Email] Gmail SMTP is not configured. Skipping order ticket email.');
            return { sent: false, reason: 'not_configured' };
        }

        const order = ticket.order;
        const subject = isAdditional
            ? `Additional Items Ticket - ${formatOrderCode(order.id)} - Balai Silayan`
            : `Order Ticket #${formatOrderCode(order.id)} - Balai Silayan`;

        const viewTicketUrl = buildViewTicketUrl(order.id);
        const text = buildTicketText({
            order,
            items: ticket.items,
            isAdditional: Boolean(isAdditional)
        });
        const fullText = viewTicketUrl ? `${text}\n\nView ticket: ${viewTicketUrl}` : text;

        const info = await transporterInstance.sendMail({
            from: `"Balai Silayan" <${getEnv('GMAIL_USER')}>`,
            to: customerEmail,
            subject,
            text: fullText,
            html: buildTicketHtml({
                order,
                items: ticket.items,
                isAdditional: Boolean(isAdditional),
                viewTicketUrl
            })
        });

        return { sent: true, messageId: info && info.messageId };
    } catch (error) {
        console.error(
            `[Email] Failed to send order ticket for order ${orderId}:`,
            error && error.message ? error.message : error
        );
        return { sent: false, error: error && error.message ? error.message : 'unknown' };
    }
};

module.exports = {
    isEmailConfigured,
    sendOrderTicketEmail,
    verifyTicketToken,
    fetchOrderTicketBundle,
    buildTicketPageHtml,
    buildViewTicketUrl
};
