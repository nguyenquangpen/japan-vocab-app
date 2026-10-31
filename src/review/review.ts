import type { Db } from "../db/db";
import type { Settings } from "../settings/settings";
import { isKana } from "../vocab/text";
import { State, gradeCard, newCardState, retrievability, type CardState, type Grade } from "./scheduler";

/**
 * Ôn tập bằng flashcard (docs/design.md mục 4). Mỗi từ có nghĩa = 1 thẻ `meaning`:
 * mặt trước chữ Hán + kana, mặt sau nghĩa + ví dụ, tự chấm Quên/Nhớ.
 *
 * - Lượt chính và lượt "học thêm từ mới" chấm qua FSRS (`submitReview`).
 * - Lượt luyện thêm (ôn lại từ quên, luyện ngẫu nhiên, luyện lại toàn bộ) không ghi DB.
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

export interface ReviewOverview {
  /** Từ chưa có nghĩa nên chưa vào ôn. */
  notReady: number;
  /** Hạn gần nhất của thẻ đã học (ISO), null nếu chưa có. */
  nextDue: string | null;
  /** Thẻ đã học đang đến hạn. */
  dueNow: number;
  /** Thẻ chưa học lần nào. */
  newLeft: number;
  /** Số từ mới còn được học hôm nay theo `newPerDay`. */
  newTodayLeft: number;
  /** Toàn bộ thẻ trong vốn từ (từ có nghĩa), dùng cho luyện thêm. */
  total: number;
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
 * Lượt chính: tối đa `sessionSize` thẻ. Thẻ đến hạn trước (hạn sớm nhất trước),
 * còn chỗ thì bù từ mới (cũ nhất trước) trong giới hạn `newPerDay` của hôm nay (giới hạn chung, không theo phạm vi).
 */
export async function loadMainRound(
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

/** Lượt "học thêm từ mới": tối đa `sessionSize` từ mới tiếp theo trong phạm vi, vượt giới hạn mỗi ngày. */
export async function loadNewRound(
  db: Db,
  settings: Settings,
  now = new Date(),
  scope: ReviewScope = ALL_WORDS,
): Promise<ReviewItem[]> {
  await ensureCards(db, now);
  return (await selectNew(db, roundSize(settings), scope)).map(toItem);
}

/** Mọi từ có nghĩa trong phạm vi (kể cả từ chưa ôn lần nào), dùng cho luyện thêm. */
export async function loadPracticePool(db: Db, now = new Date(), scope: ReviewScope = ALL_WORDS): Promise<ReviewItem[]> {
  await ensureCards(db, now);
  const s = scopeSql(scope);
  const rows = await db.select<ItemRow>(`${ITEM_SELECT} WHERE ${READY} AND ${s.sql} ORDER BY c.id`, s.params);
  return rows.map(toItem);
}

/**
 * Trọng số luyện thêm: khả năng quên hiện tại (1 − R) + độ "non" của thẻ (1 / (1 + stability)) + sàn 0.05.
 * Từ chưa ôn ≈ 2; thẻ yếu/mới học ≈ 0.5–1.5; thẻ đã thuộc (stability cao, vừa ôn) ≈ 0.05–0.2.
 */
export function practiceWeight(card: CardState, now: Date): number {
  return 0.05 + (1 - retrievability(card, now)) + 1 / (1 + Math.max(0, card.stability));
}

/**
 * Chọn ngẫu nhiên `size` thẻ để luyện, không lặp. Thẻ càng yếu càng hay được chọn;
 * thẻ đã thuộc vẫn có thể ra nhưng hiếm hơn nhiều.
 * Thẻ trong `avoid` (vd. lượt ngay trước) chỉ được chọn khi các thẻ khác không đủ.
 */
export function pickPractice(
  pool: ReviewItem[],
  size: number,
  now: Date,
  rng: Rng = Math.random,
  avoid: ReadonlySet<number> = new Set(),
): ReviewItem[] {
  const ranked = (items: ReviewItem[]) =>
    items
      .map((item) => {
        const weight = practiceWeight(item.card, now);
        // Efraimidis–Spirakis: khóa = u^(1/w), lấy các khóa lớn nhất.
        return { item, key: Math.pow(Math.max(rng(), Number.MIN_VALUE), 1 / weight) };
      })
      .sort((a, b) => b.key - a.key)
      .map(({ item }) => item);
  const fresh = ranked(pool.filter((i) => !avoid.has(i.cardId)));
  const repeat = ranked(pool.filter((i) => avoid.has(i.cardId)));
  return [...fresh, ...repeat].slice(0, Math.max(0, size));
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
  const cardsIn = `FROM cards c JOIN words w ON w.id = c.word_id WHERE c.skill = 'meaning' AND ${s.sql}`;
  const [row] = await db.select<{
    not_ready: number;
    next_due: string | null;
    due_now: number;
    new_left: number;
    total: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM words w WHERE w.meanings_vi IS NULL AND ${s.sql}) AS not_ready,
       (SELECT MIN(c.due) ${cardsIn} AND c.state != ?) AS next_due,
       (SELECT COUNT(*) ${cardsIn} AND c.state != ? AND c.due <= ? AND ${READY}) AS due_now,
       (SELECT COUNT(*) ${cardsIn} AND c.state = ? AND ${READY}) AS new_left,
       (SELECT COUNT(*) ${cardsIn} AND ${READY}) AS total`,
    [
      ...s.params,
      ...s.params, State.New,
      ...s.params, State.New, now.toISOString(),
      ...s.params, State.New,
      ...s.params,
    ],
  );
  return {
    notReady: row.not_ready,
    nextDue: row.next_due,
    dueNow: row.due_now,
    newLeft: row.new_left,
    newTodayLeft: Math.min(row.new_left, await newTodayLeft(db, settings, now)),
    total: row.total,
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

async function selectNew(db: Db, count: number, scope: ReviewScope): Promise<ItemRow[]> {
  if (count <= 0) return [];
  const s = scopeSql(scope);
  return db.select<ItemRow>(
    `${ITEM_SELECT} WHERE c.state = ? AND ${READY} AND ${s.sql}
     ORDER BY w.created_at, w.id LIMIT ${Math.trunc(count)}`,
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
