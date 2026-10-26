import { describe, expect, it } from "vitest";
import { createTestDb } from "./nodeSqliteDb";

const NOW = "2026-10-26T00:00:00.000Z";

describe("migration 0001", () => {
  it("tạo đủ các bảng", async () => {
    const db = createTestDb();
    const rows = await db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    expect(rows.map((r) => r.name)).toEqual([
      "cards",
      "examples",
      "review_logs",
      "settings",
      "topics",
      "word_topics",
      "words",
    ]);
  });

  it("có settings mặc định", async () => {
    const db = createTestDb();
    const rows = await db.select<{ key: string; value: string }>(
      "SELECT key, value FROM settings ORDER BY key",
    );
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual({
      grade_buttons: "2",
      level: "N5",
      max_reviews_per_session: "100",
      new_per_day: "10",
    });
  });

  it("xóa từ thì xóa theo thẻ, ví dụ và liên kết chủ đề", async () => {
    const db = createTestDb();
    const { lastInsertId: wordId } = await db.execute(
      "INSERT INTO words (term, created_at, updated_at) VALUES (?, ?, ?)",
      ["食べる", NOW, NOW],
    );
    const { lastInsertId: topicId } = await db.execute("INSERT INTO topics (name) VALUES (?)", ["Ăn uống"]);
    await db.execute("INSERT INTO word_topics (word_id, topic_id) VALUES (?, ?)", [wordId, topicId]);
    await db.execute("INSERT INTO examples (word_id, ja) VALUES (?, ?)", [wordId, "ご飯を食べる。"]);
    await db.execute(
      `INSERT INTO cards (word_id, skill, due, stability, difficulty, elapsed_days,
         scheduled_days, reps, lapses, state) VALUES (?, 'meaning', ?, 0, 0, 0, 0, 0, 0, 0)`,
      [wordId, NOW],
    );

    await db.execute("DELETE FROM words WHERE id = ?", [wordId]);

    for (const table of ["cards", "examples", "word_topics"]) {
      const [{ n }] = await db.select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(n, table).toBe(0);
    }
    const [{ n: topics }] = await db.select<{ n: number }>("SELECT COUNT(*) AS n FROM topics");
    expect(topics).toBe(1);
  });

  it("chặn skill không hợp lệ", async () => {
    const db = createTestDb();
    const { lastInsertId: wordId } = await db.execute(
      "INSERT INTO words (term, created_at, updated_at) VALUES (?, ?, ?)",
      ["見る", NOW, NOW],
    );
    await expect(
      db.execute(
        `INSERT INTO cards (word_id, skill, due, stability, difficulty, elapsed_days,
           scheduled_days, reps, lapses, state) VALUES (?, 'writing', ?, 0, 0, 0, 0, 0, 0, 0)`,
        [wordId, NOW],
      ),
    ).rejects.toThrow();
  });
});
