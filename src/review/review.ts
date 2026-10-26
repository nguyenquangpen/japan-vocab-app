import type { Db } from "../db/db";
import type { Settings } from "../settings/settings";
import { isKana } from "../vocab/text";
import { State, gradeCard, newCardState, type CardState, type Grade, type Skill } from "./scheduler";

/**
 * Ôn tập chính (docs/design.md mục 4). Chỉ từ có đủ cách đọc và nghĩa mới có thẻ và vào phiên ôn.
 * Mỗi lần chấm ghi 2 câu: cập nhật thẻ rồi ghi review_logs.
 */

export interface ReviewItem {
  cardId: number;
  wordId: number;
  skill: Skill;
  card: CardState;
  term: string;
  reading: string;
  meanings: string[];
  example: { ja: string; vi: string | null } | null;
  /** Thẻ reading của từ này đã được học (thẻ meaning hiện kèm cách đọc). */
  readingLearned: boolean;
  /** Từ chỉ viết bằng kana: thẻ reading hiện nghĩa và bắt gõ lại từ. */
  kanaOnly: boolean;
}

export interface ReviewOverview {
  /** Từ chưa đủ cách đọc hoặc nghĩa nên chưa vào ôn. */
  notReady: number;
  /** Hạn gần nhất của thẻ đã học (ISO), null nếu chưa có. */
  nextDue: string | null;
}

/** Thẻ đến hạn trong khoảng này sau khi chấm thì được xếp lại cuối phiên. */
export const LEARN_AHEAD_MINUTES = 20;

const READY = "w.reading IS NOT NULL AND w.meanings_vi IS NOT NULL";

/** Tạo thẻ còn thiếu cho mọi từ đủ điều kiện. Chạy lại nhiều lần vẫn an toàn. Trả về số thẻ mới tạo. */
export async function ensureCards(db: Db, now = new Date()): Promise<number> {
  const c = newCardState(now);
  const { rowsAffected } = await db.execute(
    `INSERT OR IGNORE INTO cards (word_id, skill, due, stability, difficulty, elapsed_days,
       scheduled_days, learning_steps, reps, lapses, state, last_review)
     SELECT w.id, s.skill, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
     FROM words w CROSS JOIN (SELECT 'meaning' AS skill UNION ALL SELECT 'reading') s
     WHERE ${READY}`,
    [c.due, c.stability, c.difficulty, c.elapsedDays, c.scheduledDays, c.learningSteps, c.reps, c.lapses, c.state],
  );
  return rowsAffected;
}

/** Phiên ôn: thẻ đến hạn (sớm nhất trước), sau đó thẻ của các từ mới trong giới hạn mỗi ngày. */
export async function loadSession(db: Db, settings: Settings, now = new Date()): Promise<ReviewItem[]> {
  await ensureCards(db, now);

  const maxReviews = Math.max(0, Math.trunc(settings.maxReviewsPerSession));
  const due = await db.select<ItemRow>(
    `${ITEM_SELECT} WHERE c.state != ? AND c.due <= ? AND ${READY}
     ORDER BY c.due, c.id LIMIT ${maxReviews}`,
    [State.New, now.toISOString()],
  );

  const [{ n: introducedToday }] = await db.select<{ n: number }>(
    `SELECT COUNT(DISTINCT c.word_id) AS n FROM cards c
     WHERE (SELECT MIN(l.reviewed_at) FROM review_logs l WHERE l.card_id = c.id) >= ?`,
    [startOfLocalDay(now).toISOString()],
  );
  const remaining = Math.max(0, Math.trunc(settings.newPerDay) - introducedToday);

  let fresh: ItemRow[] = [];
  if (remaining > 0) {
    fresh = await db.select<ItemRow>(
      `${ITEM_SELECT} WHERE c.state = ? AND ${READY} AND w.id IN (
         SELECT w2.id FROM words w2
         WHERE w2.reading IS NOT NULL AND w2.meanings_vi IS NOT NULL
           AND EXISTS (SELECT 1 FROM cards c2 WHERE c2.word_id = w2.id AND c2.state = ?)
         ORDER BY w2.created_at, w2.id LIMIT ${remaining})
       ORDER BY w.created_at, w.id`,
      [State.New, State.New],
    );
  }

  return [...due.map(toItem), ...orderNewCards(fresh.map(toItem))];
}

/** Chấm 1 thẻ, ghi DB, trả về thẻ sau khi chấm. */
export async function submitReview(
  db: Db,
  item: ReviewItem,
  rating: Grade,
  answer: string | null,
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
    "INSERT INTO review_logs (card_id, rating, answer, correct, reviewed_at) VALUES (?, ?, ?, ?, ?)",
    [item.cardId, rating, answer, correct ? 1 : 0, now.toISOString()],
  );
  return { ...item, card: c, readingLearned: item.readingLearned || item.skill === "reading" };
}

/**
 * Hàng đợi sau khi chấm thẻ đầu: bỏ thẻ đầu, cập nhật thẻ cùng từ, xếp lại cuối
 * nếu thẻ đến hạn trong LEARN_AHEAD_MINUTES.
 */
export function advanceQueue(queue: ReviewItem[], graded: ReviewItem, now: Date): ReviewItem[] {
  const rest = queue
    .slice(1)
    .map((i) => (i.wordId === graded.wordId ? { ...i, readingLearned: graded.readingLearned } : i));
  const soon = new Date(graded.card.due).getTime() <= now.getTime() + LEARN_AHEAD_MINUTES * 60_000;
  return soon ? [...rest, graded] : rest;
}

export async function getReviewOverview(db: Db): Promise<ReviewOverview> {
  const [{ n }] = await db.select<{ n: number }>(
    "SELECT COUNT(*) AS n FROM words WHERE reading IS NULL OR meanings_vi IS NULL",
  );
  const [next] = await db.select<{ due: string | null }>(
    "SELECT MIN(due) AS due FROM cards WHERE state != ?",
    [State.New],
  );
  return { notReady: n, nextDue: next?.due ?? null };
}

const ITEM_SELECT = `
  SELECT c.id AS card_id, c.word_id, c.skill, c.due, c.stability, c.difficulty, c.elapsed_days,
    c.scheduled_days, c.learning_steps, c.reps, c.lapses, c.state, c.last_review,
    w.term, w.reading, w.meanings_vi,
    (SELECT r.state FROM cards r WHERE r.word_id = w.id AND r.skill = 'reading') AS reading_state,
    (SELECT e.ja FROM examples e WHERE e.word_id = w.id ORDER BY e.id LIMIT 1) AS example_ja,
    (SELECT e.vi FROM examples e WHERE e.word_id = w.id ORDER BY e.id LIMIT 1) AS example_vi
  FROM cards c JOIN words w ON w.id = c.word_id`;

interface ItemRow {
  card_id: number;
  word_id: number;
  skill: Skill;
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
  reading: string;
  meanings_vi: string;
  reading_state: number | null;
  example_ja: string | null;
  example_vi: string | null;
}

function toItem(row: ItemRow): ReviewItem {
  return {
    cardId: row.card_id,
    wordId: row.word_id,
    skill: row.skill,
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
    example: row.example_ja ? { ja: row.example_ja, vi: row.example_vi } : null,
    readingLearned: row.reading_state !== null && row.reading_state !== State.New,
    kanaOnly: isKana(row.term),
  };
}

/**
 * Thẻ mới: reading trước meaning (mặt sau thẻ meaning lộ cách đọc).
 * Từ toàn kana thì ngược lại (thẻ reading của chúng lộ nghĩa).
 */
function orderNewCards(items: ReviewItem[]): ReviewItem[] {
  const rank = (i: ReviewItem) => {
    if (!i.kanaOnly) return i.skill === "reading" ? 0 : 1;
    return i.skill === "meaning" ? 1 : 2;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
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
