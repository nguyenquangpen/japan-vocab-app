import type { Db } from "../db/db";
import { normalizeText } from "../vocab/text";

// Chủ đề dạng tag, quan hệ nhiều–nhiều với từ. Xóa chủ đề không xóa từ.

export interface Topic {
  id: number;
  name: string;
  wordCount: number;
}

export type TopicResult =
  | { status: "ok"; id: number }
  | { status: "duplicate"; id: number }
  | { status: "invalid"; message: string }
  | { status: "not_found" };

export const TOPIC_NAME_MAX = 50;

export async function listTopics(db: Db): Promise<Topic[]> {
  const rows = await db.select<{ id: number; name: string; word_count: number }>(
    `SELECT t.id, t.name, (SELECT COUNT(*) FROM word_topics wt WHERE wt.topic_id = t.id) AS word_count
     FROM topics t ORDER BY t.name COLLATE NOCASE, t.id`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, wordCount: r.word_count }));
}

export async function createTopic(db: Db, rawName: string): Promise<TopicResult> {
  const name = checkName(rawName);
  if (typeof name !== "string") return name;
  const { rowsAffected, lastInsertId } = await db.execute(
    "INSERT INTO topics (name) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM topics WHERE name = ?)",
    [name, name],
  );
  if (rowsAffected > 0 && lastInsertId !== undefined) return { status: "ok", id: lastInsertId };
  return { status: "duplicate", id: await idByName(db, name) };
}

export async function renameTopic(db: Db, id: number, rawName: string): Promise<TopicResult> {
  const name = checkName(rawName);
  if (typeof name !== "string") return name;
  const { rowsAffected } = await db.execute(
    "UPDATE topics SET name = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM topics WHERE name = ? AND id != ?)",
    [name, id, name, id],
  );
  if (rowsAffected > 0) return { status: "ok", id };
  const [self] = await db.select<{ id: number }>("SELECT id FROM topics WHERE id = ?", [id]);
  if (!self) return { status: "not_found" };
  return { status: "duplicate", id: await idByName(db, name) };
}

export async function deleteTopic(db: Db, id: number): Promise<boolean> {
  const { rowsAffected } = await db.execute("DELETE FROM topics WHERE id = ?", [id]);
  return rowsAffected > 0;
}

export async function getWordTopicIds(db: Db, wordId: number): Promise<number[]> {
  const rows = await db.select<{ topic_id: number }>(
    "SELECT topic_id FROM word_topics WHERE word_id = ? ORDER BY topic_id",
    [wordId],
  );
  return rows.map((r) => r.topic_id);
}

/** Gắn nhiều từ vào 1 chủ đề (1 câu lệnh, từ đã gắn thì bỏ qua). Trả về số liên kết mới. */
export async function addWordsToTopic(db: Db, topicId: number, wordIds: number[]): Promise<number> {
  const ids = [...new Set(wordIds)];
  if (ids.length === 0) return 0;
  const { rowsAffected } = await db.execute(
    `INSERT OR IGNORE INTO word_topics (word_id, topic_id)
     SELECT w.id, t.id FROM words w JOIN topics t ON t.id = ?
     WHERE w.id IN (${ids.map(() => "?").join(", ")})`,
    [topicId, ...ids],
  );
  return rowsAffected;
}

export async function removeWordFromTopic(db: Db, wordId: number, topicId: number): Promise<void> {
  await db.execute("DELETE FROM word_topics WHERE word_id = ? AND topic_id = ?", [wordId, topicId]);
}

function checkName(rawName: string): string | { status: "invalid"; message: string } {
  const name = normalizeText(rawName);
  if (name === "") return { status: "invalid", message: "Chưa nhập tên chủ đề." };
  if (name.length > TOPIC_NAME_MAX) {
    return { status: "invalid", message: `Tên chủ đề dài quá ${TOPIC_NAME_MAX} ký tự.` };
  }
  return name;
}

async function idByName(db: Db, name: string): Promise<number> {
  const [row] = await db.select<{ id: number }>("SELECT id FROM topics WHERE name = ?", [name]);
  return row.id;
}
