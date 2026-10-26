import type { Db } from "../db/db";

/**
 * Quiz trắc nghiệm nghĩa theo chủ đề (docs/design.md mục 4). Không cập nhật lịch FSRS,
 * chỉ lưu kết quả vào quiz_sessions/quiz_answers để xem lại.
 */

export const QUIZ_MAX_QUESTIONS = 20;
const OPTION_COUNT = 4;

export interface QuizWord {
  id: number;
  term: string;
  reading: string | null;
  meanings: string[];
  topicIds: number[];
}

export interface Question {
  wordId: number;
  term: string;
  reading: string | null;
  options: string[];
  answerIndex: number;
}

export type BuildResult = { ok: true; questions: Question[] } | { ok: false; message: string };

/** Số ngẫu nhiên trong [0, 1). Truyền vào để test cố định được. */
export type Rng = () => number;

export interface QuizAnswer {
  wordId: number;
  correct: boolean;
  chosen: string;
}

export interface QuizHistoryEntry {
  id: number;
  topicNames: string[];
  total: number;
  correct: number;
  finishedAt: string;
  wrongTerms: string[];
}

/** Đáp án hiển thị cho 1 từ: tối đa 2 nghĩa đầu. */
export function optionText(meanings: string[]): string {
  return meanings.slice(0, 2).join("; ");
}

/**
 * Dựng câu hỏi từ các từ thuộc chủ đề đã chọn. Đáp án nhiễu ưu tiên từ có chung chủ đề
 * với từ đang hỏi, thiếu thì lấy từ cả kho. Không có 2 đáp án trùng chữ.
 */
export function buildQuiz(words: QuizWord[], topicIds: number[], rng: Rng = Math.random): BuildResult {
  const eligible = words.filter((w) => w.meanings.length > 0);
  const chosen = new Set(topicIds);
  const targets = eligible.filter((w) => w.topicIds.some((t) => chosen.has(t)));

  if (targets.length === 0) return { ok: false, message: "Chủ đề đã chọn chưa có từ nào có nghĩa." };
  if (new Set(eligible.map((w) => optionText(w.meanings))).size < OPTION_COUNT) {
    return { ok: false, message: `Cần ít nhất ${OPTION_COUNT} từ có nghĩa khác nhau trong kho để làm quiz.` };
  }

  const questions = shuffle(targets, rng)
    .slice(0, QUIZ_MAX_QUESTIONS)
    .map((word) => {
      const correct = optionText(word.meanings);
      const topics = new Set(word.topicIds.filter((t) => chosen.has(t)));
      const others = eligible.filter((w) => w.id !== word.id);
      const sameTopic = shuffle(others.filter((w) => w.topicIds.some((t) => topics.has(t))), rng);
      const rest = shuffle(others.filter((w) => !w.topicIds.some((t) => topics.has(t))), rng);

      const distractors: string[] = [];
      for (const w of [...sameTopic, ...rest]) {
        const text = optionText(w.meanings);
        if (text !== correct && !distractors.includes(text)) distractors.push(text);
        if (distractors.length === OPTION_COUNT - 1) break;
      }
      const options = shuffle([correct, ...distractors], rng);
      return { wordId: word.id, term: word.term, reading: word.reading, options, answerIndex: options.indexOf(correct) };
    });

  return { ok: true, questions };
}

export async function startQuiz(db: Db, topicIds: number[], rng: Rng = Math.random): Promise<BuildResult> {
  const rows = await db.select<{ id: number; term: string; reading: string | null; meanings_vi: string; topic_ids: string }>(
    `SELECT w.id, w.term, w.reading, w.meanings_vi,
       (SELECT json_group_array(wt.topic_id) FROM word_topics wt WHERE wt.word_id = w.id) AS topic_ids
     FROM words w WHERE w.meanings_vi IS NOT NULL`,
  );
  const words = rows.map((r) => ({
    id: r.id,
    term: r.term,
    reading: r.reading,
    meanings: parseArray(r.meanings_vi).filter((m): m is string => typeof m === "string"),
    topicIds: parseArray(r.topic_ids).filter((t): t is number => typeof t === "number"),
  }));
  return buildQuiz(words, topicIds, rng);
}

/** Lưu kết quả 1 lần quiz đã làm xong. Trả về id phiên. */
export async function saveQuizResult(
  db: Db,
  result: { topicNames: string[]; startedAt: Date; answers: QuizAnswer[] },
  now = new Date(),
): Promise<number> {
  const correct = result.answers.filter((a) => a.correct).length;
  const { lastInsertId } = await db.execute(
    `INSERT INTO quiz_sessions (topic_names, total, correct, started_at, finished_at) VALUES (?, ?, ?, ?, ?)`,
    [JSON.stringify(result.topicNames), result.answers.length, correct, result.startedAt.toISOString(), now.toISOString()],
  );
  const sessionId = lastInsertId!;
  if (result.answers.length > 0) {
    await db.execute(
      `INSERT INTO quiz_answers (session_id, word_id, correct, chosen)
       VALUES ${result.answers.map(() => "(?, ?, ?, ?)").join(", ")}`,
      result.answers.flatMap((a) => [sessionId, a.wordId, a.correct ? 1 : 0, a.chosen]),
    );
  }
  return sessionId;
}

/** 10 lần quiz gần nhất kèm các từ làm sai. */
export async function listQuizHistory(db: Db): Promise<QuizHistoryEntry[]> {
  const rows = await db.select<{
    id: number;
    topic_names: string;
    total: number;
    correct: number;
    finished_at: string;
    wrong_terms: string;
  }>(
    `SELECT s.id, s.topic_names, s.total, s.correct, s.finished_at,
       (SELECT json_group_array(w.term) FROM quiz_answers a JOIN words w ON w.id = a.word_id
        WHERE a.session_id = s.id AND a.correct = 0) AS wrong_terms
     FROM quiz_sessions s ORDER BY s.finished_at DESC, s.id DESC LIMIT 10`,
  );
  return rows.map((r) => ({
    id: r.id,
    topicNames: parseArray(r.topic_names).filter((n): n is string => typeof n === "string"),
    total: r.total,
    correct: r.correct,
    finishedAt: r.finished_at,
    wrongTerms: parseArray(r.wrong_terms).filter((t): t is string => typeof t === "string"),
  }));
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function parseArray(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
