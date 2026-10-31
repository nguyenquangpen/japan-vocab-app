import { describe, expect, it } from "vitest";
import type { Db } from "../db/db";
import { createTestDb } from "../db/nodeSqliteDb";
import { loadMainRound, submitReview } from "../review/review";
import { Rating } from "../review/scheduler";
import { DEFAULT_SETTINGS } from "../settings/settings";
import { addWordsToTopic, createTopic } from "../topics/topics";
import { addWord } from "../vocab/vocab";
import { loadStats } from "./stats";

// Trưa giờ máy để "hôm nay" không phụ thuộc múi giờ.
const NOW = new Date(2026, 9, 28, 12, 0, 0);
const daysAgo = (n: number) => new Date(2026, 9, 28 - n, 12, 0, 0);

async function add(db: Db, term: string, reading?: string, meanings?: string) {
  const r = await addWord(db, { term, reading, meanings });
  if (r.status !== "added") throw new Error(r.status);
  return r.wordId;
}

describe("loadStats", () => {
  it("kho trống", async () => {
    const stats = await loadStats(createTestDb(), NOW);
    expect(stats).toMatchObject({ totalWords: 0, pending: 0, learning: 0, mastered: 0, dueToday: 0, hardest: [] });
    expect(stats.days).toHaveLength(7);
    expect(stats.days.at(-1)).toEqual({ date: "2026-10-28", total: 0, correct: 0 });
  });

  it("đếm trạng thái, chủ đề, lượt ôn theo ngày và từ hay sai", async () => {
    const db = createTestDb();
    const eat = await add(db, "食べる", "たべる", "ăn");
    const see = await add(db, "見る", "みる", "xem");
    await add(db, "飲む");
    await db.execute("UPDATE words SET enriched = 1 WHERE id IN (?, ?)", [eat, see]);
    const topic = await createTopic(db, "Động từ");
    if (topic.status !== "ok") throw new Error();
    await addWordsToTopic(db, topic.id, [eat]);

    // 2 ngày trước: quên 食べる; hôm nay: nhớ.
    const [item] = await loadMainRound(db, DEFAULT_SETTINGS, daysAgo(2));
    expect(item.term).toBe("食べる");
    const graded = await submitReview(db, item, Rating.Again, false, daysAgo(2));
    await submitReview(db, graded, Rating.Good, true, NOW);

    // 見る đủ vững.
    await db.execute("UPDATE cards SET stability = 30, state = 2, due = ? WHERE word_id = ?", [daysAgo(-30).toISOString(), see]);

    const stats = await loadStats(db, NOW);
    expect(stats).toMatchObject({ totalWords: 3, pending: 1, learning: 1, mastered: 1, notReady: 1, noTopic: 2 });
    expect(stats.topics).toEqual([{ id: topic.id, name: "Động từ", count: 1 }]);
    expect(stats.days.map((d) => d.total)).toEqual([0, 0, 0, 0, 1, 0, 1]);
    expect(stats.days.map((d) => d.correct)).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(stats.hardest).toEqual([{ wordId: eat, term: "食べる", reading: "たべる", wrong: 1, total: 2 }]);
  });
});
