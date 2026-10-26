import { describe, expect, it } from "vitest";
import type { WordDetail } from "../vocab/vocab";
import {
  buildEnrichPrompt,
  mergeEnrichment,
  parseEnrichResponse,
  previewFields,
  type EnrichItem,
} from "./enrichment";

const BATCH = [
  { id: 1, term: "食べる", reading: null },
  { id: 2, term: "上手", reading: "じょうず" },
  { id: 3, term: "上手", reading: "うわて" },
];

const item = (over: Partial<EnrichItem> = {}): EnrichItem => ({
  term: "食べる",
  reading: "たべる",
  meanings_vi: ["ăn"],
  part_of_speech: "động từ",
  examples: [{ ja: "ご飯を食べる。", reading: "ごはんをたべる。", vi: "Ăn cơm." }],
  usage_note: "Dùng hằng ngày.",
  confusables: [],
  ...over,
});

const response = (...words: unknown[]) => JSON.stringify({ words });

function word(over: Partial<WordDetail> = {}): WordDetail {
  return {
    id: 1,
    term: "食べる",
    reading: null,
    meanings: [],
    enriched: false,
    partOfSpeech: null,
    usageNote: null,
    userNote: null,
    confusables: [],
    examples: [],
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

describe("buildEnrichPrompt", () => {
  it("chèn level và mỗi dòng một term", () => {
    const prompt = buildEnrichPrompt(["食べる", "飲む"], "N4");
    expect(prompt).toContain("trình độ học viên: N4.");
    expect(prompt).toContain("không vượt quá trình độ N4.");
    expect(prompt).toContain("Danh sách từ:\n食べる\n飲む\n");
  });
});

describe("parseEnrichResponse", () => {
  it("bỏ code fence và câu dẫn, ghép theo term", () => {
    const text = "Đây là kết quả:\n```json\n" + response(item()) + "\n```";
    const result = parseEnrichResponse(text, BATCH.slice(0, 1));
    expect(result).toMatchObject({ ok: true, unmatched: [], missing: [] });
    if (result.ok) expect(result.matches.map((m) => m.wordId)).toEqual([1]);
  });

  it("dùng cách đọc để phân biệt 2 từ cùng chữ", () => {
    const result = parseEnrichResponse(
      response(item({ term: "上手", reading: "うわて" }), item({ term: "上手", reading: "じょうず" })),
      BATCH,
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.matches.map((m) => [m.wordId, m.item.reading])).toEqual([
      [3, "うわて"],
      [2, "じょうず"],
    ]);
    expect(result.missing).toEqual(["食べる"]);
  });

  it("báo term không có trong lô", () => {
    const result = parseEnrichResponse(response(item({ term: "走る" })), BATCH.slice(0, 1));
    expect(result).toMatchObject({ ok: true, unmatched: ["走る"], missing: ["食べる"] });
  });

  it("bỏ qua trường thừa, thiếu examples/confusables thì là mảng rỗng", () => {
    const result = parseEnrichResponse(
      response({ term: "食べる", meanings_vi: ["ăn"], extra: 1 }),
      BATCH.slice(0, 1),
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.matches[0].item).toEqual({ term: "食べる", meanings_vi: ["ăn"], examples: [], confusables: [] });
  });

  it("lỗi khi không có JSON", () => {
    expect(parseEnrichResponse("xin lỗi, tôi không hiểu", BATCH)).toEqual({
      ok: false,
      message: "Không tìm thấy JSON trong nội dung dán vào.",
    });
  });

  it("lỗi cú pháp JSON", () => {
    expect(parseEnrichResponse('{"words":[{"term":', BATCH)).toMatchObject({ ok: false });
  });

  it("lỗi schema nêu rõ từ nào, trường nào", () => {
    const result = parseEnrichResponse(
      response(item(), item({ term: "飲む", reading: "nomu" })),
      BATCH,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Từ thứ 2 (飲む): reading chỉ được gồm hiragana/katakana/ー.");
  });

  it("lỗi khi vượt giới hạn", () => {
    const tooMany = item({ meanings_vi: ["1", "2", "3", "4", "5", "6"] });
    expect(parseEnrichResponse(response(tooMany), BATCH)).toMatchObject({ ok: false });
    expect(parseEnrichResponse(response(), BATCH)).toMatchObject({ ok: false });
  });
});

describe("previewFields", () => {
  it("trường trống mặc định dùng AI, trường đã nhập mặc định giữ", () => {
    const fields = previewFields(word({ meanings: ["ăn uống"] }), item());
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(byKey.reading).toMatchObject({ current: "", suggested: "たべる", useSuggestedByDefault: true });
    expect(byKey.meanings).toMatchObject({ current: "ăn uống", suggested: "ăn", useSuggestedByDefault: false });
    expect(byKey.examples.suggested).toBe("ご飯を食べる。 (ごはんをたべる。) — Ăn cơm.");
  });

  it("bỏ trường AI để trống hoặc giống hệt hiện tại", () => {
    const fields = previewFields(word({ reading: "たべる" }), item({ usage_note: "" }));
    expect(fields.map((f) => f.key)).not.toContain("reading");
    expect(fields.map((f) => f.key)).not.toContain("usageNote");
    expect(fields.map((f) => f.key)).not.toContain("confusables");
  });
});

describe("mergeEnrichment", () => {
  it("lấy AI cho trường được chọn, giữ phần còn lại, ví dụ không chọn thì null", () => {
    const merged = mergeEnrichment(word({ meanings: ["ăn uống"], userNote: "x" }), item(), new Set(["reading"]));
    expect(merged).toEqual({
      reading: "たべる",
      meanings: ["ăn uống"],
      partOfSpeech: null,
      usageNote: null,
      confusables: [],
      examples: null,
    });
  });

  it("chọn ví dụ thì thay bằng ví dụ của AI", () => {
    const merged = mergeEnrichment(word(), item(), new Set(["examples"]));
    expect(merged.examples).toEqual([{ ja: "ご飯を食べる。", reading: "ごはんをたべる。", vi: "Ăn cơm." }]);
  });
});
