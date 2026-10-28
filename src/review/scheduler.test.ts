import { describe, expect, it } from "vitest";
import { Rating, State, gradeCard, isReadingCorrect, newCardState, normalizeKana, romajiToKana, romajiToKanaWhileTyping } from "./scheduler";

const NOW = new Date("2026-10-26T03:00:00.000Z");
const minutes = (card: { due: string }, from: Date) => (new Date(card.due).getTime() - from.getTime()) / 60_000;

describe("gradeCard", () => {
  it("thẻ mới: Again 1 phút, Good 10 phút (bước học)", () => {
    const card = newCardState(NOW);
    expect(card.state).toBe(State.New);

    const again = gradeCard(card, Rating.Again, NOW);
    expect(again.state).toBe(State.Learning);
    expect(minutes(again, NOW)).toBe(1);

    const good = gradeCard(card, Rating.Good, NOW);
    expect(good.state).toBe(State.Learning);
    expect(good.learningSteps).toBe(1);
    expect(minutes(good, NOW)).toBe(10);
  });

  it("Good ở bước 2 thì tốt nghiệp sang Review, hạn tính bằng ngày", () => {
    const step1 = gradeCard(newCardState(NOW), Rating.Good, NOW);
    const later = new Date(step1.due);
    const step2 = gradeCard(step1, Rating.Good, later);
    expect(step2.state).toBe(State.Review);
    expect(step2.scheduledDays).toBeGreaterThanOrEqual(1);
    expect(step2.lastReview).toBe(later.toISOString());
    expect(step2.reps).toBe(2);
  });

  it("quên thẻ Review thì sang Relearning và tăng lapses", () => {
    let card = gradeCard(newCardState(NOW), Rating.Good, NOW);
    card = gradeCard(card, Rating.Good, new Date(card.due));
    const due = new Date(card.due);
    const lapsed = gradeCard(card, Rating.Again, due);
    expect(lapsed.state).toBe(State.Relearning);
    expect(lapsed.lapses).toBe(1);
  });
});

describe("cách đọc", () => {
  it("normalizeKana: katakana → hiragana, bỏ khoảng trắng, giữ ー", () => {
    expect(normalizeKana(" タベ ル ")).toBe("たべる");
    expect(normalizeKana("コーヒー")).toBe("こーひー");
    expect(normalizeKana("ｺｰﾋｰ")).toBe("こーひー");
  });

  it("isReadingCorrect nhận romaji còn sót, katakana, khoảng trắng", () => {
    expect(isReadingCorrect("たべる", "たべる")).toBe(true);
    expect(isReadingCorrect("taberu", "たべる")).toBe(true);
    expect(isReadingCorrect("ほん", "ほn".replace("n", "ん"))).toBe(true);
    expect(isReadingCorrect("hon", "ほん")).toBe(true);
    expect(isReadingCorrect("こーひー", "コーヒー")).toBe(true);
    expect(isReadingCorrect("たべた", "たべる")).toBe(false);
    expect(isReadingCorrect("  ", "たべる")).toBe(false);
  });

  it("romajiToKana đổi cả n cuối, giữ nguyên kana", () => {
    expect(romajiToKana("hon")).toBe("ほん");
    expect(romajiToKana("たべる")).toBe("たべる");
    expect(romajiToKana("")).toBe("");
  });

  it("đổi romaji khi đang gõ, giữ n cuối", () => {
    expect(romajiToKanaWhileTyping("taber")).toBe("たべr");
    expect(romajiToKanaWhileTyping("kon")).toBe("こn");
    expect(romajiToKanaWhileTyping("konn")).toBe("こん");
  });
});
