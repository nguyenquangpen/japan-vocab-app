CREATE TABLE words (
  id             INTEGER PRIMARY KEY,
  term           TEXT NOT NULL,
  reading        TEXT,
  meanings_vi    TEXT,
  part_of_speech TEXT,
  usage_note     TEXT,
  confusables    TEXT,
  user_note      TEXT,
  enriched       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (term, reading)
);

CREATE TABLE examples (
  id      INTEGER PRIMARY KEY,
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  ja      TEXT NOT NULL,
  reading TEXT,
  vi      TEXT
);

CREATE TABLE topics (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE word_topics (
  word_id  INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (word_id, topic_id)
);

CREATE TABLE cards (
  id             INTEGER PRIMARY KEY,
  word_id        INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  skill          TEXT NOT NULL CHECK (skill IN ('meaning', 'reading')),
  due            TEXT NOT NULL,
  stability      REAL NOT NULL,
  difficulty     REAL NOT NULL,
  elapsed_days   INTEGER NOT NULL,
  scheduled_days INTEGER NOT NULL,
  reps           INTEGER NOT NULL,
  lapses         INTEGER NOT NULL,
  state          INTEGER NOT NULL,
  last_review    TEXT,
  UNIQUE (word_id, skill)
);

CREATE TABLE review_logs (
  id          INTEGER PRIMARY KEY,
  card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rating      INTEGER NOT NULL,
  answer      TEXT,
  correct     INTEGER NOT NULL,
  reviewed_at TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('new_per_day', '10'),
  ('max_reviews_per_session', '100'),
  ('level', 'N5'),
  ('grade_buttons', '2');
