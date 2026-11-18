import { describe, expect, it } from "vitest";
import type { Db } from "../db/db";
import { createTestDb } from "../db/nodeSqliteDb";
import { DEFAULT_SETTINGS } from "../settings/settings";
import { addWord, listWords } from "../vocab/vocab";
import {
  ALL_WORDS,
  ensureCards,
  getReviewOverview,
  loadNewRound,
  loadPracticePool,
  loadTodayRound,
  submitReview,
  wordStatus,
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

/** 語0 thêm trước nhất … 語{n-1} thêm sau cùng (mới nhất). */
async function addMany(db: Db, count: number) {
  for (let i = 0; i < count; i++) await add(db, `語${i}`, undefined, `nghĩa ${i}`, i);
}

const terms = (items: ReviewItem[]) => items.map((i) => i.term);

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

describe("Ôn hôm nay (loadTodayRound)", () => {
  it("từ mới: mới thêm nhất trước, tối đa newPerDay", async () => {
    const db = createTestDb();
    await addMany(db, 20);
    const today = await loadTodayRound(db, { ...DEFAULT_SETTINGS, sessionSize: 15, newPerDay: 5 }, NOW);
    expect(terms(today)).toEqual(["語19", "語18", "語17", "語16", "語15"]);
  });

  it("từ đến hạn trước, rồi mới bù từ mới; đã nhớ thì không quay lại trong ngày", async () => {
    const db = createTestDb();
    await addMany(db, 30);
    const settings = { ...DEFAULT_SETTINGS, sessionSize: 15, newPerDay: 10 };

    const first = await loadTodayRound(db, settings, NOW);
    expect(first).toHaveLength(10);
    for (const [i, item] of first.entries()) {
      await submitReview(db, item, i < 4 ? Rating.Again : Rating.Good, i >= 4, NOW);
    }
    // Cùng ngày: đã chấm hết 10 từ mới của hôm nay → không còn gì (từ Nhớ hẹn ≥ 2 ngày, Quên hẹn 1 ngày).
    expect(await loadTodayRound(db, settings, at(60))).toEqual([]);

    // 1,5 ngày sau: 4 từ quên đến hạn đứng đầu, rồi 10 từ mới tiếp theo (mới nhất trước:
    // hôm qua đã học 語29…語20 nên hôm nay bắt đầu từ 語19).
    const later = await loadTodayRound(db, settings, at(1.5 * DAY));
    expect(later).toHaveLength(14);
    expect(terms(later).slice(0, 4).sort()).toEqual(terms(first.slice(0, 4)).sort());
    expect(terms(later)[4]).toBe("語19");
  });

  it("bỏ qua thẻ reading cũ còn trong DB", async () => {
    const db = createTestDb();
    const id = await add(db, "食べる", "たべる", "ăn");
    await db.execute(
      `INSERT INTO cards (word_id, skill, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state)
       VALUES (?, 'reading', ?, 1, 5, 0, 1, 1, 0, 2)`,
      [id, at(-60).toISOString()],
    );
    expect(await loadTodayRound(db, DEFAULT_SETTINGS, NOW)).toHaveLength(1);
  });
});

describe("Học thêm từ mới + overview", () => {
  it("vượt giới hạn ngày, mới nhất trước; overview đếm đúng và báo đợt ôn tiếp theo", async () => {
    const db = createTestDb();
    await addMany(db, 20);
    await add(db, "飲む", undefined, undefined, 100);
    const settings = { ...DEFAULT_SETTINGS, sessionSize: 15, newPerDay: 5 };

    for (const item of await loadTodayRound(db, settings, NOW)) await submitReview(db, item, Rating.Good, true, NOW);
    const overview = await getReviewOverview(db, settings, NOW);
    expect(overview).toMatchObject({ notReady: 1, dueNow: 0, newLeft: 15, newTodayLeft: 0, learned: 5, mastered: 0 });
    expect(overview.nextDue?.count).toBeGreaterThan(0);
    expect(overview.nextDue!.date > "2026-10-26").toBe(true);

    const extra = await loadNewRound(db, settings, NOW);
    expect(extra).toHaveLength(15);
    expect(terms(extra)[0]).toBe("語14");
  });
});

describe("Luyện (không đổi lịch)", () => {
  async function setupLearned() {
    const db = createTestDb();
    await addMany(db, 12);
    // Học 8 từ; trong đó 4 từ thành Vững. 4 từ còn lại vẫn Mới.
    const learned = await loadNewRound(db, { ...DEFAULT_SETTINGS, sessionSize: 8 }, NOW);
    for (const item of learned) await submitReview(db, item, Rating.Good, true, NOW);
    const mastered = learned.slice(0, 4).map((i) => i.cardId);
    await db.execute(
      `UPDATE cards SET stability = 30 WHERE id IN (${mastered.map(() => "?").join(", ")})`,
      mastered,
    );
    return { db, mastered: new Set(mastered) };
  }

  it("Ôn từ vựng cũ: chỉ từ đã học (cả Vững), không có từ Mới", async () => {
    const { db } = await setupLearned();
    const pool = await loadPracticePool(db, { learnedOnly: true }, NOW);
    expect(pool).toHaveLength(8);
    expect(pool.every((i) => i.card.state !== State.New)).toBe(true);
  });

  it("Luyện tự do: mặc định bỏ từ Vững, tick thì gồm cả", async () => {
    const { db, mastered } = await setupLearned();
    const withoutMastered = await loadPracticePool(db, { includeMastered: false }, NOW);
    expect(withoutMastered).toHaveLength(8);
    expect(withoutMastered.some((i) => mastered.has(i.cardId))).toBe(false);
    expect(await loadPracticePool(db, { includeMastered: true }, NOW)).toHaveLength(12);
  });

  it("wordStatus: Mới / Đang học / Vững", async () => {
    const { db, mastered } = await setupLearned();
    const pool = await loadPracticePool(db, {}, NOW);
    const count = (s: string) => pool.filter((i) => wordStatus(i.card) === s).length;
    expect([count("new"), count("learning"), count("mastered")]).toEqual([4, 4, 4]);
    expect(pool.filter((i) => mastered.has(i.cardId)).every((i) => wordStatus(i.card) === "mastered")).toBe(true);
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

    expect(terms(await loadTodayRound(db, DEFAULT_SETTINGS, NOW, topics(verbs)))).toEqual(["飲む", "食べる"]);
    expect(terms(await loadNewRound(db, DEFAULT_SETTINGS, NOW, topics(verbs, animals)))).toEqual(["猫", "飲む", "食べる"]);
    expect(terms(await loadPracticePool(db, { scope: { kind: "noTopic" } }, NOW))).toEqual(["犬"]);
    expect(await loadPracticePool(db, { scope: topics() }, NOW)).toEqual([]);
    expect(await loadPracticePool(db, { scope: ALL_WORDS }, NOW)).toHaveLength(4);

    expect(await getReviewOverview(db, DEFAULT_SETTINGS, NOW, topics(animals))).toMatchObject({ newLeft: 1, learned: 0 });
  });
});

describe("trạng thái vững trong Kho từ", () => {
  it("lọc vững theo thẻ meaning", async () => {
    const db = createTestDb();
    const id = await add(db, "食べる", "たべる", "ăn");
    await db.execute("UPDATE words SET enriched = 1 WHERE id = ?", [id]);
    const [item] = await loadTodayRound(db, DEFAULT_SETTINGS, NOW);
    await submitReview(db, item, Rating.Good, true, NOW);

    expect((await listWords(db, { status: "learning" })).map((w) => w.term)).toEqual(["食べる"]);
    await db.execute("UPDATE cards SET stability = 30 WHERE word_id = ?", [id]);
    expect((await listWords(db, { status: "mastered" })).map((w) => [w.term, w.mastered])).toEqual([["食べる", true]]);
  });
});
