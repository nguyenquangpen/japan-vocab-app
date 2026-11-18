import { describe, expect, it } from "vitest";
import type { Db } from "../db/db";
import { createTestDb } from "../db/nodeSqliteDb";
import {
  buildPracticePrompt,
  listWordsForPrompt,
  loadCloze,
  loadOrder,
  parsePracticeResponse,
  practiceItemCounts,
  savePracticeItems,
  type ParsedPractice,
} from "./generated";

const NOW = "2026-11-13T00:00:00.000Z";

async function addWord(db: Db, term: string, meanings: string[] = []): Promise<number> {
  const { lastInsertId } = await db.execute(
    "INSERT INTO words (term, reading, meanings_vi, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [term, "よみ", JSON.stringify(meanings), NOW, NOW],
  );
  return lastInsertId!;
}

const cloze = { before: "毎朝パンを", answer: "食べます", after: "。", vi: "Sáng nào cũng ăn bánh mì.", distractors: ["飲みます", "見ます", "書きます"] };
const order = {
  pieces: ["私は", "毎朝", "パンを", "食べます。"],
  readings: ["わたしは", "まいあさ", "ぱんを", "たべます。"],
  vi: "Tôi ăn bánh mì mỗi sáng.",
};
const response = (...items: unknown[]) => JSON.stringify({ items });

describe("buildPracticePrompt", () => {
  it("có level, danh sách từ và định dạng JSON", () => {
    const prompt = buildPracticePrompt(
      [
        { term: "食べる", reading: "たべる", meanings: ["ăn"] },
        { term: "飲む", reading: null, meanings: [] },
      ],
      "N4",
    );
    expect(prompt).toContain("trình độ học viên: N4.");
    expect(prompt).toContain("Danh sách từ:\n食べる (たべる): ăn\n飲む\n");
    expect(prompt).toContain('{"items":[{"term":"","cloze":[{"before":"","answer":"","after":"","vi":"","distractors":["","",""]}],"order":[{"pieces":["",""],"readings":["",""],"vi":""}]}]}');
    expect(prompt).toContain("3–7 cụm");
    expect(prompt).toContain("Chỉ trả về JSON");
  });
});

describe("parsePracticeResponse", () => {
  const batch = [
    { id: 1, term: "食べる" },
    { id: 2, term: "飲む" },
  ];

  it("bỏ code fence, câu dẫn; báo unmatched/missing", () => {
    const text = "Đây là kết quả:\n```json\n" + response({ term: "食べる", cloze: [cloze], order: [order] }, { term: "走る" }) + "\n```";
    const result = parsePracticeResponse(text, batch);
    expect(result).toEqual({
      ok: true,
      items: [{ wordId: 1, cloze: [cloze], order: [order] }],
      unmatched: ["走る"],
      missing: ["飲む"],
    });
  });

  it("ghép term theo NFKC; từ không còn câu dùng được thì không lưu (để không xóa câu cũ), báo trong missing", () => {
    const result = parsePracticeResponse(
      response({ term: " ﾊﾟﾝ ", cloze: [{ ...cloze, answer: "  " }], order: [{ pieces: [" ", " "], vi: "" }] }),
      [{ id: 5, term: "パン" }],
    );
    expect(result).toEqual({ ok: true, items: [], unmatched: [], missing: ["パン"] });
  });

  it("bỏ câu điền lộ đáp án và câu xếp còn dưới 2 mảnh", () => {
    const result = parsePracticeResponse(
      response({
        term: "食べる",
        cloze: [cloze, { ...cloze, before: "食べます、", answer: "食べます", after: "。" }],
        order: [{ pieces: ["私は", " "], vi: "" }, { pieces: ["私は", "食べる"], vi: "" }],
      }),
      batch,
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.items[0].cloze).toHaveLength(1);
    expect(result.items[0].order).toEqual([{ pieces: ["私は", "食べる"], readings: null, vi: null }]);
  });

  it("lỗi khi không có JSON hoặc JSON hỏng", () => {
    expect(parsePracticeResponse("xin lỗi", batch)).toEqual({ ok: false, message: "Không tìm thấy JSON trong nội dung dán vào." });
    expect(parsePracticeResponse('{"items":[{"term":', batch)).toMatchObject({ ok: false });
  });

  it("lỗi schema nêu rõ từ nào bằng tiếng Việt", () => {
    const result = parsePracticeResponse(
      response({ term: "食べる", cloze: [cloze] }, { term: "飲む", order: [{ pieces: ["一つ"] }] }),
      batch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Từ thứ 2 (飲む): order.pieces cần ít nhất 2 mảnh.");
  });

  it("lỗi khi vượt giới hạn", () => {
    expect(parsePracticeResponse(response(), batch)).toMatchObject({ ok: false });
    const tooMany = { term: "食べる", cloze: [{ ...cloze, distractors: ["a", "b", "c", "d"] }] };
    expect(parsePracticeResponse(response(tooMany), batch)).toMatchObject({ ok: false });
    expect(parsePracticeResponse(response({ term: "食べる", cloze: [{ ...cloze, answer: "" }] }), batch)).toMatchObject({ ok: false });
  });
});

describe("lưu và đọc câu luyện tập", () => {
  it("lưu, thay câu cũ, đọc đúng kiểu, đếm", async () => {
    const db = createTestDb();
    const a = await addWord(db, "食べる");
    const b = await addWord(db, "飲む");
    const items: ParsedPractice[] = [
      { wordId: a, cloze: [cloze, cloze], order: [order] },
      { wordId: b, cloze: [{ ...cloze, distractors: [] }], order: [] },
    ];
    expect(await savePracticeItems(db, items, new Date(NOW))).toBe(4);
    expect(await practiceItemCounts(db, [a, b])).toEqual({ cloze: 3, order: 1 });

    // chạy lại cho từ a: thay hẳn câu cũ, từ b giữ nguyên
    expect(await savePracticeItems(db, [{ wordId: a, cloze: [cloze], order: [] }])).toBe(1);
    expect(await practiceItemCounts(db, [a])).toEqual({ cloze: 1, order: 0 });
    expect(await practiceItemCounts(db, [b])).toEqual({ cloze: 1, order: 0 });

    const loaded = await loadCloze(db, [a, b]);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ kind: "cloze", wordId: b, ...cloze, distractors: [] });
    expect(loaded[1]).toMatchObject({ kind: "cloze", wordId: a, ...cloze });

    await savePracticeItems(db, [{ wordId: b, cloze: [], order: [order] }]);
    expect(await loadOrder(db, [a, b])).toEqual([{ kind: "order", id: expect.any(Number), wordId: b, ...order }]);
    expect(await loadCloze(db, [])).toEqual([]);
    expect(await practiceItemCounts(db, [])).toEqual({ cloze: 0, order: 0 });
  });

  it("bỏ qua dòng JSON hỏng", async () => {
    const db = createTestDb();
    const a = await addWord(db, "食べる");
    await db.execute("INSERT INTO practice_items (word_id, kind, data, created_at) VALUES (?, 'cloze', ?, ?)", [a, "{oops", NOW]);
    await db.execute("INSERT INTO practice_items (word_id, kind, data, created_at) VALUES (?, 'order', ?, ?)", [a, '{"pieces":"x"}', NOW]);
    expect(await loadCloze(db, [a])).toEqual([]);
    expect(await loadOrder(db, [a])).toEqual([]);
  });

  it("xóa từ thì xóa câu luyện tập; không đụng cards/review_logs", async () => {
    const db = createTestDb();
    const a = await addWord(db, "食べる");
    await savePracticeItems(db, [{ wordId: a, cloze: [cloze], order: [order] }]);
    for (const table of ["cards", "review_logs"]) {
      const [{ n }] = await db.select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(n, table).toBe(0);
    }
    await db.execute("DELETE FROM words WHERE id = ?", [a]);
    const [{ n }] = await db.select<{ n: number }>("SELECT COUNT(*) AS n FROM practice_items");
    expect(n).toBe(0);
  });

  it("listWordsForPrompt giữ thứ tự và đọc nghĩa", async () => {
    const db = createTestDb();
    const a = await addWord(db, "食べる", ["ăn"]);
    const b = await addWord(db, "飲む", ["uống", "nuốt"]);
    expect(await listWordsForPrompt(db, [b, a, 999])).toEqual([
      { id: b, term: "飲む", reading: "よみ", meanings: ["uống", "nuốt"] },
      { id: a, term: "食べる", reading: "よみ", meanings: ["ăn"] },
    ]);
  });
});
