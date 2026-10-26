import { State, createEmptyCard, fsrs, generatorParameters, type Card, type Grade } from "ts-fsrs";
import { toKana } from "wanakana";

// Phần thuần của ôn tập: lịch FSRS, chấm cách đọc. Không đụng DB.

export { Rating, State } from "ts-fsrs";
export type { Grade } from "ts-fsrs";

export type Skill = "meaning" | "reading";

/** Từ được coi là "vững" khi mọi thẻ có stability >= ngưỡng này (ngày). */
export const MASTERED_STABILITY = 21;

/** Trạng thái thẻ đúng như cột trong bảng cards (thời gian dạng ISO UTC). */
export interface CardState {
  due: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: State;
  lastReview: string | null;
}

const scheduler = fsrs(generatorParameters({ request_retention: 0.9, enable_fuzz: true }));

export function newCardState(now: Date): CardState {
  return fromFsrs(createEmptyCard(now));
}

export function gradeCard(card: CardState, rating: Grade, now: Date): CardState {
  return fromFsrs(scheduler.next(toFsrs(card), now, rating).card);
}

/**
 * Chuẩn hóa để so cách đọc: NFKC, bỏ khoảng trắng, katakana → hiragana.
 * Giữ nguyên ー để こーひー khớp với コーヒー.
 */
export function normalizeKana(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function isReadingCorrect(answer: string, expected: string): boolean {
  const a = normalizeKana(toKana(answer));
  return a !== "" && a === normalizeKana(expected);
}

/** Đổi romaji sang kana khi đang gõ (giữ `n` cuối chờ ký tự tiếp theo). */
export function romajiToKanaWhileTyping(value: string): string {
  return toKana(value, { IMEMode: true });
}

function toFsrs(card: CardState): Card {
  return {
    due: new Date(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsedDays,
    scheduled_days: card.scheduledDays,
    learning_steps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.lastReview ? new Date(card.lastReview) : undefined,
  };
}

function fromFsrs(card: Card): CardState {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.last_review ? card.last_review.toISOString() : null,
  };
}
