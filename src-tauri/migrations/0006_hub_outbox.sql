-- Outbox gửi sự kiện cho Personal Productivity Hub (docs/2026-11-07-japanese-app-integration.md).
-- payload là toàn bộ envelope JSON, đóng băng lúc tạo: event_id/occurred_at/recorded_at không đổi khi gửi lại.
CREATE TABLE hub_outbox (
  id              INTEGER PRIMARY KEY,
  event_id        TEXT NOT NULL UNIQUE,
  event_type      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  dedupe_key      TEXT UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  recorded_at     TEXT NOT NULL,
  delivered_at    TEXT
);

CREATE INDEX idx_hub_outbox_status_recorded ON hub_outbox (status, recorded_at);

-- Từ đã báo "đã thuộc" cho Hub (lần đầu đạt Vững), để mỗi từ chỉ báo 1 lần.
CREATE TABLE hub_mastered_reported (
  word_id     INTEGER PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
  reported_at TEXT NOT NULL
);

-- Từ đã Vững (stability >= 21, khớp MASTERED_STABILITY) từ trước khi có tích hợp: coi như đã báo,
-- để Hub không nhận cả kho từ cũ là "vừa thuộc" (hợp đồng §6.1).
INSERT INTO hub_mastered_reported (word_id, reported_at)
SELECT word_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM cards
WHERE skill = 'meaning' AND stability >= 21;
