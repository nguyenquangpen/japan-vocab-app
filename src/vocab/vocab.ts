import type { Db } from "../db/db";
import { MASTERED_STABILITY } from "../review/scheduler";
import {
  cleanWord,
  normalizeText,
  optionalText,
  parseBatchLine,
  splitMeanings,
  type CleanWord,
} from "./text";

/**
 * Kho từ. Mọi chuẩn hóa (NFKC), kiểm tra hợp lệ và chống trùng nằm ở đây.
 *
 * Trùng = cùng `term` (sau chuẩn hóa) và cách đọc giống nhau hoặc một bên chưa có cách đọc.
 * Mỗi hàm ghi đúng 1 câu lệnh SQL nên không cần transaction (xem docs/design.md mục 11).
 * Thẻ ôn tập chưa tạo ở đây (giai đoạn 4).
 */

export interface WordSummary {
  id: number;
  term: string;
  reading: string | null;
  meanings: string[];
  enriched: boolean;
  /** Cả 2 thẻ có stability >= MASTERED_STABILITY. */
  mastered: boolean;
}

export interface WordDetail extends WordSummary {
  partOfSpeech: string | null;
  usageNote: string | null;
  userNote: string | null;
  /** Nghĩa mở rộng, chỉ tôi tự nhập (AI không điền). Giữ xuống dòng. */
  meaningDetail: string | null;
  confusables: { term: string; note: string }[];
  examples: { id: number; ja: string; reading: string | null; vi: string | null }[];
  createdAt: string;
  updatedAt: string;
}

export interface NewWord {
  term: string;
  reading?: string;
  /** Nhiều nghĩa ngăn bởi `,` hoặc `;`. */
  meanings?: string;
  userNote?: string;
}

export interface WordEdit {
  term: string;
  reading: string;
  meanings: string[];
  partOfSpeech: string;
  usageNote: string;
  userNote: string;
  meaningDetail: string;
}

export type AddResult =
  | { status: "added"; wordId: number }
  | { status: "duplicate"; wordId: number }
  | { status: "invalid"; message: string };

export interface BatchResult {
  added: { lineNo: number; term: string; wordId: number }[];
  duplicates: { lineNo: number; term: string; wordId: number }[];
  invalid: { lineNo: number; line: string; message: string }[];
}

export type UpdateResult =
  | { status: "updated" }
  | { status: "duplicate"; wordId: number }
  | { status: "invalid"; message: string }
  | { status: "not_found" };

/** pending = chờ bổ sung, learning = đã bổ sung nhưng chưa vững, mastered = vững. */
export type WordStatus = "pending" | "learning" | "mastered";

export type WordSort = "newest" | "oldest" | "kana" | "due" | "mistakes";

export interface WordFilter {
  query?: string;
  status?: WordStatus;
  /** "none" = từ chưa gắn chủ đề nào. */
  topicId?: number | "none";
  sort?: WordSort;
}

// Chỉ ghép chuỗi từ danh sách cố định này, không bao giờ từ dữ liệu người dùng.
const ORDER_BY: Record<WordSort, string> = {
  newest: "created_at DESC, id DESC",
  oldest: "created_at ASC, id ASC",
  kana: "COALESCE(reading, term) ASC, id ASC",
  due: `(SELECT MIN(c.due) FROM cards c WHERE c.word_id = words.id AND c.state != 0) IS NULL,
        (SELECT MIN(c.due) FROM cards c WHERE c.word_id = words.id AND c.state != 0) ASC, id ASC`,
  mistakes: `(SELECT COUNT(*) FROM review_logs l JOIN cards c ON c.id = l.card_id
              WHERE c.word_id = words.id AND l.correct = 0) DESC, created_at DESC, id DESC`,
};

const MASTERED_SQL = `(
  (SELECT COUNT(*) FROM cards c WHERE c.word_id = words.id) = 2
  AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.word_id = words.id AND c.stability < ${MASTERED_STABILITY})
)`;

// Điều kiện trùng, tham số: term, reading, reading.
const SAME_WORD = "term = ? AND (reading IS NULL OR ? IS NULL OR reading = ?)";

export async function addWord(db: Db, input: NewWord, now = new Date()): Promise<AddResult> {
  const cleaned = cleanWord({
    term: input.term,
    reading: input.reading,
    meanings: splitMeanings(input.meanings),
    userNote: input.userNote,
  });
  if (!cleaned.ok) return { status: "invalid", message: cleaned.message };
  return insertWord(db, cleaned.word, now);
}

/** Mỗi dòng 1 từ: `term`, `term reading` hoặc `term | reading | nghĩa`. */
export async function addWordsBatch(db: Db, text: string, now = new Date()): Promise<BatchResult> {
  const result: BatchResult = { added: [], duplicates: [], invalid: [] };
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    const parsed = parseBatchLine(line);
    if (parsed === null) continue;
    if ("error" in parsed) {
      result.invalid.push({ lineNo, line, message: parsed.error });
      continue;
    }
    const cleaned = cleanWord(parsed);
    if (!cleaned.ok) {
      result.invalid.push({ lineNo, line, message: cleaned.message });
      continue;
    }
    const inserted = await insertWord(db, cleaned.word, now);
    if (inserted.status === "added") {
      result.added.push({ lineNo, term: cleaned.word.term, wordId: inserted.wordId });
    }
    if (inserted.status === "duplicate") {
      result.duplicates.push({ lineNo, term: cleaned.word.term, wordId: inserted.wordId });
    }
  }
  return result;
}

export async function listWords(db: Db, filter: WordFilter = {}): Promise<WordSummary[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  const query = normalizeText(filter.query ?? "");
  if (query !== "") {
    const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      "(term LIKE ? ESCAPE '\\' OR reading LIKE ? ESCAPE '\\' OR meanings_vi LIKE ? ESCAPE '\\')",
    );
    params.push(pattern, pattern, pattern);
  }
  if (filter.status === "pending") where.push("enriched = 0");
  if (filter.status === "learning") where.push(`enriched = 1 AND NOT ${MASTERED_SQL}`);
  if (filter.status === "mastered") where.push(MASTERED_SQL);
  if (filter.topicId === "none") {
    where.push("NOT EXISTS (SELECT 1 FROM word_topics wt WHERE wt.word_id = words.id)");
  } else if (filter.topicId !== undefined) {
    where.push("EXISTS (SELECT 1 FROM word_topics wt WHERE wt.word_id = words.id AND wt.topic_id = ?)");
    params.push(filter.topicId);
  }

  const rows = await db.select<WordRow>(
    `SELECT id, term, reading, meanings_vi, enriched, ${MASTERED_SQL} AS mastered FROM words
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY ${ORDER_BY[filter.sort ?? "newest"]}`,
    params,
  );
  return rows.map(toSummary);
}

export async function getWord(db: Db, id: number): Promise<WordDetail | null> {
  const [row] = await db.select<WordRow>(`SELECT *, ${MASTERED_SQL} AS mastered FROM words WHERE id = ?`, [id]);
  if (!row) return null;
  const examples = await db.select<ExampleRow>(
    "SELECT id, ja, reading, vi FROM examples WHERE word_id = ? ORDER BY id",
    [id],
  );
  return {
    ...toSummary(row),
    partOfSpeech: row.part_of_speech ?? null,
    usageNote: row.usage_note ?? null,
    userNote: row.user_note ?? null,
    meaningDetail: row.meaning_detail ?? null,
    confusables: parseJsonArray(row.confusables) as WordDetail["confusables"],
    examples,
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

export async function updateWord(
  db: Db,
  id: number,
  edit: WordEdit,
  now = new Date(),
): Promise<UpdateResult> {
  const cleaned = cleanWord(edit);
  if (!cleaned.ok) return { status: "invalid", message: cleaned.message };
  const w = cleaned.word;

  const { rowsAffected } = await db.execute(
    `UPDATE words SET term = ?, reading = ?, meanings_vi = ?, part_of_speech = ?,
       usage_note = ?, user_note = ?, meaning_detail = ?, updated_at = ?
     WHERE id = ? AND NOT EXISTS (SELECT 1 FROM words WHERE id != ? AND ${SAME_WORD})`,
    [
      w.term, w.reading, encodeMeanings(w.meanings), w.partOfSpeech, w.usageNote, w.userNote,
      w.meaningDetail, now.toISOString(), id, id, w.term, w.reading, w.reading,
    ],
  );
  if (rowsAffected > 0) return { status: "updated" };

  const [self] = await db.select<{ id: number }>("SELECT id FROM words WHERE id = ?", [id]);
  if (!self) return { status: "not_found" };
  return { status: "duplicate", wordId: (await findOtherSameWord(db, id, w)) ?? id };
}

async function findOtherSameWord(db: Db, id: number, w: CleanWord): Promise<number | null> {
  const [other] = await db.select<{ id: number }>(
    `SELECT id FROM words WHERE id != ? AND ${SAME_WORD} ORDER BY id LIMIT 1`,
    [id, w.term, w.reading, w.reading],
  );
  return other?.id ?? null;
}

export interface EnrichmentData {
  reading: string | null;
  meanings: string[];
  partOfSpeech: string | null;
  usageNote: string | null;
  confusables: { term: string; note: string }[];
  /** null = giữ nguyên ví dụ hiện có. */
  examples: { ja: string; reading: string | null; vi: string | null }[] | null;
}

/**
 * Ghi kết quả bổ sung (đã chọn trường) và đặt enriched = 1.
 * Thứ tự ghi để chạy lại được nếu lỗi giữa chừng: thay ví dụ trước, cập nhật từ sau cùng.
 */
export async function saveEnrichment(
  db: Db,
  id: number,
  data: EnrichmentData,
  now = new Date(),
): Promise<UpdateResult> {
  const [row] = await db.select<{ term: string }>("SELECT term FROM words WHERE id = ?", [id]);
  if (!row) return { status: "not_found" };

  const cleaned = cleanWord({
    term: row.term,
    reading: data.reading,
    meanings: data.meanings,
    partOfSpeech: data.partOfSpeech,
    usageNote: data.usageNote,
  });
  if (!cleaned.ok) return { status: "invalid", message: cleaned.message };
  const w = cleaned.word;

  const duplicate = await findOtherSameWord(db, id, w);
  if (duplicate !== null) return { status: "duplicate", wordId: duplicate };

  if (data.examples !== null) {
    await db.execute("DELETE FROM examples WHERE word_id = ?", [id]);
    const examples = data.examples
      .map((e) => ({ ja: normalizeText(e.ja), reading: optionalText(e.reading), vi: optionalText(e.vi) }))
      .filter((e) => e.ja !== "");
    if (examples.length > 0) {
      await db.execute(
        `INSERT INTO examples (word_id, ja, reading, vi) VALUES ${examples.map(() => "(?, ?, ?, ?)").join(", ")}`,
        examples.flatMap((e) => [id, e.ja, e.reading, e.vi]),
      );
    }
  }

  const confusables = data.confusables
    .map((c) => ({ term: normalizeText(c.term), note: normalizeText(c.note) }))
    .filter((c) => c.term !== "");

  const { rowsAffected } = await db.execute(
    `UPDATE words SET reading = ?, meanings_vi = ?, part_of_speech = ?, usage_note = ?,
       confusables = ?, enriched = 1, updated_at = ?
     WHERE id = ? AND NOT EXISTS (SELECT 1 FROM words WHERE id != ? AND ${SAME_WORD})`,
    [
      w.reading, encodeMeanings(w.meanings), w.partOfSpeech, w.usageNote,
      confusables.length > 0 ? JSON.stringify(confusables) : null, now.toISOString(),
      id, id, w.term, w.reading, w.reading,
    ],
  );
  if (rowsAffected > 0) return { status: "updated" };
  return { status: "duplicate", wordId: (await findOtherSameWord(db, id, w)) ?? id };
}

/** Xóa từ, kéo theo ví dụ, thẻ, lịch sử ôn và liên kết chủ đề. Trả về false nếu không có từ. */
export async function deleteWord(db: Db, id: number): Promise<boolean> {
  const { rowsAffected } = await db.execute("DELETE FROM words WHERE id = ?", [id]);
  return rowsAffected > 0;
}

async function insertWord(db: Db, w: CleanWord, now: Date): Promise<AddResult> {
  const timestamp = now.toISOString();
  const { rowsAffected, lastInsertId } = await db.execute(
    `INSERT INTO words (term, reading, meanings_vi, part_of_speech, usage_note, user_note,
       enriched, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, 0, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM words WHERE ${SAME_WORD})`,
    [
      w.term, w.reading, encodeMeanings(w.meanings), w.partOfSpeech, w.usageNote, w.userNote,
      timestamp, timestamp, w.term, w.reading, w.reading,
    ],
  );
  if (rowsAffected > 0 && lastInsertId !== undefined) return { status: "added", wordId: lastInsertId };

  const [existing] = await db.select<{ id: number }>(
    `SELECT id FROM words WHERE ${SAME_WORD} ORDER BY id LIMIT 1`,
    [w.term, w.reading, w.reading],
  );
  return { status: "duplicate", wordId: existing.id };
}

interface WordRow {
  id: number;
  term: string;
  reading: string | null;
  meanings_vi: string | null;
  enriched: number;
  mastered: number;
  part_of_speech?: string | null;
  usage_note?: string | null;
  user_note?: string | null;
  meaning_detail?: string | null;
  confusables?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface ExampleRow {
  id: number;
  ja: string;
  reading: string | null;
  vi: string | null;
}

function toSummary(row: WordRow): WordSummary {
  return {
    id: row.id,
    term: row.term,
    reading: row.reading,
    meanings: parseJsonArray(row.meanings_vi).filter((m): m is string => typeof m === "string"),
    enriched: row.enriched === 1,
    mastered: row.mastered === 1,
  };
}

function encodeMeanings(meanings: string[]): string | null {
  return meanings.length > 0 ? JSON.stringify(meanings) : null;
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
