import { describe, expect, it } from "vitest";
import { cleanWord, normalizeText, parseBatchLine, splitMeanings } from "./text";

describe("normalizeText", () => {
  it("NFKC, gộp khoảng trắng, bỏ đầu cuối", () => {
    expect(normalizeText("  ﾀﾍﾞﾙ　 食べる ")).toBe("タベル 食べる");
  });
});

describe("splitMeanings", () => {
  it("tách theo , và ;", () => {
    expect(splitMeanings("ăn, dùng bữa ;xơi;")).toEqual(["ăn", "dùng bữa", "xơi"]);
  });
  it("rỗng thành mảng rỗng", () => {
    expect(splitMeanings(undefined)).toEqual([]);
    expect(splitMeanings(" , ")).toEqual([]);
  });
});

describe("parseBatchLine", () => {
  it("bỏ qua dòng trống", () => {
    expect(parseBatchLine("   ")).toBeNull();
  });
  it("chỉ có term", () => {
    expect(parseBatchLine("食べる")).toEqual({ term: "食べる", reading: null });
  });
  it("term + reading, kể cả khoảng trắng toàn góc", () => {
    expect(parseBatchLine("食べる　たべる")).toEqual({ term: "食べる", reading: "たべる" });
  });
  it("dạng | với nghĩa", () => {
    expect(parseBatchLine("食べる | たべる | ăn, dùng bữa")).toEqual({
      term: "食べる",
      reading: "たべる",
      meanings: ["ăn", "dùng bữa"],
    });
  });
  it("dạng | bỏ trống reading, dùng ｜ toàn góc", () => {
    expect(parseBatchLine("食べる｜｜ăn")).toEqual({ term: "食べる", reading: "", meanings: ["ăn"] });
  });
  it("báo lỗi khi nhiều hơn 2 phần mà không dùng |", () => {
    expect(parseBatchLine("食べる たべる ăn")).toHaveProperty("error");
  });
  it("báo lỗi khi nhiều hơn 3 phần |", () => {
    expect(parseBatchLine("a|b|c|d")).toHaveProperty("error");
  });
});

describe("cleanWord", () => {
  it("chuẩn hóa và giữ trường trống là null", () => {
    expect(cleanWord({ term: " 食べる ", reading: "", meanings: [" ăn "] })).toEqual({
      ok: true,
      word: {
        term: "食べる",
        reading: null,
        meanings: ["ăn"],
        partOfSpeech: null,
        usageNote: null,
        userNote: null,
        meaningDetail: null,
      },
    });
  });
  it("nghĩa mở rộng giữ xuống dòng, gộp dòng trống thừa", () => {
    const result = cleanWord({ term: "食べる", meaningDetail: "  dòng 1  \r\n\r\n\r\n  dòng   2 " });
    expect(result).toMatchObject({ ok: true, word: { meaningDetail: "dòng 1\n\ndòng 2" } });
  });
  it("chặn term rỗng", () => {
    expect(cleanWord({ term: "  " })).toMatchObject({ ok: false });
  });
  it("chặn reading không phải kana", () => {
    expect(cleanWord({ term: "食べる", reading: "taberu" })).toMatchObject({ ok: false });
  });
  it("nhận katakana và ー", () => {
    expect(cleanWord({ term: "コーヒー", reading: "コーヒー" })).toMatchObject({ ok: true });
  });
  it("chặn quá 5 nghĩa", () => {
    expect(cleanWord({ term: "a", meanings: ["1", "2", "3", "4", "5", "6"] })).toMatchObject({ ok: false });
  });
});
