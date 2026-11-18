-- Per-item checklist para sa kitchen.
-- Bawat order item ay pwedeng markahan na tapos (checked) ng kitchen/waiter/admin.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_checked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS checked_at TIMESTAMP;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS checked_by VARCHAR(120);
