-- 0008_stop_loss.sql — E09-T01b: persist protective stop-loss price on order_intents.
-- Advisory-only: storing stop_loss does not trigger an exit order; a watcher/
-- executor reads order_intents.stop_loss and submits the exit order separately.
-- Forward-only: ALTER TABLE ADD COLUMN is additive and safe.
ALTER TABLE order_intents ADD COLUMN stop_loss TEXT;