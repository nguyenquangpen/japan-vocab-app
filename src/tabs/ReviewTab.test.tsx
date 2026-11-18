// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/db";
import { createTestDb } from "../db/nodeSqliteDb";
import { resetOldWordsMemory } from "../review/oldWordsMemory";
import { DEFAULT_SETTINGS, saveSettings } from "../settings/settings";
import { addWord } from "../vocab/vocab";
import ReviewTab from "./ReviewTab";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

afterEach(() => {
  cleanup();
  // Bộ nhớ "từ cũ đã gặp" sống suốt lần mở app (cấp module) — reset giữa các test.
  resetOldWordsMemory();
});

/** Chờ React chạy xong effect (bộ nghe phím gắn trong useEffect) trước khi gửi phím. */
const settle = () => act(async () => {});

// Thêm theo thứ tự này: 猫 cũ nhất … 牛 mới nhất.
const WORDS: [string, string, string][] = [
  ["猫", "ねこ", "con mèo"],
  ["犬", "いぬ", "con chó"],
  ["鳥", "とり", "con chim"],
  ["魚", "さかな", "con cá"],
  ["馬", "うま", "con ngựa"],
  ["牛", "うし", "con bò"],
];

async function makeDb(count: number, settings: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const db = createTestDb();
  await saveSettings(db, { ...DEFAULT_SETTINGS, sessionSize: 5, newPerDay: 10, ...settings });
  const ids: number[] = [];
  for (const [i, [term, reading, meanings]] of WORDS.slice(0, count).entries()) {
    const r = await addWord(db, { term, reading, meanings }, new Date(Date.UTC(2026, 0, 1, 0, i)));
    if (r.status !== "added") throw new Error();
    ids.push(r.wordId);
    if (i === 0) {
      await db.execute("INSERT INTO examples (word_id, ja, reading, vi) VALUES (?, ?, ?, ?)", [
        r.wordId,
        "猫が好きです。",
        "ねこがすきです。",
        "Tôi thích mèo.",
      ]);
    }
  }
  return { db, ids };
}

/** Mở tab: vào thẳng "Ôn hôm nay". */
async function open(db: Db) {
  render(<ReviewTab db={db} />);
  await screen.findByText("Bạn có nhớ từ này?");
  await settle();
}

async function setup(count = 1, settings: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const { db, ids } = await makeDb(count, settings);
  await open(db);
  return { db, ids };
}

const front = () => document.querySelector(".flip-front") as HTMLElement;
const back = () => document.querySelector(".flip-back") as HTMLElement;
const card = () => document.querySelector(".swipe-card") as HTMLElement;
const isFlipped = () => document.querySelector(".flip-card.flipped") !== null;
const logs = (db: Db) => db.select<{ correct: number }>("SELECT correct FROM review_logs ORDER BY id");
const currentTerm = () => front()?.querySelector(".review-term")?.textContent;
const count = (label: "Quên" | "Nhớ") => screen.getByLabelText(new RegExp(`^${label}: \\d+ từ$`)).textContent;

/** Trả lời lần lượt, chờ thẻ đổi (hoặc hết lượt). Trả về danh sách từ đã gặp. */
async function answerAll(keys: ("ArrowLeft" | "ArrowRight")[]): Promise<string[]> {
  const seen: string[] = [];
  for (const key of keys) {
    await settle();
    const before = currentTerm();
    seen.push(before ?? "");
    fireEvent.keyDown(window, { key });
    await vi.waitFor(() => expect(document.querySelector(".session-end") ?? currentTerm() !== before).toBeTruthy());
  }
  return seen;
}

async function startRound(button: RegExp) {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  await screen.findByText("Bạn có nhớ từ này?");
  await settle();
}

describe("ReviewTab — mở app vào thẳng Ôn hôm nay", () => {
  it("mặt trước: chữ Hán + kana, nhãn 🆕 Mới; mặt sau: nghĩa + ví dụ có kana", async () => {
    await setup();
    expect(screen.getByText(/^Ôn hôm nay/)).toBeTruthy();
    expect(screen.getByText("🆕 Mới")).toBeTruthy();
    expect(front().textContent).toContain("猫");
    expect(front().textContent).toContain("ねこ");
    expect(front().textContent).not.toContain("con mèo");
    expect(back().textContent).toContain("con mèo");
    expect(back().querySelector(".example-ja")?.textContent).toBe("猫が好きです。");
    expect(back().querySelector(".example-reading")?.textContent).toBe("ねこがすきです。");
  });

  it("từ mới: mới thêm nhất trước", async () => {
    await setup(3);
    expect(await answerAll(["ArrowRight", "ArrowRight", "ArrowRight"])).toEqual(["鳥", "犬", "猫"]);
  });

  it("bấm vào thẻ thì lật, bấm lần nữa lật lại; Space cũng lật", async () => {
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
    const { db } = await setup(3);
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

  it("đang bay ra mà bấm thêm phím số thì vẫn chỉ chấm 1 lần", async () => {
    const { db } = await setup(3);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "1" });
    await vi.waitFor(() => expect(currentTerm()).toBe("犬"));
    await new Promise((r) => setTimeout(r, 400));
    expect(await logs(db)).toEqual([{ correct: 1 }]);
    expect([count("Quên"), count("Nhớ")]).toEqual(["0", "1"]);
  });

  it("số Quên/Nhớ hiện ngay trên nút", async () => {
    await setup(3);
    expect([count("Quên"), count("Nhớ")]).toEqual(["0", "0"]);
    await answerAll(["ArrowLeft", "ArrowRight"]);
    expect([count("Quên"), count("Nhớ")]).toEqual(["1", "1"]);
  });
});

describe("ReviewTab — hết lượt", () => {
  it("nhớ hết: mỗi từ 1 lần, \"Hôm nay xong rồi\" + đợt ôn tiếp theo; không có nút ôn tiếp hôm nay", async () => {
    const { db } = await setup(2);
    await answerAll(["ArrowRight", "ArrowRight"]);
    expect(await screen.findByText("Xong lượt! 🎉")).toBeTruthy();
    expect(document.querySelector(".confetti")).toBeTruthy();
    // Nhớ hết → linh vật (mặc định Mèo) giơ bảng khen trong thông báo.
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("🐱");
    expect(toast.querySelector(".mascot-sign")).toBeTruthy();
    expect(screen.getByText("✅ Hôm nay xong rồi!")).toBeTruthy();
    expect(screen.getByText(/Đợt ôn tiếp theo: .* — 2 từ đến hạn\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Ôn tiếp hôm nay/ })).toBeNull();
    expect(screen.getByRole("button", { name: "📚 Ôn từ vựng cũ (còn 2 từ chưa ôn)" })).toBeTruthy();
    expect(await logs(db)).toHaveLength(2);
  });

  it("ôn lại từ vừa quên: chỉ các từ quên, không ghi lịch", async () => {
    const { db } = await setup(3);
    await answerAll(["ArrowLeft", "ArrowRight", "ArrowLeft"]);
    expect(screen.getByText("Các từ đã quên")).toBeTruthy();

    await startRound(/Ôn lại 2 từ vừa quên/);
    expect(screen.getByText("Luyện · không đổi lịch")).toBeTruthy();
    const seen = await answerAll(["ArrowRight", "ArrowRight"]);
    expect(seen.sort()).toEqual(["猫", "鳥"].sort());
    expect(await logs(db)).toHaveLength(3);
  });

  it("học thêm từ mới vượt giới hạn ngày, mới nhất trước, có tính vào lịch", async () => {
    const { db } = await setup(4, { newPerDay: 2 });
    expect(await answerAll(["ArrowRight", "ArrowRight"])).toEqual(["魚", "鳥"]);
    expect(screen.getByText("✅ Hôm nay xong rồi!")).toBeTruthy();

    await startRound(/Học thêm 2 từ mới \(còn 2\)/);
    expect(await answerAll(["ArrowRight", "ArrowRight"])).toEqual(["犬", "猫"]);
    expect(await logs(db)).toHaveLength(4);
  });

  it("ôn từ vựng cũ: chỉ từ đã học, ngẫu nhiên, không ghi lịch", async () => {
    const { db } = await setup(4, { newPerDay: 2 });
    await answerAll(["ArrowRight", "ArrowRight"]);
    await startRound(/Ôn từ vựng cũ/);
    expect(screen.getByText(/^Ôn từ vựng cũ/)).toBeTruthy();
    const seen = await answerAll(["ArrowRight", "ArrowRight"]);
    expect(seen.sort()).toEqual(["魚", "鳥"].sort());
    expect(await logs(db)).toHaveLength(2);
  });

  it("ôn từ vựng cũ nhiều lượt: không lặp từ trong lần mở app, gặp hết thì sang vòng mới", async () => {
    const { db } = await setup(6, { newPerDay: 6, sessionSize: 5 });
    await answerAll(["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"]);
    await startRound(/Học thêm 1 từ mới/);
    await answerAll(["ArrowRight"]);
    expect(await logs(db)).toHaveLength(6);

    await startRound(/Ôn từ vựng cũ \(còn 6 từ chưa ôn\)/);
    const first = await answerAll(["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"]);
    await startRound(/Ôn từ vựng cũ \(còn 1 từ chưa ôn\)/);
    const second = await answerAll(["ArrowRight"]);
    expect(new Set([...first, ...second]).size).toBe(6);

    expect(await screen.findByRole("button", { name: /Ôn từ vựng cũ \(đã ôn hết — bắt đầu vòng mới\)/ })).toBeTruthy();
    expect(await logs(db)).toHaveLength(6);
  });

  it("mở app khi không còn gì để ôn hôm nay: hiện ngay \"Hôm nay xong rồi\"", async () => {
    const { db } = await makeDb(1, { newPerDay: 0 });
    render(<ReviewTab db={db} />);
    expect(await screen.findByText("✅ Hôm nay xong rồi!")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Học thêm 1 từ mới/ })).toBeTruthy();
  });
});

describe("ReviewTab — Tùy chọn: phạm vi + Luyện tự do", () => {
  async function setupTopics() {
    const { db, ids } = await makeDb(4, { newPerDay: 0 });
    const { lastInsertId: pets } = await db.execute("INSERT INTO topics (name) VALUES (?)", ["Thú cưng"]);
    await db.execute("INSERT INTO word_topics (word_id, topic_id) VALUES (?, ?), (?, ?)", [ids[0], pets, ids[1], pets]);
    // 猫 đã Vững, 犬 đang học; 鳥, 魚 mới.
    await db.execute(
      `INSERT INTO cards (word_id, skill, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state)
       VALUES (?, 'meaning', '2099-01-01T00:00:00.000Z', 30, 5, 0, 30, 3, 0, 2),
              (?, 'meaning', '2099-01-01T00:00:00.000Z', 3, 5, 0, 3, 1, 0, 2)`,
      [ids[0], ids[1]],
    );
    render(<ReviewTab db={db} />);
    fireEvent.click(await screen.findByRole("button", { name: /Tùy chọn/ }));
    await screen.findByText("Tùy chọn ôn");
    return db;
  }

  it("theo chủ đề: Luyện tự do mặc định bỏ từ Vững, tick thì gồm cả", async () => {
    await setupTopics();
    fireEvent.click(screen.getByLabelText(/Theo chủ đề/));
    expect(await screen.findByText("Chọn ít nhất 1 chủ đề.")).toBeTruthy();
    fireEvent.click(await screen.findByLabelText(/Thú cưng/));
    expect(await screen.findByText(/Đi hết 1 từ/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Gồm cả từ ✅ Vững/));
    expect(await screen.findByText(/Đi hết 2 từ/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Gồm cả từ ✅ Vững/));

    await startRound(/Luyện tự do/);
    expect(screen.getByText(/Chủ đề: Thú cưng/)).toBeTruthy();
    expect(await answerAll(["ArrowRight"])).toEqual(["犬"]);
  });

  it("từ chưa có chủ đề", async () => {
    await setupTopics();
    fireEvent.click(screen.getByLabelText(/Từ chưa có chủ đề/));
    expect(await screen.findByText(/Đi hết 2 từ/)).toBeTruthy();
    await startRound(/Luyện tự do/);
    expect((await answerAll(["ArrowRight", "ArrowRight"])).sort()).toEqual(["魚", "鳥"].sort());
  });
});
