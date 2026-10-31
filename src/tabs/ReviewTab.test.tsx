// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/db";
import { createTestDb } from "../db/nodeSqliteDb";
import { saveSettings, DEFAULT_SETTINGS } from "../settings/settings";
import { addWord } from "../vocab/vocab";
import ReviewTab from "./ReviewTab";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

afterEach(cleanup);

/** Chờ React chạy xong effect (bộ nghe phím gắn trong useEffect) trước khi gửi phím. */
const settle = () => act(async () => {});

const WORDS: [string, string, string][] = [
  ["猫", "ねこ", "con mèo"],
  ["犬", "いぬ", "con chó"],
  ["鳥", "とり", "con chim"],
  ["魚", "さかな", "con cá"],
  ["馬", "うま", "con ngựa"],
  ["牛", "うし", "con bò"],
];

async function setup(count = 1, sessionSize = 5) {
  const db = createTestDb();
  await saveSettings(db, { ...DEFAULT_SETTINGS, sessionSize, newPerDay: 10 });
  for (const [i, [term, reading, meanings]] of WORDS.slice(0, count).entries()) {
    const r = await addWord(db, { term, reading, meanings }, new Date(Date.UTC(2026, 0, 1, 0, i)));
    if (r.status !== "added") throw new Error();
    if (i === 0) {
      await db.execute("INSERT INTO examples (word_id, ja, reading, vi) VALUES (?, ?, ?, ?)", [
        r.wordId,
        "猫が好きです。",
        "ねこがすきです。",
        "Tôi thích mèo.",
      ]);
    }
  }
  render(<ReviewTab db={db} />);
  // Mở tab là màn chọn phạm vi; mặc định "Tất cả từ" → bấm "Ôn theo lịch".
  await startFromSetup(/Ôn theo lịch/);
  return db;
}

async function startFromSetup(button: RegExp) {
  await screen.findByText("1. Ôn phần nào?");
  const start = await screen.findByRole("button", { name: button });
  await vi.waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
  await screen.findByText("Bạn có nhớ từ này?");
  await settle();
}

const front = () => document.querySelector(".flip-front") as HTMLElement;
const back = () => document.querySelector(".flip-back") as HTMLElement;
const card = () => document.querySelector(".swipe-card") as HTMLElement;
const isFlipped = () => document.querySelector(".flip-card.flipped") !== null;
const logs = (db: Db) => db.select<{ correct: number }>("SELECT correct FROM review_logs ORDER BY id");
const currentTerm = () => front().querySelector(".review-term")?.textContent;
const count = (label: "Quên" | "Nhớ") => screen.getByLabelText(new RegExp(`^${label}: \\d+ từ$`)).textContent;

async function answerAll(keys: ("ArrowLeft" | "ArrowRight")[]) {
  for (const key of keys) {
    await settle();
    const before = currentTerm();
    fireEvent.keyDown(window, { key });
    await vi.waitFor(() => expect(document.querySelector(".session-end") ?? currentTerm() !== before).toBeTruthy());
  }
}

describe("ReviewTab — flashcard", () => {
  it("mặt trước: chữ Hán + kana, không có ô gõ, chưa lộ nghĩa; mặt sau: nghĩa + ví dụ", async () => {
    await setup();
    expect(front().textContent).toContain("猫");
    expect(front().textContent).toContain("ねこ");
    expect(front().textContent).not.toContain("con mèo");
    expect(document.querySelector("input")).toBeNull();
    expect(back().textContent).toContain("con mèo");
    // Ví dụ trên mặt sau: câu chữ Hán + cách đọc kana + nghĩa.
    expect(back().querySelector(".example-ja")?.textContent).toBe("猫が好きです。");
    expect(back().querySelector(".example-reading")?.textContent).toBe("ねこがすきです。");
    expect(back().querySelector(".example-vi")?.textContent).toBe("Tôi thích mèo.");
  });

  it("bấm vào thẻ (không kéo) thì lật, bấm lần nữa lật lại; Space cũng lật", async () => {
    await setup();
    fireEvent.pointerDown(card(), { clientX: 100, button: 0 });
    fireEvent.pointerUp(card(), { clientX: 100, button: 0 });
    expect(isFlipped()).toBe(true);
    fireEvent.pointerDown(card(), { clientX: 100, button: 0 });
    fireEvent.pointerUp(card(), { clientX: 100, button: 0 });
    expect(isFlipped()).toBe(false);
    await settle();
    fireEvent.keyDown(window, { key: " " });
    expect(isFlipped()).toBe(true);
  });

  it("kéo phải = Nhớ, kéo trái = Quên; kéo chưa đủ xa thì bật về", async () => {
    const db = await setup(3);
    fireEvent.pointerDown(card(), { clientX: 100, button: 0 });
    fireEvent.pointerMove(card(), { clientX: 160 });
    fireEvent.pointerUp(card(), { clientX: 160, button: 0 });
    expect(card().style.transform).toBe("translateX(0px) rotate(0deg)");

    fireEvent.pointerDown(card(), { clientX: 100, button: 0 });
    fireEvent.pointerMove(card(), { clientX: 300 });
    fireEvent.pointerUp(card(), { clientX: 300, button: 0 });
    await vi.waitFor(async () => expect(await logs(db)).toEqual([{ correct: 1 }]));
    await vi.waitFor(() => expect(currentTerm()).toBe("犬"));

    fireEvent.pointerDown(card(), { clientX: 300, button: 0 });
    fireEvent.pointerMove(card(), { clientX: 100 });
    fireEvent.pointerUp(card(), { clientX: 100, button: 0 });
    await vi.waitFor(async () => expect(await logs(db)).toEqual([{ correct: 1 }, { correct: 0 }]));
  });

  it("số Quên/Nhớ hiện ngay trên nút và tăng theo từng thẻ", async () => {
    await setup(3);
    expect(count("Quên")).toBe("0");
    expect(count("Nhớ")).toBe("0");
    await answerAll(["ArrowLeft"]);
    expect(count("Quên")).toBe("1");
    await answerAll(["ArrowRight"]);
    expect(count("Nhớ")).toBe("1");
  });

  it("mỗi thẻ chỉ hiện 1 lần trong lượt: Nhớ rồi thì không quay lại (bug cũ)", async () => {
    const db = await setup(2);
    await answerAll(["ArrowRight", "ArrowRight"]);
    expect(await screen.findByText("Xong lượt! 🎉")).toBeTruthy();
    expect(await logs(db)).toHaveLength(2);
    // Không còn thẻ đến hạn / từ mới: không có nút lượt ôn tiếp theo.
    expect(screen.queryByRole("button", { name: /Lượt ôn tiếp theo/ })).toBeNull();
  });
});

describe("ReviewTab — chọn phạm vi ôn", () => {
  async function setupTopics() {
    const db = createTestDb();
    const ids: number[] = [];
    for (const [i, [term, reading, meanings]] of WORDS.slice(0, 4).entries()) {
      const r = await addWord(db, { term, reading, meanings }, new Date(Date.UTC(2026, 0, 1, 0, i)));
      if (r.status !== "added") throw new Error();
      ids.push(r.wordId);
    }
    const { lastInsertId: pets } = await db.execute("INSERT INTO topics (name) VALUES (?)", ["Thú cưng"]);
    await db.execute("INSERT INTO word_topics (word_id, topic_id) VALUES (?, ?), (?, ?)", [ids[0], pets, ids[1], pets]);
    render(<ReviewTab db={db} />);
    await screen.findByText("1. Ôn phần nào?");
    return db;
  }

  it("mở tab không vào ôn ngay mà hiện lựa chọn phạm vi và cách ôn", async () => {
    await setupTopics();
    expect(screen.queryByText("Bạn có nhớ từ này?")).toBeNull();
    expect(screen.getByLabelText(/Tất cả từ/)).toBeTruthy();
    expect(screen.getByLabelText(/Theo chủ đề/)).toBeTruthy();
    expect(screen.getByLabelText(/Từ chưa có chủ đề/)).toBeTruthy();
    expect(await screen.findByText(/Đi hết 4 từ/)).toBeTruthy();
  });

  it("theo chủ đề: chỉ ôn từ thuộc chủ đề đã chọn", async () => {
    await setupTopics();
    fireEvent.click(screen.getByLabelText(/Theo chủ đề/));
    expect(await screen.findByText("Chọn ít nhất 1 chủ đề.")).toBeTruthy();
    fireEvent.click(await screen.findByLabelText(/Thú cưng/));
    expect(await screen.findByText(/Đi hết 2 từ/)).toBeTruthy();

    await startFromSetup(/Luyện toàn bộ/);
    expect(screen.getByText(/Chủ đề: Thú cưng/)).toBeTruthy();
    const seen = new Set<string>();
    for (let i = 0; i < 2; i++) {
      seen.add(currentTerm() ?? "");
      await answerAll(["ArrowRight"]);
    }
    expect([...seen].sort()).toEqual(["犬", "猫"].sort());
  });

  it("từ chưa có chủ đề: chỉ ôn các từ chưa gắn chủ đề; hết lượt có nút đổi phạm vi", async () => {
    await setupTopics();
    fireEvent.click(screen.getByLabelText(/Từ chưa có chủ đề/));
    expect(await screen.findByText(/Đi hết 2 từ/)).toBeTruthy();
    await startFromSetup(/Ôn theo lịch/);
    const seen = new Set<string>();
    for (let i = 0; i < 2; i++) {
      seen.add(currentTerm() ?? "");
      await answerAll(["ArrowRight"]);
    }
    expect([...seen].sort()).toEqual(["魚", "鳥"].sort());

    fireEvent.click(await screen.findByRole("button", { name: /Đổi phạm vi ôn/ }));
    expect(await screen.findByText("1. Ôn phần nào?")).toBeTruthy();
  });
});

describe("ReviewTab — hết lượt và luyện thêm", () => {
  it("hết lượt: chúc mừng, pháo giấy, ôn lại từ vừa quên (không ghi DB)", async () => {
    const db = await setup(3, 5);
    await answerAll(["ArrowLeft", "ArrowRight", "ArrowLeft"]);

    expect(await screen.findByText("Xong lượt! 🎉")).toBeTruthy();
    expect(document.querySelector(".confetti")).toBeTruthy();
    expect(document.querySelector(".cheer")?.textContent).toBeTruthy();
    expect(screen.getByText("Các từ đã quên")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Ôn lại 2 từ vừa quên/ }));
    await screen.findByText("Ôn lại từ vừa quên");
    expect(["猫", "鳥"]).toContain(currentTerm());
    await answerAll(["ArrowRight", "ArrowRight"]);
    expect(await screen.findByText("Xong lượt! 🎉")).toBeTruthy();
    // Luyện thêm không ghi review_logs.
    expect(await logs(db)).toHaveLength(3);
  });

  it("học thêm từ mới vượt giới hạn ngày; hết vốn từ thì hiện thông báo và luyện lại toàn bộ", async () => {
    const db = await setup(6, 5);
    await saveSettings(db, { ...DEFAULT_SETTINGS, sessionSize: 5, newPerDay: 5 });
    await answerAll(["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"]);

    fireEvent.click(await screen.findByRole("button", { name: /Học thêm từ mới \(1 từ\)/ }));
    await screen.findByText("Học thêm từ mới");
    await answerAll(["ArrowRight"]);

    expect(await screen.findByText("🏁 Bạn đã ôn hết toàn bộ vốn từ!")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Luyện lại toàn bộ từ đầu \(6 từ\)/ }));
    await screen.findByText("Luyện lại toàn bộ");
    await answerAll(["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"]);
    fireEvent.click(await screen.findByRole("button", { name: /Luyện tiếp toàn bộ \(còn 1 từ\)/ }));
    await screen.findByText("Thẻ 1/1");
    expect(await logs(db)).toHaveLength(6);
  });
});
