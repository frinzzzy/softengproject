-- Order-level special instructions / notes mula sa customer.
-- Halimbawa: "Allergic to peanuts", "Less ice", "No onions".
-- Isang note kada ticket; ipinapakita sa admin order card at receipt.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;
