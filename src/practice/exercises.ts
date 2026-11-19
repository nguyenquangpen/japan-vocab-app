import { shuffle, type ReviewItem, type Rng } from "../review/review";
import type { ClozeItem } from "./types";

/**
 * Bài luyện tập (tab Luyện tập): hàm thuần, không đụng DB, không đổi lịch ôn FSRS.
 * `rng` truyền vào để test cố định được.
 */

export interface MatchCard {
  /** wordId của cặp: thẻ trái và thẻ phải cùng `key` là một cặp đúng. */
  key: number;
  text: string;
  /** Dòng phụ nhỏ (kana) dưới chữ Hán, chỉ có ở bài Nối từ. */
  sub?: string;
}

export interface MatchRound {
  left: MatchCard[];
  right: MatchCard[];
}

/** Nghĩa ngắn để nối: 1–2 nghĩa đầu, nối bằng "; ". */
export function shortMeaning(word: Pick<ReviewItem, "meanings">): string {
  return word.meanings.slice(0, 2).join("; ");
}

function roundFrom(pairs: { key: number; left: string; right: string; leftSub?: string }[], rng: Rng): MatchRound {
  return {
    left: shuffle(
      pairs.map((p) => ({ key: p.key, text: p.left, ...(p.leftSub ? { sub: p.leftSub } : {}) })),
      rng,
    ),
    right: shuffle(pairs.map((p) => ({ key: p.key, text: p.right })), rng),
  };
}

/** Chọn tối đa `size` cặp, bỏ cặp trùng chữ bên trái hoặc bên phải (để không có 2 đáp án đúng). */
function pickPairs(
  candidates: { key: number; left: string; right: string; leftSub?: string }[],
  size: number,
  rng: Rng,
) {
  const seenLeft = new Set<string>();
  const seenRight = new Set<string>();
  const pairs: typeof candidates = [];
  for (const c of shuffle(candidates, rng)) {
    if (pairs.length >= size) break;
    if (!c.left || !c.right || seenLeft.has(c.left) || seenRight.has(c.right)) continue;
    seenLeft.add(c.left);
    seenRight.add(c.right);
    pairs.push(c);
  }
  return pairs;
}

/** Nối từ: từ (trái) ↔ nghĩa (phải). */
export function buildMatchRound(words: ReviewItem[], size = 5, rng: Rng = Math.random): MatchRound {
  // Kana nhỏ dưới chữ Hán (bỏ nếu từ toàn kana / không có kana).
  const candidates = words.map((w) => ({
    key: w.wordId,
    left: w.term,
    right: shortMeaning(w),
    leftSub: !w.kanaOnly && w.reading && w.reading !== w.term ? w.reading : undefined,
  }));
  return roundFrom(pickPairs(candidates, size, rng), rng);
}

/** Từ dùng được cho bài nối chữ Hán ↔ kana. */
export function kanaMatchWords(words: ReviewItem[]): ReviewItem[] {
  return words.filter((w) => !w.kanaOnly && w.reading !== null && w.reading !== "" && w.reading !== w.term);
}

/** Nối chữ Hán ↔ kana: chỉ từ có cách đọc và không viết toàn kana. */
export function buildKanaMatchRound(words: ReviewItem[], size = 5, rng: Rng = Math.random): MatchRound {
  const candidates = kanaMatchWords(words).map((w) => ({ key: w.wordId, left: w.term, right: w.reading ?? "" }));
  return roundFrom(pickPairs(candidates, size, rng), rng);
}

export interface ChoiceQuestion {
  wordId: number;
  /** Đề bài: nghĩa tiếng Việt (chọn từ) hoặc câu khuyết (điền từ). */
  prompt: string;
  options: string[];
  answerIndex: number;
  /** Kana nhỏ dưới từng lựa chọn (chỉ bài Chọn từ đúng; null nếu từ toàn kana / chưa có kana). */
  optionNotes?: (string | null)[];
}

/** Ghép đáp án đúng với nhiễu (khác chữ nhau), bù bằng `fallback`, rồi xáo. null nếu không đủ 4 lựa chọn. */
function makeOptions(answer: string, distractors: string[], fallback: string[], rng: Rng, n = 4) {
  const options = [answer];
  for (const d of [...distractors, ...shuffle(fallback, rng)]) {
    if (options.length >= n) break;
    if (d && !options.includes(d)) options.push(d);
  }
  if (options.length < n) return null;
  const shuffled = shuffle(options, rng);
  return { options: shuffled, answerIndex: shuffled.indexOf(answer) };
}

/** Chọn từ đúng (Việt → Nhật): đề là nghĩa, 4 lựa chọn là từ tiếng Nhật. */
export function buildChoiceQuestions(words: ReviewItem[], count = 10, rng: Rng = Math.random): ChoiceQuestion[] {
  const norm = (m: string) => m.normalize("NFKC").trim().toLowerCase();
  // Kana của từng từ để hiện nhỏ dưới chữ Hán (bỏ từ toàn kana / kana trùng chữ).
  const kanaOf = new Map<string, string>();
  for (const o of words) {
    if (!o.kanaOnly && o.reading && o.reading !== o.term && !kanaOf.has(o.term)) kanaOf.set(o.term, o.reading);
  }
  const questions: ChoiceQuestion[] = [];
  for (const w of shuffle(words, rng)) {
    if (questions.length >= count) break;
    // Bỏ từ có chung nghĩa (vd. 食べる / 食う cùng "ăn") để không có 2 đáp án đúng.
    const mine = new Set(w.meanings.map(norm));
    const terms = [
      ...new Set(
        words.filter((o) => o.term === w.term || !o.meanings.some((m) => mine.has(norm(m)))).map((o) => o.term),
      ),
    ];
    const made = makeOptions(w.term, [], terms, rng);
    if (!made) continue;
    questions.push({
      wordId: w.wordId,
      prompt: w.meanings.join("; "),
      ...made,
      optionNotes: made.options.map((o) => kanaOf.get(o) ?? null),
    });
  }
  return questions;
}

/** Câu điền từ dựng từ câu ví dụ có sẵn: chỉ khi câu chứa nguyên văn từ (khoét ở lần xuất hiện đầu). */
export function clozeFromExamples(words: ReviewItem[]): ClozeItem[] {
  const items: ClozeItem[] = [];
  for (const w of words) {
    const ja = w.example?.ja;
    if (!ja || !w.term) continue;
    const at = ja.indexOf(w.term);
    // Từ xuất hiện 2 lần thì phần còn lại sẽ lộ đáp án: bỏ câu này.
    if (at < 0 || ja.indexOf(w.term, at + w.term.length) >= 0) continue;
    items.push({
      kind: "cloze",
      id: 0,
      wordId: w.wordId,
      before: ja.slice(0, at),
      answer: w.term,
      after: ja.slice(at + w.term.length),
      vi: w.example?.vi ?? null,
      distractors: [],
    });
  }
  return items;
}

export interface ClozeQuestion extends ChoiceQuestion {
  item: ClozeItem;
}

/** Điền từ vào câu: 4 lựa chọn = đáp án + nhiễu của câu, bù bằng từ khác trong phạm vi. */
export function buildClozeQuestions(
  items: ClozeItem[],
  words: ReviewItem[],
  count = 10,
  rng: Rng = Math.random,
): ClozeQuestion[] {
  const terms = [...new Set(words.map((w) => w.term))];
  const questions: ClozeQuestion[] = [];
  for (const item of shuffle(items, rng)) {
    if (questions.length >= count) break;
    const made = makeOptions(item.answer, item.distractors, terms, rng);
    if (!made) continue;
    questions.push({ wordId: item.wordId, prompt: `${item.before}＿＿${item.after}`, item, ...made });
  }
  return questions;
}

/** Bỏ câu điền trùng nhau (cùng before + answer + after), giữ câu xuất hiện trước. */
export function dedupeCloze(items: ClozeItem[]): ClozeItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.before}\u0000${i.answer}\u0000${i.after}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Xếp câu: đúng khi chuỗi mảnh ghép lại trùng câu gốc (cho phép mảnh trùng chữ đổi chỗ nhau). */
export function orderPiecesCheck(pieces: string[], attempt: string[]): boolean {
  return attempt.length === pieces.length && attempt.join("") === pieces.join("");
}

/** Xáo mảnh; nếu có > 1 mảnh khác nhau thì không trả lại đúng thứ tự gốc. */
export function shufflePieces(pieces: string[], rng: Rng = Math.random): string[] {
  if (pieces.length <= 1 || new Set(pieces).size <= 1) return [...pieces];
  for (let i = 0; i < 10; i++) {
    const s = shuffle(pieces, rng);
    if (!orderPiecesCheck(pieces, s)) return s;
  }
  // rng xui: xoay vòng 1 bước là chắc chắn khác (vì có ít nhất 2 mảnh khác chữ).
  const rotated = [...pieces.slice(1), pieces[0]];
  return orderPiecesCheck(pieces, rotated) ? [...pieces].reverse() : rotated;
}
