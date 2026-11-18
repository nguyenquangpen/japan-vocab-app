// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/db";
import { createTestDb } from "../db/nodeSqliteDb";
import type { OrderItem } from "../practice/types";
import { addWordsToTopic, createTopic } from "../topics/topics";
import { addWord } from "../vocab/vocab";
import PracticeTab, { type GeneratedSource } from "./PracticeTab";

afterEach(cleanup);

const settle = () => act(async () => {});

const WORDS: [string, string, string][] = [
  ["猫", "ねこ", "con mèo"],
  ["犬", "いぬ", "con chó"],
  ["鳥", "とり", "con chim"],
  ["魚", "さかな", "con cá"],
  ["馬", "うま", "con ngựa"],
  ["牛", "うし", "con bò"],
];
const MEANING: Record<string, string> = Object.fromEntries(WORDS.map(([t, , m]) => [t, m]));
const TERM_OF: Record<string, string> = Object.fromEntries(WORDS.map(([t, , m]) => [m, t]));
const READING: Record<string, string> = Object.fromEntries(WORDS.map(([t, r]) => [t, r]));

async function makeDb() {
  const db = createTestDb();
  const ids: number[] = [];
  for (const [term, reading, meanings] of WORDS) {
    const r = await addWord(db, { term, reading, meanings });
    if (r.status !== "added") throw new Error();
    ids.push(r.wordId);
  }
  await db.execute("INSERT INTO examples (word_id, ja, reading, vi) VALUES (?, ?, ?, ?)", [
    ids[0],
    "猫が好きです。",
    null,
    "Tôi thích mèo.",
  ]);
  return { db, ids };
}

async function open(db: Db, generated?: GeneratedSource) {
  render(<PracticeTab db={db} generated={generated} />);
  await screen.findByText(/6 từ có nghĩa trong phạm vi/);
  await settle();
}

const button = (name: RegExp) => screen.getByRole("button", { name });
const snapshot = async (db: Db) => ({
  cards: await db.select("SELECT * FROM cards ORDER BY id"),
  logs: await db.select("SELECT * FROM review_logs ORDER BY id"),
});

describe("PracticeTab", () => {
  it("nối từ: cặp đúng khoá xanh, cặp sai báo đỏ và tính lỗi", async () => {
    const { db } = await makeDb();
    await open(db);
    fireEvent.click(button(/Nối từ/));
    const items = () => [...document.querySelectorAll<HTMLButtonElement>(".match-item")];
    // Chữ chính của thẻ (thẻ trái còn có dòng kana xanh .kana-note).
    const txt = (b: HTMLButtonElement) => b.querySelector(".match-text")?.textContent ?? "";
    const left = () => items().filter((b) => txt(b) in MEANING);
    const rightFor = (term: string) => items().find((b) => txt(b) === MEANING[term])!;
    const rightNotFor = (term: string) => items().find((b) => txt(b) in TERM_OF && txt(b) !== MEANING[term])!;

    const first = left()[0];
    const term = txt(first);
    const wrongRight = rightNotFor(term);
    fireEvent.click(first);
    fireEvent.click(wrongRight);
    const wrongText = txt(wrongRight);
    expect(items().find((b) => txt(b) === wrongText)!.className).toContain("wrong");

    fireEvent.click(left()[0]);
    fireEvent.click(rightFor(term));
    expect(rightFor(term).className).toContain("correct");
    expect(rightFor(term).disabled).toBe(true);

    // Thẻ chữ Hán có kana xanh bên dưới.
    expect(first.querySelector(".kana-note")?.textContent).toBe(READING[term]);

    // Nối nốt các vòng.
    while (!screen.queryByText(/Xong bài/)) {
      for (const l of left().filter((b) => !b.disabled)) {
        fireEvent.click(l);
        fireEvent.click(rightFor(txt(l)));
      }
      fireEvent.click(button(/Vòng tiếp|Xem kết quả/));
    }
    expect(await screen.findByText(/Xong bài/)).toBeTruthy();
    expect(screen.getByText("Chỗ sai")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("chọn từ đúng: phím số chọn, Enter sang câu; không đổi cards/review_logs", async () => {
    const { db } = await makeDb();
    await open(db);
    const before = await snapshot(db);
    fireEvent.click(button(/Chọn từ đúng/));
    await settle();
    for (let i = 0; i < 6; i++) {
      const prompt = document.querySelector(".choice-prompt")!.textContent!;
      const options = [...document.querySelectorAll<HTMLButtonElement>(".quiz-option")];
      const right = options.findIndex((b) => b.textContent!.endsWith(TERM_OF[prompt]));
      fireEvent.keyDown(window, { key: String(right + 1) });
      expect(options[right].className).toContain("correct");
      await settle();
      fireEvent.keyDown(window, { key: "Enter" });
      await settle();
    }
    expect(await screen.findByText(/Xong bài/)).toBeTruthy();
    expect(screen.queryByText("Chỗ sai")).toBeNull();
    expect(await snapshot(db)).toEqual(before);

    // Báo Hub: đúng 1 sự kiện lesson.completed trong outbox, điểm 100.
    await vi.waitFor(async () => {
      const rows = await db.select<{ event_type: string; payload: string }>("SELECT event_type, payload FROM hub_outbox");
      expect(rows.map((r) => r.event_type)).toEqual(["lesson.completed"]);
      const env = JSON.parse(rows[0].payload);
      expect(env.data).toMatchObject({ title: "Luyện tập: Chọn từ đúng", score: 100 });
      expect(env.subject.type).toBe("lesson");
    });
  });

  it("điền từ: dựng câu từ ví dụ có sẵn", async () => {
    const { db } = await makeDb();
    await open(db);
    fireEvent.click(button(/Điền từ vào câu/));
    await settle();
    expect(document.querySelector(".cloze-sentence")!.textContent).toBe("＿＿が好きです。");
    expect(screen.getByText("Tôi thích mèo.")).toBeTruthy();
    const options = [...document.querySelectorAll<HTMLButtonElement>(".quiz-option")];
    expect(options).toHaveLength(4);
    const wrong = options.findIndex((b) => !b.textContent!.endsWith("猫"));
    fireEvent.click(options[wrong]);
    expect(options[wrong].className).toContain("wrong");
    expect(document.querySelector(".cloze-sentence")!.textContent).toBe("猫が好きです。");
    fireEvent.click(button(/Xem kết quả/));
    expect(await screen.findByText("Chỗ sai")).toBeTruthy();
  });

  it("xếp câu: không có nguồn thì khoá nút; có nguồn thì xếp và kiểm tra", async () => {
    const { db, ids } = await makeDb();
    await open(db);
    expect(button(/Xếp câu/)).toHaveProperty("disabled", true);
    expect(screen.getByText(/Chưa có câu xếp/)).toBeTruthy();
    cleanup();

    const item: OrderItem = { kind: "order", id: 1, wordId: ids[0], pieces: ["私は", "猫が", "好きです"], readings: ["わたしは", "ねこが", "すきです"], vi: "Tôi thích mèo." };
    const generated: GeneratedSource = {
      loadCloze: () => Promise.resolve([]),
      loadOrder: (_db, wordIds) => Promise.resolve(wordIds.includes(ids[0]) ? [item] : []),
    };
    await open(db, generated);
    fireEvent.click(button(/Xếp câu/));
    await settle();
    const pool = () => [...document.querySelectorAll<HTMLButtonElement>(".order-pool .order-piece")];
    const txt = (b: Element) => b.querySelector(".piece-text")?.textContent ?? "";
    const piece = (t: string) => pool().find((b) => txt(b) === t)!;
    const placed = () => [...document.querySelectorAll<HTMLButtonElement>(".order-answer .order-piece")];

    // Mỗi mảnh có kana xanh bên dưới.
    expect(piece("猫が").querySelector(".kana-note")?.textContent).toBe("ねこが");

    // Gỡ một mảnh.
    fireEvent.click(piece("猫が"));
    expect(placed().map(txt)).toEqual(["猫が"]);
    fireEvent.click(placed()[0]);
    expect(placed()).toHaveLength(0);

    // Xếp sai: không có nút sang câu tiếp, phải xếp lại.
    for (const t of ["猫が", "私は", "好きです"]) fireEvent.click(piece(t));
    fireEvent.click(button(/Kiểm tra/));
    expect(screen.getByText(/Chưa đúng, thử lại/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Xem kết quả|Câu tiếp/ })).toBeNull();

    // Sai lần 2 thì có gợi ý.
    fireEvent.click(button(/Xếp lại từ đầu/));
    for (const t of ["好きです", "私は", "猫が"]) fireEvent.click(piece(t));
    fireEvent.click(button(/Kiểm tra/));
    expect(screen.getByText(/Gợi ý:/)).toBeTruthy();

    // Xếp đúng mới được sang tiếp; câu này không tính điểm vì đã sai trước đó.
    fireEvent.click(button(/Xếp lại từ đầu/));
    for (const t of item.pieces) fireEvent.click(piece(t));
    fireEvent.click(button(/Kiểm tra/));
    expect(screen.getByText(/Chính xác!/)).toBeTruthy();
    fireEvent.click(button(/Xem kết quả/));
    expect(await screen.findByText(/Xong bài/)).toBeTruthy();
  });

  it("phạm vi theo chủ đề chỉ đếm từ của chủ đề", async () => {
    const { db, ids } = await makeDb();
    const topic = await createTopic(db, "Thú nuôi");
    if (topic.status !== "ok") throw new Error();
    await addWordsToTopic(db, topic.id, ids.slice(0, 2));
    await open(db);
    fireEvent.click(screen.getByLabelText(/Theo chủ đề/));
    expect(await screen.findByText(/Chọn ít nhất 1 chủ đề/)).toBeTruthy();
    fireEvent.click(await screen.findByLabelText(/Thú nuôi/));
    expect(await screen.findByText(/2 từ có nghĩa trong phạm vi/)).toBeTruthy();
    expect(button(/Nối từ/)).toHaveProperty("disabled", true);
    expect(screen.getAllByText(/Cần ít nhất 4 từ/).length).toBeGreaterThan(0);
  });
});
