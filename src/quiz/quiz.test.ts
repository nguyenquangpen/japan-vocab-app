import { describe, expect, it } from "vitest";
import { createTestDb } from "../db/nodeSqliteDb";
import { addWordsToTopic, createTopic } from "../topics/topics";
import { addWord } from "../vocab/vocab";
import { buildQuiz, listQuizHistory, optionText, saveQuizResult, startQuiz, type QuizWord } from "./quiz";

/** Rng cố định (LCG) để kết quả lặp lại được. */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

const word = (id: number, meaning: string, topicIds: number[]): QuizWord => ({
  id,
  term: `語${id}`,
  reading: null,
  meanings: [meaning],
  topicIds,
});

describe("buildQuiz", () => {
  const words = [
    word(1, "ăn", [1]),
    word(2, "uống", [1]),
    word(3, "nấu", [1]),
    word(4, "rửa", [1]),
    word(5, "chạy", [2]),
    word(6, "đi", [2]),
    word(7, "không nghĩa", [1]),
  ];
  words[6].meanings = [];

  it("chỉ hỏi từ thuộc chủ đề có nghĩa, 4 đáp án không trùng, đúng đáp án", () => {
    const result = buildQuiz(words, [1], seeded());
    if (!result.ok) throw new Error(result.message);
    expect(result.questions.map((q) => q.wordId).sort()).toEqual([1, 2, 3, 4]);
    for (const q of result.questions) {
      expect(q.options).toHaveLength(4);
      expect(new Set(q.options).size).toBe(4);
      expect(q.options[q.answerIndex]).toBe(optionText(words[q.wordId - 1].meanings));
    }
  });

  it("đáp án nhiễu ưu tiên cùng chủ đề", () => {
    const result = buildQuiz(words, [1], seeded(7));
    if (!result.ok) throw new Error(result.message);
    for (const q of result.questions) {
      expect([...q.options].sort()).toEqual(["ăn", "nấu", "rửa", "uống"].sort());
    }
  });

  it("thiếu đáp án cùng chủ đề thì lấy thêm từ cả kho", () => {
    const result = buildQuiz(words, [2], seeded());
    if (!result.ok) throw new Error(result.message);
    expect(result.questions).toHaveLength(2);
    expect(result.questions.every((q) => q.options.length === 4)).toBe(true);
  });

  it("đáp án gộp tối đa 2 nghĩa đầu", () => {
    expect(optionText(["ăn", "dùng bữa", "xơi"])).toBe("ăn; dùng bữa");
  });

  it("tối đa 20 câu", () => {
    const many = Array.from({ length: 30 }, (_, i) => word(i + 1, `nghĩa ${i}`, [1]));
    const result = buildQuiz(many, [1], seeded());
    expect(result.ok && result.questions.length).toBe(20);
  });

  it("báo lỗi khi chủ đề trống hoặc kho có dưới 4 nghĩa khác nhau", () => {
    expect(buildQuiz(words, [9], seeded())).toMatchObject({ ok: false });
    expect(buildQuiz(words.slice(0, 3), [1], seeded())).toMatchObject({ ok: false });
  });
});

describe("startQuiz + lưu kết quả", () => {
  it("đọc từ DB, lưu phiên, lịch sử có từ sai; không đụng thẻ FSRS", async () => {
    const db = createTestDb();
    const ids: number[] = [];
    for (const [term, meanings] of [["食べる", "ăn"], ["飲む", "uống"], ["見る", "xem"], ["行く", "đi"]]) {
      const r = await addWord(db, { term, meanings });
      if (r.status !== "added") throw new Error();
      ids.push(r.wordId);
    }
    const t = await createTopic(db, "Động từ");
    if (t.status !== "ok") throw new Error();
    await addWordsToTopic(db, t.id, ids.slice(0, 2));

    const quiz = await startQuiz(db, [t.id], seeded());
    if (!quiz.ok) throw new Error(quiz.message);
    expect(quiz.questions.map((q) => q.term).sort()).toEqual(["食べる", "飲む"]);

    const startedAt = new Date("2026-10-26T01:00:00Z");
    await saveQuizResult(
      db,
      {
        topicNames: ["Động từ"],
        startedAt,
        answers: [
          { wordId: ids[0], correct: true, chosen: "ăn" },
          { wordId: ids[1], correct: false, chosen: "xem" },
        ],
      },
      new Date("2026-10-26T01:05:00Z"),
    );

    expect(await listQuizHistory(db)).toEqual([
      expect.objectContaining({ topicNames: ["Động từ"], total: 2, correct: 1, wrongTerms: ["飲む"] }),
    ]);
    expect(await db.select("SELECT * FROM cards")).toEqual([]);
  });
});
