const pool = require('./db');

let initialization;

/**
 * Per-item checklist schema.
 *
 * Bawat order line item ay may sariling `is_checked` state para ma-mark ng
 * kitchen kung tapos na ang isang putahe. Additive migration ito para hindi
 * masira ang existing deployments.
 */
const initOrderChecklistSchema = () => {
    if (!initialization) {
        initialization = (async () => {
            await pool.query(`
                ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_checked BOOLEAN NOT NULL DEFAULT FALSE;
                ALTER TABLE order_items ADD COLUMN IF NOT EXISTS checked_at TIMESTAMP;
                ALTER TABLE order_items ADD COLUMN IF NOT EXISTS checked_by VARCHAR(120);
            `);
            console.log('[Checklist] Per-item checklist schema is ready.');
        })().catch((error) => {
            initialization = null;
            throw error;
        });
    }
    return initialization;
};

module.exports = { initOrderChecklistSchema };
