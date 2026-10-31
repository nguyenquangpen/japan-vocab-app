import { State, createEmptyCard, fsrs, generatorParameters, type Card, type Grade } from "ts-fsrs";
import { toKana } from "wanakana";

// Phần thuần của ôn tập: lịch FSRS, đổi romaji sang kana. Không đụng DB.

export { Rating, State } from "ts-fsrs";
export type { Grade } from "ts-fsrs";

/** Từ được coi là "vững" khi thẻ meaning có stability >= ngưỡng này (ngày). */
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

// Tắt bước học ngắn (1 phút / 10 phút): mỗi lần chấm hẹn theo ngày (Quên ≈ 1 ngày, Nhớ ≈ 3 ngày với thẻ mới),
// nên thẻ đã kéo Nhớ không quay lại ngay. Từ vừa quên được luyện lại bằng lượt luyện thêm, không qua lịch.
const scheduler = fsrs(generatorParameters({ request_retention: 0.9, enable_fuzz: true, enable_short_term: false }));

export function newCardState(now: Date): CardState {
  return fromFsrs(createEmptyCard(now));
}

export function gradeCard(card: CardState, rating: Grade, now: Date): CardState {
  return fromFsrs(scheduler.next(toFsrs(card), now, rating).card);
}

/** Xác suất còn nhớ thẻ lúc `now` (0–1). Thẻ mới coi như 0. */
export function retrievability(card: CardState, now: Date): number {
  if (card.state === State.New) return 0;
  return scheduler.get_retrievability(toFsrs(card), now, false);
}

/** Đổi hết romaji còn sót sang kana (kể cả `n` cuối). Kana và chữ Hán giữ nguyên. */
export function romajiToKana(value: string): string {
  return toKana(value);
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
