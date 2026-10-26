-- Kết quả quiz tự chọn theo chủ đề. Không ảnh hưởng lịch FSRS.
CREATE TABLE quiz_sessions (
  id          INTEGER PRIMARY KEY,
  topic_names TEXT NOT NULL,          -- JSON array tên chủ đề lúc làm quiz
  total       INTEGER NOT NULL,
  correct     INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL
);

CREATE TABLE quiz_answers (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  word_id    INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  correct    INTEGER NOT NULL,
  chosen     TEXT NOT NULL
);

CREATE INDEX idx_quiz_answers_session ON quiz_answers (session_id);
CREATE INDEX idx_word_topics_topic ON word_topics (topic_id);
