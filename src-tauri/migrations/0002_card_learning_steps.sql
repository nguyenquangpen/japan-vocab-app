-- ts-fsrs 5 lưu bước học hiện tại của thẻ (learning_steps) trong Card.
ALTER TABLE cards ADD COLUMN learning_steps INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_cards_state_due ON cards (state, due);
CREATE INDEX idx_review_logs_card ON review_logs (card_id, reviewed_at);
