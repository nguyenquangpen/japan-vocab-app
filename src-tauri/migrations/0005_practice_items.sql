CREATE TABLE practice_items (
  id         INTEGER PRIMARY KEY,
  word_id    INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('cloze', 'order')),
  data       TEXT NOT NULL,
  vi         TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_practice_items_word_kind ON practice_items (word_id, kind);
