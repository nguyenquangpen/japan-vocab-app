// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../db/nodeSqliteDb";
import { loadCloze, loadOrder } from "../practice/generated";
import { addWord } from "../vocab/vocab";
import PracticeTab from "./PracticeTab";

const writeText = vi.fn();
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: (t: string) => writeText(t) }));

afterEach(() => {
  cleanup();
  writeText.mockReset();
});

describe("Luyện tập — tạo câu bằng ChatGPT", () => {
  it("copy prompt, dán JSON, lưu → mở khóa Xếp câu; không đụng lịch ôn", async () => {
    const db = createTestDb();
    for (const [term, reading, meanings] of [
      ["食べる", "たべる", "ăn"],
      ["飲む", "のむ", "uống"],
      ["見る", "みる", "xem"],
      ["行く", "いく", "đi"],
    ]) {
      const r = await addWord(db, { term, reading, meanings });
      if (r.status !== "added") throw new Error();
    }
    render(<PracticeTab db={db} generated={{ loadCloze, loadOrder }} />);

    const orderButton = await screen.findByRole("button", { name: /Xếp câu/ });
    expect((orderButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(await screen.findByRole("button", { name: "Copy prompt" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain("食べる");

    const json = JSON.stringify({
      items: [
        {
          term: "食べる",
          cloze: [{ before: "毎朝パンを", answer: "食べます", after: "。", vi: "Sáng nào tôi cũng ăn bánh mì.", distractors: ["飲みます", "見ます", "行きます"] }],
          order: [{ pieces: ["私は", "ご飯を", "食べる"], vi: "Tôi ăn cơm." }],
        },
      ],
    });
    fireEvent.change(screen.getByPlaceholderText('{"items":[...]}'), { target: { value: "Đây là kết quả:\n```json\n" + json + "\n```" } });
    fireEvent.click(screen.getByRole("button", { name: "Xem trước" }));
    expect(await screen.findByText(/1 từ khớp · 1 câu điền từ · 1 câu xếp/)).toBeTruthy();
    expect(screen.getByText(/ChatGPT chưa trả về: /)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Lưu 1 câu điền \+ 1 câu xếp/ }));
    expect(await screen.findByText(/Đã lưu 2 câu luyện tập cho 1 từ\./)).toBeTruthy();
    await vi.waitFor(() =>
      expect((screen.getByRole("button", { name: /Xếp câu/ }) as HTMLButtonElement).disabled).toBe(false),
    );

    expect(await db.select("SELECT * FROM review_logs")).toEqual([]);
    expect(await db.select("SELECT * FROM practice_items")).toHaveLength(2);
  });

  it("JSON sai thì báo lỗi tiếng Việt, không lưu gì", async () => {
    const db = createTestDb();
    const r = await addWord(db, { term: "食べる", meanings: "ăn" });
    if (r.status !== "added") throw new Error();
    render(<PracticeTab db={db} generated={{ loadCloze, loadOrder }} />);
    fireEvent.change(await screen.findByPlaceholderText('{"items":[...]}'), { target: { value: "xin lỗi, tôi không hiểu" } });
    fireEvent.click(screen.getByRole("button", { name: "Xem trước" }));
    expect(await screen.findByText(/JSON/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Lưu/ })).toBeNull();
    expect(await db.select("SELECT * FROM practice_items")).toEqual([]);
  });
});
