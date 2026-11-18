import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/nodeSqliteDb";
import { addWord } from "../vocab/vocab";
import { countUnseenOldWords, pickOldWords, resetOldWordsMemory } from "./oldWordsMemory";
import { ALL_WORDS, loadPracticePool } from "./review";

/** Rng cố định (LCG) để kết quả lặp lại được. */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

async function pool(count: number) {
  const db = createTestDb();
  for (let i = 0; i < count; i++) await addWord(db, { term: `語${i}`, meanings: `nghĩa ${i}` });
  return loadPracticePool(db);
}

const ids = (items: { cardId: number }[]) => items.map((i) => i.cardId);

beforeEach(resetOldWordsMemory);

describe("pickOldWords", () => {
  it("không lặp từ giữa các lượt cho tới khi gặp hết, rồi sang vòng mới", async () => {
    const words = await pool(12);
    const rng = seeded(5);
    const a = pickOldWords(ALL_WORDS, words, 5, rng);
    const b = pickOldWords(ALL_WORDS, words, 5, rng);
    expect(countUnseenOldWords(ALL_WORDS, words)).toBe(2);
    const c = pickOldWords(ALL_WORDS, words, 5, rng);
    expect([a.items.length, b.items.length, c.items.length]).toEqual([5, 5, 2]);
    expect(new Set([...ids(a.items), ...ids(b.items), ...ids(c.items)]).size).toBe(12);
    expect([a.newCycle, b.newCycle, c.newCycle]).toEqual([false, false, false]);
    expect(countUnseenOldWords(ALL_WORDS, words)).toBe(0);

    // Vòng mới: tránh 2 từ của lượt ngay trước.
    const d = pickOldWords(ALL_WORDS, words, 5, rng);
    expect(d.newCycle).toBe(true);
    expect(d.items).toHaveLength(5);
    expect(ids(d.items).some((id) => ids(c.items).includes(id))).toBe(false);
    expect(countUnseenOldWords(ALL_WORDS, words)).toBe(7);
  });

  it("thứ tự được xáo trộn, không theo thứ tự lưu", async () => {
    const words = await pool(20);
    const picked = ids(pickOldWords(ALL_WORDS, words, 20, seeded(9)).items);
    expect(picked).not.toEqual(ids(words));
    expect([...picked].sort((x, y) => x - y)).toEqual(ids(words).sort((x, y) => x - y));
  });

  it("mỗi phạm vi nhớ riêng", async () => {
    const words = await pool(6);
    const topicScope = { kind: "topics" as const, topicIds: [2, 1] };
    pickOldWords(ALL_WORDS, words, 6, seeded(1));
    expect(countUnseenOldWords(ALL_WORDS, words)).toBe(0);
    expect(countUnseenOldWords(topicScope, words)).toBe(6);
    pickOldWords({ kind: "topics", topicIds: [1, 2] }, words, 2, seeded(1));
    expect(countUnseenOldWords(topicScope, words)).toBe(4);
    expect(countUnseenOldWords(ALL_WORDS, words)).toBe(0);
  });

  it("kho trống thì không có gì", () => {
    expect(pickOldWords(ALL_WORDS, [], 5)).toEqual({ items: [], newCycle: false });
  });
});
