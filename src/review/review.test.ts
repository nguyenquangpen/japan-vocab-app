import { describe, expect, it } from "vitest";
import type { Db } from "../db/db";
import { createTestDb } from "../db/nodeSqliteDb";
import { DEFAULT_SETTINGS } from "../settings/settings";
import { addWord, listWords } from "../vocab/vocab";
import { advanceQueue, ensureCards, getReviewOverview, loadSession, submitReview, type ReviewItem } from "./review";
import { Rating, State } from "./scheduler";

// Trưa giờ máy, để "hôm nay" không phụ thuộc múi giờ.
const NOW = new Date(2026, 9, 26, 12, 0, 0);
const at = (minutesLater: number) => new Date(NOW.getTime() + minutesLater * 60_000);

async function add(db: Db, term: string, reading: string | undefined, meanings: string | undefined, minute = 0) {
  const r = await addWord(db, { term, reading, meanings }, at(minute));
  if (r.status !== "added") throw new Error(r.status);
  return r.wordId;
}

const label = (items: ReviewItem[]) => items.map((i) => `${i.term}:${i.skill}`);

describe("ensureCards", () => {
  it("chỉ tạo thẻ cho từ có đủ cách đọc và nghĩa, chạy lại không tạo thêm", async () => {
    const db = createTestDb();
    await add(db, "食べる", "たべる", "ăn");
    await add(db, "飲む", undefined, "uống");
    await add(db, "見る", "みる", undefined);

    expect(await ensureCards(db, NOW)).toBe(2);
    expect(await ensureCards(db, NOW)).toBe(0);
    const cards = await db.select<{ skill: string; state: number; learning_steps: number }>(
      "SELECT skill, state, learning_steps FROM cards ORDER BY skill",
    );
    expect(cards).toEqual([
      { skill: "meaning", state: State.New, learning_steps: 0 },
      { skill: "reading", state: State.New, learning_steps: 0 },
    ]);
  });
});

describe("loadSession", () => {
  it("thẻ mới: reading trước meaning, từ toàn kana thì meaning trước; giới hạn số từ mới", async () => {
    const db = createTestDb();
    await add(db, "食べる", "たべる", "ăn", 0);
    await add(db, "ありがとう", "ありがとう", "cảm ơn", 1);
    await add(db, "見る", "みる", "xem", 2);

    const session = await loadSession(db, { ...DEFAULT_SETTINGS, newPerDay: 2 }, NOW);
    expect(label(session)).toEqual(["食べる:reading", "食べる:meaning", "ありがとう:meaning", "ありがとう:reading"]);
    expect(session.find((i) => i.term === "ありがとう")?.kanaOnly).toBe(true);
  });

  it("từ đã học hôm nay trừ vào giới hạn từ mới; thẻ đến hạn đứng trước", async () => {
    const db = createTestDb();
    await add(db, "食べる", "たべる", "ăn", 0);
    await add(db, "見る", "みる", "xem", 1);
    await add(db, "行く", "いく", "đi", 2);

    const first = await loadSession(db, { ...DEFAULT_SETTINGS, newPerDay: 1 }, NOW);
    expect(label(first)).toEqual(["食べる:reading", "食べる:meaning"]);
    for (const item of first) await submitReview(db, item, Rating.Again, null, false, NOW);

    // 5 phút sau: 2 thẻ 食べる đến hạn, hôm nay đã học 1 từ mới nên không thêm từ mới.
    const second = await loadSession(db, { ...DEFAULT_SETTINGS, newPerDay: 1 }, at(5));
    expect(label(second).sort()).toEqual(["食べる:meaning", "食べる:reading"]);

    const third = await loadSession(db, { ...DEFAULT_SETTINGS, newPerDay: 2 }, at(5));
    expect(label(third).slice(2)).toEqual(["見る:reading", "見る:meaning"]);
  });

  it("giới hạn số thẻ ôn mỗi phiên", async () => {
    const db = createTestDb();
    await add(db, "食べる", "たべる", "ăn");
    const items = await loadSession(db, DEFAULT_SETTINGS, NOW);
    for (const item of items) await submitReview(db, item, Rating.Again, null, false, NOW);

    const session = await loadSession(db, { ...DEFAULT_SETTINGS, maxReviewsPerSession: 1, newPerDay: 0 }, at(5));
    expect(session).toHaveLength(1);
  });

  it("thẻ reading chưa đến hạn thì phiên sau chỉ còn thẻ meaning mới", async () => {
    const db = createTestDb();
    await add(db, "食べる", "たべる", "ăn");
    const [reading] = await loadSession(db, DEFAULT_SETTINGS, NOW);
    await submitReview(db, reading, Rating.Good, "たべる", true, NOW);

    // Phút thứ 1: thẻ reading đến hạn sau 10 phút.
    expect(label(await loadSession(db, DEFAULT_SETTINGS, at(1)))).toEqual(["食べる:meaning"]);
  });
});

describe("submitReview", () => {
  it("cập nhật thẻ và ghi review_logs", async () => {
    const db = createTestDb();
    await add(db, "食べる", "たべる", "ăn");
    const [reading] = await loadSession(db, DEFAULT_SETTINGS, NOW);

    const graded = await submitReview(db, reading, Rating.Again, "たべた", false, NOW);
    expect(graded.card.state).toBe(State.Learning);

    const [card] = await db.select<{ state: number; reps: number; due: string }>(
      "SELECT state, reps, due FROM cards WHERE id = ?",
      [reading.cardId],
    );
    expect(card).toEqual({ state: State.Learning, reps: 1, due: graded.card.due });
    expect(await db.select("SELECT rating, answer, correct, reviewed_at FROM review_logs")).toEqual([
      { rating: Rating.Again, answer: "たべた", correct: 0, reviewed_at: NOW.toISOString() },
    ]);
  });
});

describe("advanceQueue", () => {
  it("thẻ đến hạn trong 20 phút thì xếp lại cuối, xa hơn thì bỏ", async () => {
    const db = createTestDb();
    await add(db, "食べる", "たべる", "ăn");
    await add(db, "見る", "みる", "xem", 1);
    const queue = await loadSession(db, DEFAULT_SETTINGS, NOW);

    const learning = await submitReview(db, queue[0], Rating.Good, null, true, NOW);
    const next = advanceQueue(queue, learning, NOW);
    expect(next).toHaveLength(queue.length);
    expect(next.at(-1)?.cardId).toBe(queue[0].cardId);

    const graduated = await submitReview(db, learning, Rating.Easy, null, true, at(10));
    expect(advanceQueue([learning], graduated, at(10))).toEqual([]);
  });
});

describe("getReviewOverview và trạng thái vững", () => {
  it("đếm từ chưa đủ điều kiện, hạn gần nhất, lọc vững", async () => {
    const db = createTestDb();
    const id = await add(db, "食べる", "たべる", "ăn");
    await add(db, "飲む", undefined, undefined);
    await db.execute("UPDATE words SET enriched = 1 WHERE id = ?", [id]);

    expect(await getReviewOverview(db)).toEqual({ notReady: 1, nextDue: null });

    const items = await loadSession(db, DEFAULT_SETTINGS, NOW);
    const graded = await submitReview(db, items[0], Rating.Good, null, true, NOW);
    expect((await getReviewOverview(db)).nextDue).toBe(graded.card.due);

    expect((await listWords(db, { status: "learning" })).map((w) => w.term)).toEqual(["食べる"]);
    await db.execute("UPDATE cards SET stability = 30 WHERE word_id = ?", [id]);
    expect((await listWords(db, { status: "mastered" })).map((w) => [w.term, w.mastered])).toEqual([["食べる", true]]);
    expect(await listWords(db, { status: "learning" })).toEqual([]);
  });
});
