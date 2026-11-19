import { describe, expect, it } from "vitest";
import type { ReviewItem } from "../review/review";
import { newCardState } from "../review/scheduler";
import {
  buildChoiceQuestions,
  buildClozeQuestions,
  buildKanaMatchRound,
  buildMatchRound,
  clozeFromExamples,
  dedupeCloze,
  orderPiecesCheck,
  shufflePieces,
} from "./exercises";

/** rng cố định (LCG) để test lặp lại được. */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function word(id: number, term: string, reading: string | null, meanings: string[], extra: Partial<ReviewItem> = {}) {
  return {
    cardId: id,
    wordId: id,
    card: newCardState(new Date(0)),
    term,
    reading,
    meanings,
    example: null,
    meaningDetail: null,
    kanaOnly: false,
    ...extra,
  } as ReviewItem;
}

const WORDS = [
  word(1, "猫", "ねこ", ["con mèo", "mèo", "miêu"]),
  word(2, "犬", "いぬ", ["con chó"]),
  word(3, "鳥", "とり", ["con chim"]),
  word(4, "魚", "さかな", ["con cá"]),
  word(5, "馬", "うま", ["con ngựa"]),
  word(6, "牛", "うし", ["con bò"]),
  word(7, "ねこ", "ねこ", ["con mèo", "mèo"], { kanaOnly: true }),
];

describe("buildMatchRound", () => {
  it("tạo cặp từ ↔ 1–2 nghĩa đầu, bỏ nghĩa trùng, hai cột xáo riêng", () => {
    const round = buildMatchRound(WORDS, 10, seeded());
    expect(round.left).toHaveLength(6);
    expect(round.right).toHaveLength(6);
    const rights = round.right.map((c) => c.text);
    expect(new Set(rights).size).toBe(6);
    expect(rights.filter((t) => t === "con mèo; mèo")).toHaveLength(1);
    for (const l of round.left) {
      const r = round.right.find((c) => c.key === l.key);
      const w = WORDS.find((x) => x.wordId === l.key)!;
      expect(l.text).toBe(w.term);
      expect(r?.text).toBe(w.meanings.slice(0, 2).join("; "));
    }
  });

  it("giới hạn theo size", () => {
    expect(buildMatchRound(WORDS, 5, seeded(3)).left).toHaveLength(5);
  });
});

describe("buildKanaMatchRound", () => {
  it("chỉ lấy từ có chữ Hán và cách đọc", () => {
    const words = [...WORDS, word(8, "本", null, ["sách"])];
    const round = buildKanaMatchRound(words, 10, seeded());
    expect(round.left.map((c) => c.key).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(round.right.find((c) => c.key === 4)?.text).toBe("さかな");
  });
});

describe("buildChoiceQuestions", () => {
  it("4 lựa chọn khác nhau, đáp án đúng ở answerIndex", () => {
    const qs = buildChoiceQuestions(WORDS, 10, seeded());
    expect(qs).toHaveLength(7);
    for (const q of qs) {
      const w = WORDS.find((x) => x.wordId === q.wordId)!;
      expect(q.options).toHaveLength(4);
      expect(new Set(q.options).size).toBe(4);
      expect(q.options[q.answerIndex]).toBe(w.term);
      expect(q.prompt).toBe(w.meanings.join("; "));
      // Kana dưới từng lựa chọn, đúng thứ tự lựa chọn.
      expect(q.optionNotes).toHaveLength(4);
      q.options.forEach((o, i) => {
        const ow = WORDS.find((x) => x.term === o)!;
        expect(q.optionNotes![i]).toBe(!ow.kanaOnly && ow.reading && ow.reading !== ow.term ? ow.reading : null);
      });
    }
  });

  it("ít hơn 4 từ thì không tạo được câu", () => {
    expect(buildChoiceQuestions(WORDS.slice(0, 3), 10, seeded())).toEqual([]);
  });

  it("giới hạn theo count", () => {
    expect(buildChoiceQuestions(WORDS, 3, seeded())).toHaveLength(3);
  });
});

describe("buildChoiceQuestions — từ cùng nghĩa", () => {
  it("không đưa từ có chung nghĩa làm đáp án nhiễu (tránh 2 đáp án đúng)", () => {
    const words = [
      word(1, "食べる", "たべる", ["ăn"]),
      word(2, "食う", "くう", ["ăn", "đớp"]),
      word(3, "飲む", "のむ", ["uống"]),
      word(4, "見る", "みる", ["xem"]),
      word(5, "行く", "いく", ["đi"]),
    ];
    for (let seed = 1; seed < 20; seed++) {
      for (const q of buildChoiceQuestions(words, 10, seeded(seed))) {
        if (q.wordId === 1) expect(q.options).not.toContain("食う");
        if (q.wordId === 2) expect(q.options).not.toContain("食べる");
      }
    }
  });
});

describe("clozeFromExamples / buildClozeQuestions", () => {
  const withExample = [
    word(1, "猫", "ねこ", ["mèo"], { example: { ja: "猫が好きです。", reading: null, vi: "Thích mèo." } }),
    word(2, "食べる", "たべる", ["ăn"], { example: { ja: "パンを食べた。", reading: null, vi: null } }),
    ...WORDS.slice(1, 5),
  ];

  it("chỉ lấy câu chứa nguyên văn từ", () => {
    expect(clozeFromExamples(withExample)).toEqual([
      { kind: "cloze", id: 0, wordId: 1, before: "", answer: "猫", after: "が好きです。", vi: "Thích mèo.", distractors: [] },
    ]);
  });

  it("bỏ câu mà từ xuất hiện 2 lần (phần còn lại sẽ lộ đáp án)", () => {
    const twice = [word(1, "猫", "ねこ", ["mèo"], { example: { ja: "猫が好き。猫だ。", reading: null, vi: null } })];
    expect(clozeFromExamples(twice)).toEqual([]);
  });

  it("4 lựa chọn: đáp án + nhiễu của câu + từ khác", () => {
    const item = { ...clozeFromExamples(withExample)[0], distractors: ["犬", "猫"] };
    const [q] = buildClozeQuestions([item], withExample, 10, seeded());
    expect(q.options).toHaveLength(4);
    expect(new Set(q.options).size).toBe(4);
    expect(q.options[q.answerIndex]).toBe("猫");
    expect(q.options).toContain("犬");
    expect(q.prompt).toBe("＿＿が好きです。");
  });

  it("dedupeCloze bỏ câu trùng", () => {
    const [a] = clozeFromExamples(withExample);
    expect(dedupeCloze([{ ...a, id: 5 }, a])).toEqual([{ ...a, id: 5 }]);
  });
});

describe("orderPiecesCheck / shufflePieces", () => {
  it("kiểm tra thứ tự", () => {
    expect(orderPiecesCheck(["私は", "学生", "です"], ["私は", "学生", "です"])).toBe(true);
    expect(orderPiecesCheck(["私は", "学生", "です"], ["学生", "私は", "です"])).toBe(false);
    expect(orderPiecesCheck(["私は", "学生", "です"], ["私は", "学生"])).toBe(false);
  });

  it("xáo không trả lại thứ tự gốc, giữ đủ mảnh", () => {
    const pieces = ["私は", "学生", "です"];
    for (let seed = 1; seed < 30; seed++) {
      const s = shufflePieces(pieces, seeded(seed));
      expect(orderPiecesCheck(pieces, s)).toBe(false);
      expect([...s].sort()).toEqual([...pieces].sort());
    }
    // rng luôn trả 0.999 → shuffle giữ nguyên thứ tự: vẫn phải khác gốc.
    expect(shufflePieces(["a", "b"], () => 0.999)).toEqual(["b", "a"]);
    expect(shufflePieces(["a"], seeded())).toEqual(["a"]);
  });
});
