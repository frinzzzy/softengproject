const pool = require('./db');

/**
 * Per-ticket bill state (additive, zero side effects).
 *
 * Design rules:
 *  - `orders.bill_requested_at` is the single source of truth per ticket.
 *  - `table_sessions.bill_requested_at` is kept as-is for backward compat
 *    (bulk / session level), but ticket reads no longer depend on it.
 *  - If the column cannot be created (permissions / network), the app
 *    keeps running: every per-order read falls back to NULL and every
 *    per-order write returns a clean 503 instead of crashing.
 */

let columnAvailable = false;
let initPromise = null;

/** SQL expression to safely read the per-order bill timestamp. */
const columnExpression = (alias = 'o') =>
    columnAvailable ? `${alias}.bill_requested_at` : 'NULL::timestamp without time zone';

/**
 * Per-order bill timestamp with a legacy fallback expression.
 * Kapag hindi available ang column (hal. kulang sa DDL permission), ibinabalik
 * ang fallback (session-level) para manatiling gumagana ang lumang behavior.
 */
const readExpression = (alias = 'o', fallback = 'NULL::timestamp without time zone') =>
    columnAvailable ? `${alias}.bill_requested_at` : fallback;

const isAvailable = () => columnAvailable;

const initBillState = async () => {
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            const existing = await pool.query(
                `SELECT 1
                   FROM information_schema.columns
                  WHERE table_schema = 'public'
                    AND table_name = 'orders'
                    AND column_name = 'bill_requested_at'
                  LIMIT 1`
            );

            if (existing.rows.length === 0) {
                await pool.query(
                    'ALTER TABLE public.orders ADD COLUMN bill_requested_at timestamp without time zone'
                );
                console.log('[BillState] Added column public.orders.bill_requested_at.');

                // One-time backfill so in-flight sessions that already asked for
                // the bill keep showing as requested after deploy.
                try {
                    const backfilled = await pool.query(
                        `UPDATE orders o
                            SET bill_requested_at = ts.bill_requested_at
                           FROM table_sessions ts
                          WHERE o.session_id = ts.id
                            AND ts.bill_requested_at IS NOT NULL
                            AND o.bill_requested_at IS NULL
                            AND UPPER(o.order_status) NOT IN ('COMPLETED', 'CANCELLED', 'DECLINED', 'PAID')`
                    );
                    console.log(`[BillState] Backfilled ${backfilled.rowCount} order row(s).`);
                } catch (backfillError) {
                    console.error('[BillState] Backfill skipped:', backfillError.message);
                }
            }

            columnAvailable = true;
            console.log('[BillState] Per-ticket bill state is ready.');
        } catch (error) {
            columnAvailable = false;
            console.error(
                '[BillState] Per-ticket bill state unavailable, falling back to session-level reads:',
                error.message
            );
        }

        return columnAvailable;
    })();

    return initPromise;
};

module.exports = {
    initBillState,
    isAvailable,
    columnExpression,
    readExpression
};
