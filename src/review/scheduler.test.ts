import { describe, expect, it } from "vitest";
import {
  Rating,
  State,
  gradeCard,
  newCardState,
  retrievability,
  romajiToKana,
  romajiToKanaWhileTyping,
} from "./scheduler";

const NOW = new Date("2026-10-26T03:00:00.000Z");
const minutes = (card: { due: string }, from: Date) => (new Date(card.due).getTime() - from.getTime()) / 60_000;

const DAY = 24 * 60;

describe("gradeCard (không có bước học ngắn)", () => {
  it("thẻ mới: Quên hẹn 1 ngày, Nhớ hẹn ≥ 2 ngày, đều sang Review", () => {
    const card = newCardState(NOW);
    expect(card.state).toBe(State.New);

    const again = gradeCard(card, Rating.Again, NOW);
    expect(again.state).toBe(State.Review);
    expect(minutes(again, NOW)).toBe(DAY);

    const good = gradeCard(card, Rating.Good, NOW);
    expect(good.state).toBe(State.Review);
    expect(minutes(good, NOW)).toBeGreaterThanOrEqual(2 * DAY);
    expect(good.lastReview).toBe(NOW.toISOString());
    expect(good.reps).toBe(1);
  });

  it("nhớ tiếp thì hạn xa dần; quên thì tăng lapses", () => {
    const first = gradeCard(newCardState(NOW), Rating.Good, NOW);
    const second = gradeCard(first, Rating.Good, new Date(first.due));
    expect(second.scheduledDays).toBeGreaterThan(first.scheduledDays);

    const lapsed = gradeCard(second, Rating.Again, new Date(second.due));
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.stability).toBeLessThan(second.stability);
  });

  it("khả năng nhớ: thẻ mới 0, vừa ôn ≈ 1, càng lâu càng giảm", () => {
    const card = gradeCard(newCardState(NOW), Rating.Good, NOW);
    expect(retrievability(newCardState(NOW), NOW)).toBe(0);
    expect(retrievability(card, NOW)).toBeCloseTo(1, 2);
    expect(retrievability(card, new Date(NOW.getTime() + 30 * DAY * 60_000))).toBeLessThan(0.9);
  });
});

describe("romaji → kana", () => {
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
