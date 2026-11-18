import type { Db } from "../db/db";
import type { Settings } from "../settings/settings";
import { isKana } from "../vocab/text";
import { MASTERED_STABILITY, State, gradeCard, newCardState, type CardState, type Grade } from "./scheduler";

/**
 * Ôn tập bằng flashcard (docs/design.md mục 4). Mỗi từ có nghĩa = 1 thẻ `meaning`:
 * mặt trước chữ Hán + kana, mặt sau nghĩa + ví dụ, tự chấm Quên/Nhớ.
 *
 * Mỗi từ có 3 trạng thái (`wordStatus`): Mới (chưa ôn) → Đang học → Vững (stability ≥ 21 ngày).
 *
 * - "Ôn hôm nay" (mở app là chạy) và "Học thêm từ mới" chấm qua FSRS (`submitReview`), quyết định lịch.
 * - Ôn lại từ vừa quên, Ôn từ vựng cũ, Luyện tự do: chỉ luyện, không ghi DB, không đổi lịch.
 * - Thẻ `reading` cũ (bản có thẻ gõ cách đọc) vẫn nằm trong DB nhưng không còn được ôn.
 */

export interface ReviewItem {
  cardId: number;
  wordId: number;
  card: CardState;
  term: string;
  reading: string | null;
  meanings: string[];
  /** Ví dụ đầu tiên của từ: câu tiếng Nhật, cách đọc (kana), nghĩa. */
  example: { ja: string; reading: string | null; vi: string | null } | null;
  meaningDetail: string | null;
  /** Từ chỉ viết bằng kana: không lặp lại dòng kana dưới chữ Hán. */
  kanaOnly: boolean;
}

export type WordStatus = "new" | "learning" | "mastered";

export function wordStatus(card: CardState): WordStatus {
  if (card.state === State.New) return "new";
  return card.stability >= MASTERED_STABILITY ? "mastered" : "learning";
}

export interface ReviewOverview {
  /** Từ chưa có nghĩa nên chưa vào ôn. */
  notReady: number;
  /** Thẻ đã học đang đến hạn. */
  dueNow: number;
  /** Từ mới (chưa ôn lần nào). */
  newLeft: number;
  /** Số từ mới còn được học hôm nay theo `newPerDay`. */
  newTodayLeft: number;
  /** Từ đã ôn ít nhất 1 lần (Đang học + Vững). */
  learned: number;
  /** Trong số đã học, bao nhiêu từ Vững. */
  mastered: number;
  /** Đợt ôn theo lịch tiếp theo: ngày (giờ máy, YYYY-MM-DD) và số từ đến hạn ngày đó. null nếu chưa có từ đã học. */
  nextDue: { date: string; count: number } | null;
}

/** Số ngẫu nhiên trong [0, 1). Truyền vào để test cố định được. */
export type Rng = () => number;

const READY = "w.meanings_vi IS NOT NULL";

/** Phạm vi ôn: toàn bộ vốn từ, các từ thuộc 1 trong các chủ đề đã chọn, hoặc từ chưa gắn chủ đề nào. */
export type ReviewScope = { kind: "all" } | { kind: "topics"; topicIds: number[] } | { kind: "noTopic" };

export const ALL_WORDS: ReviewScope = { kind: "all" };

/** Điều kiện SQL (trên bảng words bí danh `w`) + tham số cho phạm vi. */
function scopeSql(scope: ReviewScope): { sql: string; params: unknown[] } {
  if (scope.kind === "noTopic") {
    return { sql: "NOT EXISTS (SELECT 1 FROM word_topics wt WHERE wt.word_id = w.id)", params: [] };
  }
  if (scope.kind === "topics") {
    const ids = [...new Set(scope.topicIds)];
    if (ids.length === 0) return { sql: "0 = 1", params: [] };
    return {
      sql: `EXISTS (SELECT 1 FROM word_topics wt WHERE wt.word_id = w.id AND wt.topic_id IN (${ids.map(() => "?").join(", ")}))`,
      params: ids,
    };
  }
  return { sql: "1 = 1", params: [] };
}

/** Tạo thẻ meaning còn thiếu cho mọi từ có nghĩa. Chạy lại nhiều lần vẫn an toàn. Trả về số thẻ mới tạo. */
export async function ensureCards(db: Db, now = new Date()): Promise<number> {
  const c = newCardState(now);
  const { rowsAffected } = await db.execute(
    `INSERT OR IGNORE INTO cards (word_id, skill, due, stability, difficulty, elapsed_days,
       scheduled_days, learning_steps, reps, lapses, state, last_review)
     SELECT w.id, 'meaning', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
     FROM words w WHERE ${READY}`,
    [c.due, c.stability, c.difficulty, c.elapsedDays, c.scheduledDays, c.learningSteps, c.reps, c.lapses, c.state],
  );
  return rowsAffected;
}

/**
 * "Ôn hôm nay": tối đa `sessionSize` thẻ. Từ đến hạn trước (hạn sớm nhất trước), còn chỗ thì bù
 * từ mới — **mới thêm nhất trước** — trong giới hạn `newPerDay` của hôm nay (giới hạn chung, không theo phạm vi).
 */
export async function loadTodayRound(
  db: Db,
  settings: Settings,
  now = new Date(),
  scope: ReviewScope = ALL_WORDS,
): Promise<ReviewItem[]> {
  await ensureCards(db, now);
  const size = roundSize(settings);
  const s = scopeSql(scope);
  const due = await db.select<ItemRow>(
    `${ITEM_SELECT} WHERE c.state != ? AND c.due <= ? AND ${READY} AND ${s.sql}
     ORDER BY c.due, c.id LIMIT ${size}`,
    [State.New, now.toISOString(), ...s.params],
  );
  const newCount = Math.min(size - due.length, await newTodayLeft(db, settings, now));
  return [...due, ...(await selectNew(db, newCount, scope))].map(toItem);
}

/** "Học thêm từ mới": tối đa `sessionSize` từ mới tiếp theo (mới thêm nhất trước), vượt giới hạn mỗi ngày. */
export async function loadNewRound(
  db: Db,
  settings: Settings,
  now = new Date(),
  scope: ReviewScope = ALL_WORDS,
): Promise<ReviewItem[]> {
  await ensureCards(db, now);
  return (await selectNew(db, roundSize(settings), scope)).map(toItem);
}

/**
 * Từ có nghĩa trong phạm vi, dùng cho luyện (không đổi lịch).
 * - `learnedOnly`: chỉ từ đã ôn ít nhất 1 lần (cho "Ôn từ vựng cũ").
 * - `includeMastered = false`: bỏ từ Vững (mặc định của "Luyện tự do").
 */
export async function loadPracticePool(
  db: Db,
  options: { scope?: ReviewScope; learnedOnly?: boolean; includeMastered?: boolean } = {},
  now = new Date(),
): Promise<ReviewItem[]> {
  await ensureCards(db, now);
  const s = scopeSql(options.scope ?? ALL_WORDS);
  const where = [READY, s.sql];
  const params: unknown[] = [...s.params];
  if (options.learnedOnly) {
    where.push("c.state != ?");
    params.push(State.New);
  }
  if (options.includeMastered === false) {
    where.push("(c.state = ? OR c.stability < ?)");
    params.push(State.New, MASTERED_STABILITY);
  }
  const rows = await db.select<ItemRow>(`${ITEM_SELECT} WHERE ${where.join(" AND ")} ORDER BY c.id`, params);
  return rows.map(toItem);
}

export function shuffle<T>(items: T[], rng: Rng = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Chấm 1 thẻ qua FSRS, ghi DB, trả về thẻ sau khi chấm. */
export async function submitReview(
  db: Db,
  item: ReviewItem,
  rating: Grade,
  correct: boolean,
  now = new Date(),
): Promise<ReviewItem> {
  const c = gradeCard(item.card, rating, now);
  await db.execute(
    `UPDATE cards SET due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?,
       learning_steps = ?, reps = ?, lapses = ?, state = ?, last_review = ?
     WHERE id = ?`,
    [c.due, c.stability, c.difficulty, c.elapsedDays, c.scheduledDays, c.learningSteps, c.reps, c.lapses, c.state, c.lastReview, item.cardId],
  );
  await db.execute(
    "INSERT INTO review_logs (card_id, rating, answer, correct, reviewed_at) VALUES (?, ?, NULL, ?, ?)",
    [item.cardId, rating, correct ? 1 : 0, now.toISOString()],
  );
  return { ...item, card: c };
}

/** Các con số trong phạm vi (trừ giới hạn từ mới mỗi ngày là chung cho mọi phạm vi). */
export async function getReviewOverview(
  db: Db,
  settings: Settings,
  now = new Date(),
  scope: ReviewScope = ALL_WORDS,
): Promise<ReviewOverview> {
  await ensureCards(db, now);
  const s = scopeSql(scope);
  const cardsIn = `FROM cards c JOIN words w ON w.id = c.word_id WHERE c.skill = 'meaning' AND ${READY} AND ${s.sql}`;
  const [row] = await db.select<{
    not_ready: number;
    due_now: number;
    new_left: number;
    learned: number;
    mastered: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM words w WHERE w.meanings_vi IS NULL AND ${s.sql}) AS not_ready,
       (SELECT COUNT(*) ${cardsIn} AND c.state != ? AND c.due <= ?) AS due_now,
       (SELECT COUNT(*) ${cardsIn} AND c.state = ?) AS new_left,
       (SELECT COUNT(*) ${cardsIn} AND c.state != ?) AS learned,
       (SELECT COUNT(*) ${cardsIn} AND c.state != ? AND c.stability >= ?) AS mastered`,
    [
      ...s.params,
      ...s.params, State.New, now.toISOString(),
      ...s.params, State.New,
      ...s.params, State.New,
      ...s.params, State.New, MASTERED_STABILITY,
    ],
  );

  // Đợt tiếp theo: ngày (giờ máy) của hạn sớm nhất còn ở tương lai, và số từ đến hạn trong ngày đó.
  const upcoming = await db.select<{ due: string }>(
    `SELECT c.due ${cardsIn} AND c.state != ? AND c.due > ? ORDER BY c.due`,
    [...s.params, State.New, now.toISOString()],
  );
  let nextDue: ReviewOverview["nextDue"] = null;
  if (upcoming.length > 0) {
    const date = localDate(new Date(upcoming[0].due));
    nextDue = { date, count: upcoming.filter((u) => localDate(new Date(u.due)) === date).length };
  }

  return {
    notReady: row.not_ready,
    dueNow: row.due_now,
    newLeft: row.new_left,
    newTodayLeft: Math.min(row.new_left, await newTodayLeft(db, settings, now)),
    learned: row.learned,
    mastered: row.mastered,
    nextDue,
  };
}

function roundSize(settings: Settings): number {
  return Math.max(1, Math.trunc(settings.sessionSize));
}

/** Số từ mới còn được học hôm nay: `newPerDay` trừ số thẻ học lần đầu từ 0 giờ hôm nay (giờ máy). */
async function newTodayLeft(db: Db, settings: Settings, now: Date): Promise<number> {
  const [{ n }] = await db.select<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cards c
     WHERE c.skill = 'meaning'
       AND (SELECT MIN(l.reviewed_at) FROM review_logs l WHERE l.card_id = c.id) >= ?`,
    [startOfLocalDay(now).toISOString()],
  );
  return Math.max(0, Math.trunc(settings.newPerDay) - n);
}

/** Từ mới, mới thêm nhất trước. */
async function selectNew(db: Db, count: number, scope: ReviewScope): Promise<ItemRow[]> {
  if (count <= 0) return [];
  const s = scopeSql(scope);
  return db.select<ItemRow>(
    `${ITEM_SELECT} WHERE c.state = ? AND ${READY} AND ${s.sql}
     ORDER BY w.created_at DESC, w.id DESC LIMIT ${Math.trunc(count)}`,
    [State.New, ...s.params],
  );
}

const ITEM_SELECT = `
  SELECT c.id AS card_id, c.word_id, c.due, c.stability, c.difficulty, c.elapsed_days,
    c.scheduled_days, c.learning_steps, c.reps, c.lapses, c.state, c.last_review,
    w.term, w.reading, w.meanings_vi, w.meaning_detail,
    (SELECT e.ja FROM examples e WHERE e.word_id = w.id ORDER BY e.id LIMIT 1) AS example_ja,
    (SELECT e.reading FROM examples e WHERE e.word_id = w.id ORDER BY e.id LIMIT 1) AS example_reading,
    (SELECT e.vi FROM examples e WHERE e.word_id = w.id ORDER BY e.id LIMIT 1) AS example_vi
  FROM cards c JOIN words w ON w.id = c.word_id AND c.skill = 'meaning'`;

interface ItemRow {
  card_id: number;
  word_id: number;
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: string | null;
  term: string;
  reading: string | null;
  meanings_vi: string;
  meaning_detail: string | null;
  example_ja: string | null;
  example_reading: string | null;
  example_vi: string | null;
}

function toItem(row: ItemRow): ReviewItem {
  return {
    cardId: row.card_id,
    wordId: row.word_id,
    card: {
      due: row.due,
      stability: row.stability,
      difficulty: row.difficulty,
      elapsedDays: row.elapsed_days,
      scheduledDays: row.scheduled_days,
      learningSteps: row.learning_steps,
      reps: row.reps,
      lapses: row.lapses,
      state: row.state as State,
      lastReview: row.last_review,
    },
    term: row.term,
    reading: row.reading,
    meanings: parseMeanings(row.meanings_vi),
    example: row.example_ja ? { ja: row.example_ja, reading: row.example_reading, vi: row.example_vi } : null,
    meaningDetail: row.meaning_detail,
    kanaOnly: isKana(row.term),
  };
}

function parseMeanings(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
