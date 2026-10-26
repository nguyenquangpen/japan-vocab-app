import { describe, expect, it } from "vitest";
import { buildMistakesPrompt } from "./mistakesPrompt";

describe("buildMistakesPrompt", () => {
  it("liệt kê từ sai theo kỹ năng, bỏ lặp, chèn level", () => {
    const prompt = buildMistakesPrompt(
      [
        { term: "食べる", reading: "たべる", meanings: ["ăn", "dùng bữa"], skill: "reading", answer: "たべた" },
        { term: "食べる", reading: "たべる", meanings: ["ăn", "dùng bữa"], skill: "reading", answer: "たべた" },
        { term: "見る", reading: "みる", meanings: ["xem"], skill: "meaning", answer: null },
      ],
      "N4",
    );
    expect(prompt).toContain("trình độ học viên: N4.");
    expect(prompt).toContain("không vượt quá trình độ N4.");
    expect(prompt.endsWith(
      "Các từ trả lời sai:\n" +
        "1. 食べる (たべる) — nghĩa: ăn; dùng bữa — kỹ năng: cách đọc — tôi gõ: たべた\n" +
        "2. 見る (みる) — nghĩa: xem — kỹ năng: nghĩa — tôi tự chấm là quên",
    )).toBe(true);
  });
});
