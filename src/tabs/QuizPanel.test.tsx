// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/nodeSqliteDb";
import { addWordsToTopic, createTopic } from "../topics/topics";
import { addWord } from "../vocab/vocab";
import QuizPanel from "./QuizPanel";

afterEach(cleanup);

/** Chờ React chạy xong effect (bộ nghe phím gắn trong useEffect) trước khi gửi phím. */
const settle = () => act(async () => {});

async function startQuiz() {
  const db = createTestDb();
  const ids: number[] = [];
  for (const [term, reading, meanings] of [
    ["食べる", "たべる", "ăn"],
    ["飲む", "のむ", "uống"],
    ["見る", "みる", "xem"],
    ["行く", "いく", "đi"],
  ]) {
    const r = await addWord(db, { term, reading, meanings });
    if (r.status !== "added") throw new Error();
    ids.push(r.wordId);
  }
  const topic = await createTopic(db, "Động từ");
  if (topic.status !== "ok") throw new Error();
  await addWordsToTopic(db, topic.id, ids);

  render(<QuizPanel db={db} />);
  fireEvent.click(await screen.findByLabelText(/Động từ/));
  fireEvent.click(screen.getByRole("button", { name: "Bắt đầu" }));
  await screen.findByText(/Câu 1\/4/);
  await settle();
  return db;
}

const options = () => [...document.querySelectorAll<HTMLButtonElement>(".quiz-option")];
const correctOption = () => {
  const card = document.querySelector(".quiz") as HTMLElement;
  const term = card.querySelector(".review-term")?.textContent;
  const meaning = { 食べる: "ăn", 飲む: "uống", 見る: "xem", 行く: "đi" }[term as "食べる"];
  return options().findIndex((b) => b.textContent?.endsWith(meaning));
};

describe("QuizPanel", () => {
  it("chọn sai thì đánh dấu đáp án sai (đỏ) và đáp án đúng (xanh)", async () => {
    await startQuiz();
    const right = correctOption();
    const wrong = right === 0 ? 1 : 0;
    fireEvent.keyDown(window, { key: String(wrong + 1) });

    expect(options()[wrong].className).toContain("wrong");
    expect(options()[right].className).toContain("correct");
  });

  it("làm hết bài thì hiện điểm và lưu kết quả", async () => {
    const db = await startQuiz();
    for (let i = 0; i < 4; i++) {
      fireEvent.keyDown(window, { key: String(correctOption() + 1) });
      await settle();
      fireEvent.keyDown(window, { key: "Enter" });
      await settle();
    }
    expect(await screen.findByText("Xong quiz! 🎯")).toBeTruthy();
    expect(await db.select("SELECT total, correct FROM quiz_sessions")).toEqual([{ total: 4, correct: 4 }]);
  });
});
