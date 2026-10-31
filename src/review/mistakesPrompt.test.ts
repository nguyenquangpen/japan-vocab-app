import { describe, expect, it } from "vitest";
import { buildMistakesPrompt } from "./mistakesPrompt";

describe("buildMistakesPrompt", () => {
  it("liệt kê từ đã quên, bỏ lặp, không lặp kana với từ toàn kana, chèn level", () => {
    const prompt = buildMistakesPrompt(
      [
        { term: "食べる", reading: "たべる", meanings: ["ăn", "dùng bữa"] },
        { term: "食べる", reading: "たべる", meanings: ["ăn", "dùng bữa"] },
        { term: "ありがとう", reading: "ありがとう", meanings: ["cảm ơn"] },
        { term: "猫", reading: null, meanings: ["con mèo"] },
      ],
      "N4",
    );
    expect(prompt).toContain("trình độ học viên: N4.");
    expect(prompt).toContain("không vượt quá trình độ N4.");
    expect(
      prompt.endsWith(
        "Các từ tôi quên:\n" +
          "1. 食べる (たべる) — nghĩa: ăn; dùng bữa\n" +
          "2. ありがとう — nghĩa: cảm ơn\n" +
          "3. 猫 — nghĩa: con mèo",
      ),
    ).toBe(true);
  });
});
