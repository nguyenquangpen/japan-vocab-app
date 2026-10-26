import { describe, expect, it } from "vitest";
import { createTestDb } from "../db/nodeSqliteDb";
import { addWord, getWord, saveEnrichment, type EnrichmentData } from "./vocab";

const DATA: EnrichmentData = {
  reading: "たべる",
  meanings: ["ăn", "dùng bữa"],
  partOfSpeech: "động từ",
  usageNote: "Dùng hằng ngày.",
  confusables: [{ term: "飲む", note: "uống" }],
  examples: [
    { ja: "ご飯を食べる。", reading: "ごはんをたべる。", vi: "Ăn cơm." },
    { ja: "パンを食べた。", reading: null, vi: null },
  ],
};

async function addOne(db: ReturnType<typeof createTestDb>, term: string, reading?: string) {
  const result = await addWord(db, { term, reading, userNote: "ghi chú" });
  if (result.status !== "added") throw new Error(result.status);
  return result.wordId;
}

describe("saveEnrichment", () => {
  it("ghi đủ trường, ví dụ, đặt enriched và giữ ghi chú của tôi", async () => {
    const db = createTestDb();
    const id = await addOne(db, "食べる");
    const now = new Date("2026-10-27T00:00:00Z");

    expect(await saveEnrichment(db, id, DATA, now)).toEqual({ status: "updated" });
    expect(await getWord(db, id)).toMatchObject({
      reading: "たべる",
      meanings: ["ăn", "dùng bữa"],
      partOfSpeech: "động từ",
      usageNote: "Dùng hằng ngày.",
      userNote: "ghi chú",
      confusables: [{ term: "飲む", note: "uống" }],
      examples: [
        { ja: "ご飯を食べる。", reading: "ごはんをたべる。", vi: "Ăn cơm." },
        { ja: "パンを食べた。", reading: null, vi: null },
      ],
      enriched: true,
      updatedAt: now.toISOString(),
    });
  });

  it("lưu lại lần nữa thì thay ví dụ, không nhân đôi", async () => {
    const db = createTestDb();
    const id = await addOne(db, "食べる");
    await saveEnrichment(db, id, DATA);
    await saveEnrichment(db, id, DATA);
    expect((await getWord(db, id))?.examples).toHaveLength(2);
  });

  it("examples = null thì giữ ví dụ cũ", async () => {
    const db = createTestDb();
    const id = await addOne(db, "食べる");
    await saveEnrichment(db, id, DATA);
    await saveEnrichment(db, id, { ...DATA, examples: null });
    expect((await getWord(db, id))?.examples).toHaveLength(2);
  });

  it("không lưu gì khi cách đọc AI làm trùng với từ khác", async () => {
    const db = createTestDb();
    const existing = await addOne(db, "上手", "じょうず");
    const id = await addOne(db, "上手", "うわて");

    expect(await saveEnrichment(db, id, { ...DATA, reading: "じょうず" })).toEqual({
      status: "duplicate",
      wordId: existing,
    });
    expect(await getWord(db, id)).toMatchObject({ reading: "うわて", enriched: false, examples: [] });
  });

  it("báo invalid và not_found", async () => {
    const db = createTestDb();
    const id = await addOne(db, "食べる");
    expect(await saveEnrichment(db, id, { ...DATA, reading: "taberu" })).toMatchObject({ status: "invalid" });
    expect(await saveEnrichment(db, 999, DATA)).toEqual({ status: "not_found" });
  });
});
