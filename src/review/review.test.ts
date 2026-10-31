import { describe, expect, it } from "vitest";
import type { Db } from "../db/db";
import { createTestDb } from "../db/nodeSqliteDb";
import { DEFAULT_SETTINGS } from "../settings/settings";
import { addWord, listWords } from "../vocab/vocab";
import {
  ALL_WORDS,
  ensureCards,
  getReviewOverview,
  loadPracticePool,
  loadMainRound,
  loadNewRound,
  pickPractice,
  submitReview,
  type ReviewItem,
} from "./review";
import { Rating, State } from "./scheduler";

// Trưa giờ máy, để "hôm nay" không phụ thuộc múi giờ.
const NOW = new Date(2026, 9, 26, 12, 0, 0);
const at = (minutesLater: number) => new Date(NOW.getTime() + minutesLater * 60_000);
const DAY = 24 * 60;

async function add(db: Db, term: string, reading: string | undefined, meanings: string | undefined, minute = 0) {
  const r = await addWord(db, { term, reading, meanings }, at(minute));
  if (r.status !== "added") throw new Error(r.status);
  return r.wordId;
}

async function addMany(db: Db, count: number) {
  for (let i = 0; i < count; i++) await add(db, `語${i}`, undefined, `nghĩa ${i}`, i);
}

const terms = (items: ReviewItem[]) => items.map((i) => i.term);

/** Rng cố định (LCG) để kết quả lặp lại được. */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

describe("ensureCards", () => {
  it("chỉ tạo 1 thẻ meaning cho từ có nghĩa (kana không bắt buộc), chạy lại không tạo thêm", async () => {
    const db = createTestDb();
    await add(db, "食べる", "たべる", "ăn");
    await add(db, "飲む", undefined, "uống");
    await add(db, "見る", "みる", undefined);

    expect(await ensureCards(db, NOW)).toBe(2);
    expect(await ensureCards(db, NOW)).toBe(0);
    expect(await db.select("SELECT skill, state FROM cards")).toEqual([
      { skill: "meaning", state: State.New },
      { skill: "meaning", state: State.New },
    ]);
  });
});

describe("submitReview (không còn bước học ngắn)", () => {
  it("Nhớ thẻ mới hẹn theo ngày, không đến hạn lại trong ngày; Quên hẹn ~1 ngày", async () => {
    const db = createTestDb();
    await add(db, "食べる", "たべる", "ăn");
    await add(db, "見る", "みる", "xem", 1);
    const [eat, see] = await loadMainRound(db, DEFAULT_SETTINGS, NOW);

    const remembered = await submitReview(db, eat, Rating.Good, true, NOW);
    const forgot = await submitReview(db, see, Rating.Again, false, NOW);
    expect(remembered.card.state).toBe(State.Review);
    expect(new Date(remembered.card.due).getTime()).toBeGreaterThan(at(2 * DAY).getTime());
    expect(new Date(forgot.card.due).getTime()).toBeGreaterThanOrEqual(at(DAY - 1).getTime());

    expect(await db.select("SELECT rating, answer, correct FROM review_logs ORDER BY id")).toEqual([
      { rating: Rating.Good, answer: null, correct: 1 },
      { rating: Rating.Again, answer: null, correct: 0 },
    ]);
    // Tải lại ngay trong ngày: không còn thẻ nào (cả 2 đã chấm, hết từ mới).
    expect(await loadMainRound(db, DEFAULT_SETTINGS, at(30))).toEqual([]);
  });
});

describe("loadMainRound", () => {
  it("tối đa sessionSize thẻ: thẻ đến hạn trước, bù từ mới trong giới hạn ngày", async () => {
    const db = createTestDb();
    await addMany(db, 30);
    const settings = { ...DEFAULT_SETTINGS, sessionSize: 15, newPerDay: 10 };

    const first = await loadMainRound(db, settings, NOW);
    expect(first).toHaveLength(10);
    expect(terms(first)[0]).toBe("語0");
    for (const [i, item] of first.entries()) {
      await submitReview(db, item, i < 4 ? Rating.Again : Rating.Good, i >= 4, NOW);
    }

    // 1,5 ngày sau (đã sang ngày mới): 4 thẻ quên đến hạn (hẹn 1 ngày), thẻ nhớ chưa (≥ 2 ngày)
    // + 10 từ mới của ngày mới = 14 ≤ 15.
    const later = await loadMainRound(db, settings, at(1.5 * DAY));
    expect(later).toHaveLength(14);
    expect(terms(later).slice(0, 4).sort()).toEqual(["語0", "語1", "語2", "語3"]);
    expect(terms(later)[4]).toBe("語10");
  });

  it("bỏ qua thẻ reading cũ còn trong DB", async () => {
    const db = createTestDb();
    const id = await add(db, "食べる", "たべる", "ăn");
    await db.execute(
      `INSERT INTO cards (word_id, skill, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state)
       VALUES (?, 'reading', ?, 1, 5, 0, 1, 1, 0, 2)`,
      [id, at(-60).toISOString()],
    );
    expect(await loadMainRound(db, DEFAULT_SETTINGS, NOW)).toHaveLength(1);
  });
});

describe("loadNewRound + overview", () => {
  it("học thêm từ mới vượt giới hạn ngày; overview đếm đúng", async () => {
    const db = createTestDb();
    await addMany(db, 20);
    await add(db, "飲む", undefined, undefined, 100);
    const settings = { ...DEFAULT_SETTINGS, sessionSize: 15, newPerDay: 5 };

    for (const item of await loadMainRound(db, settings, NOW)) await submitReview(db, item, Rating.Good, true, NOW);
    expect(await getReviewOverview(db, settings, NOW)).toMatchObject({
      notReady: 1,
      dueNow: 0,
      newLeft: 15,
      newTodayLeft: 0,
      total: 20,
    });

    const extra = await loadNewRound(db, settings, NOW);
    expect(extra).toHaveLength(15);
    expect(terms(extra)[0]).toBe("語5");
  });
});

describe("pickPractice", () => {
  it("không lặp, đúng số lượng; từ đã thuộc hiếm được chọn hơn từ yếu", async () => {
    const db = createTestDb();
    await addMany(db, 20);
    for (const item of await loadNewRound(db, { ...DEFAULT_SETTINGS, sessionSize: 20 }, NOW)) {
      await submitReview(db, item, Rating.Good, true, NOW);
    }
    // 10 từ đầu: đã thuộc (stability cao, vừa ôn). 10 từ sau: yếu (stability thấp, ôn lâu rồi).
    await db.execute("UPDATE cards SET stability = 200, last_review = ? WHERE word_id <= 10", [NOW.toISOString()]);
    await db.execute("UPDATE cards SET stability = 0.5, last_review = ? WHERE word_id > 10", [at(-10 * DAY).toISOString()]);
    const pool = await loadPracticePool(db, NOW);
    expect(pool).toHaveLength(20);

    const rng = seeded(42);
    let strongPicks = 0;
    for (let round = 0; round < 50; round++) {
      const picked = pickPractice(pool, 5, NOW, rng);
      expect(new Set(picked.map((p) => p.cardId)).size).toBe(5);
      strongPicks += picked.filter((p) => p.wordId <= 10).length;
    }
    // 250 lượt chọn, 10 từ thuộc / 10 từ yếu: từ đã thuộc chiếm rất ít (dưới 10%) nhưng vẫn có.
    expect(strongPicks).toBeLessThan(25);
    expect(strongPicks).toBeGreaterThan(0);
  });
});

describe("luyện thêm trên toàn bộ vốn từ", () => {
  it("kho luyện có cả từ chưa ôn; từ chưa ôn được ưu tiên hơn từ đã thuộc", async () => {
    const db = createTestDb();
    await addMany(db, 20);
    // Ôn 10 từ đầu và cho thành "đã thuộc"; 10 từ sau chưa ôn lần nào.
    for (const item of await loadNewRound(db, { ...DEFAULT_SETTINGS, sessionSize: 10 }, NOW)) {
      await submitReview(db, item, Rating.Good, true, NOW);
    }
    await db.execute("UPDATE cards SET stability = 200 WHERE state != ?", [State.New]);

    const pool = await loadPracticePool(db, NOW);
    expect(pool).toHaveLength(20);
    const picked = pickPractice(pool, 10, NOW, seeded(7));
    expect(picked.filter((p) => p.card.state === State.New).length).toBeGreaterThanOrEqual(8);
  });

  it("tránh lặp lượt trước khi còn đủ từ khác; không đủ thì mới lấy lại", async () => {
    const db = createTestDb();
    await addMany(db, 12);
    const pool = await loadPracticePool(db, NOW);
    const last = new Set(pool.slice(0, 5).map((i) => i.cardId));

    const next = pickPractice(pool, 5, NOW, seeded(3), last);
    expect(next.some((i) => last.has(i.cardId))).toBe(false);

    const big = pickPractice(pool, 10, NOW, seeded(3), last);
    expect(big).toHaveLength(10);
    expect(big.filter((i) => last.has(i.cardId))).toHaveLength(3);
  });
});

describe("phạm vi ôn", () => {
  it("lọc theo chủ đề (nhiều chủ đề), từ chưa có chủ đề, tất cả; overview đếm trong phạm vi", async () => {
    const db = createTestDb();
    const eat = await add(db, "食べる", "たべる", "ăn", 0);
    const drink = await add(db, "飲む", "のむ", "uống", 1);
    const cat = await add(db, "猫", "ねこ", "mèo", 2);
    await add(db, "犬", "いぬ", "chó", 3);
    const { lastInsertId: verbs } = await db.execute("INSERT INTO topics (name) VALUES (?)", ["Động từ"]);
    const { lastInsertId: animals } = await db.execute("INSERT INTO topics (name) VALUES (?)", ["Động vật"]);
    await db.execute("INSERT INTO word_topics (word_id, topic_id) VALUES (?, ?), (?, ?), (?, ?)", [
      eat, verbs, drink, verbs, cat, animals,
    ]);
    const topics = (...topicIds: (number | undefined)[]) => ({ kind: "topics" as const, topicIds: topicIds as number[] });

    expect(terms(await loadMainRound(db, DEFAULT_SETTINGS, NOW, topics(verbs)))).toEqual(["食べる", "飲む"]);
    expect(terms(await loadNewRound(db, DEFAULT_SETTINGS, NOW, topics(verbs, animals)))).toEqual(["食べる", "飲む", "猫"]);
    expect(terms(await loadPracticePool(db, NOW, { kind: "noTopic" }))).toEqual(["犬"]);
    expect(await loadPracticePool(db, NOW, topics())).toEqual([]);
    expect(await loadPracticePool(db, NOW, ALL_WORDS)).toHaveLength(4);

    expect(await getReviewOverview(db, DEFAULT_SETTINGS, NOW, topics(animals))).toMatchObject({
      total: 1,
      newLeft: 1,
      dueNow: 0,
    });
    expect((await getReviewOverview(db, DEFAULT_SETTINGS, NOW, { kind: "noTopic" })).total).toBe(1);
  });
});

describe("trạng thái vững", () => {
  it("lọc vững theo thẻ meaning", async () => {
    const db = createTestDb();
    const id = await add(db, "食べる", "たべる", "ăn");
    await db.execute("UPDATE words SET enriched = 1 WHERE id = ?", [id]);
    const [item] = await loadMainRound(db, DEFAULT_SETTINGS, NOW);
    await submitReview(db, item, Rating.Good, true, NOW);

    expect((await listWords(db, { status: "learning" })).map((w) => w.term)).toEqual(["食べる"]);
    await db.execute("UPDATE cards SET stability = 30 WHERE word_id = ?", [id]);
    expect((await listWords(db, { status: "mastered" })).map((w) => [w.term, w.mastered])).toEqual([["食べる", true]]);
  });
});
