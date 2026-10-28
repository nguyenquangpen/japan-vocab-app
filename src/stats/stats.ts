import type { Db } from "../db/db";
import { MASTERED_STABILITY, State } from "../review/scheduler";
import { listTopics } from "../topics/topics";

// Số liệu cho tab Thống kê. Chỉ đọc.

export interface DayStat {
  /** Ngày theo giờ máy, dạng YYYY-MM-DD. */
  date: string;
  total: number;
  correct: number;
}

export interface HardWord {
  wordId: number;
  term: string;
  reading: string | null;
  wrong: number;
  total: number;
}

export interface VocabStats {
  totalWords: number;
  pending: number;
  learning: number;
  mastered: number;
  /** Từ chưa đủ cách đọc hoặc nghĩa nên chưa vào ôn. */
  notReady: number;
  /** Thẻ đã học đến hạn trước hết hôm nay. */
  dueToday: number;
  /** 7 ngày gần nhất, cũ → mới. */
  days: DayStat[];
  topics: { id: number; name: string; count: number }[];
  noTopic: number;
  /** Tối đa 10 từ sai nhiều nhất (ít nhất 1 lần sai). */
  hardest: HardWord[];
}

export const STATS_DAYS = 7;

export async function loadStats(db: Db, now = new Date()): Promise<VocabStats> {
  const mastered = `(
    (SELECT COUNT(*) FROM cards c WHERE c.word_id = w.id) = 2
    AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.word_id = w.id AND c.stability < ${MASTERED_STABILITY})
  )`;
  const [counts] = await db.select<{
    total: number;
    pending: number;
    mastered: number;
    learning: number;
    not_ready: number;
    no_topic: number;
  }>(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(w.enriched = 0), 0) AS pending,
       COALESCE(SUM(${mastered}), 0) AS mastered,
       COALESCE(SUM(w.enriched = 1 AND NOT ${mastered}), 0) AS learning,
       COALESCE(SUM(w.reading IS NULL OR w.meanings_vi IS NULL), 0) AS not_ready,
       COALESCE(SUM(NOT EXISTS (SELECT 1 FROM word_topics wt WHERE wt.word_id = w.id)), 0) AS no_topic
     FROM words w`,
  );

  const today = startOfLocalDay(now);
  const tomorrow = addDays(today, 1);
  const [{ n: dueToday }] = await db.select<{ n: number }>(
    "SELECT COUNT(*) AS n FROM cards WHERE state != ? AND due < ?",
    [State.New, tomorrow.toISOString()],
  );

  const first = addDays(today, -(STATS_DAYS - 1));
  const logs = await db.select<{ reviewed_at: string; correct: number }>(
    "SELECT reviewed_at, correct FROM review_logs WHERE reviewed_at >= ?",
    [first.toISOString()],
  );
  const days: DayStat[] = Array.from({ length: STATS_DAYS }, (_, i) => ({
    date: localDate(addDays(first, i)),
    total: 0,
    correct: 0,
  }));
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const log of logs) {
    const day = byDate.get(localDate(new Date(log.reviewed_at)));
    if (!day) continue;
    day.total += 1;
    day.correct += log.correct;
  }

  const hardest = await db.select<{ word_id: number; term: string; reading: string | null; wrong: number; total: number }>(
    `SELECT w.id AS word_id, w.term, w.reading,
       SUM(l.correct = 0) AS wrong, COUNT(*) AS total
     FROM review_logs l JOIN cards c ON c.id = l.card_id JOIN words w ON w.id = c.word_id
     GROUP BY w.id HAVING wrong > 0
     ORDER BY wrong DESC, total ASC, w.id ASC LIMIT 10`,
  );

  const topics = await listTopics(db);

  return {
    totalWords: counts.total,
    pending: counts.pending,
    learning: counts.learning,
    mastered: counts.mastered,
    notReady: counts.not_ready,
    dueToday,
    days,
    topics: topics.map((t) => ({ id: t.id, name: t.name, count: t.wordCount })),
    noTopic: counts.no_topic,
    hardest: hardest.map((h) => ({ wordId: h.word_id, term: h.term, reading: h.reading, wrong: h.wrong, total: h.total })),
  };
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
