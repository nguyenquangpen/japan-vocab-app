// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../db/nodeSqliteDb";
import { addWord } from "../vocab/vocab";
import WordsPanel from "./WordsPanel";

afterEach(cleanup);

describe("WordsPanel — sửa ví dụ", () => {
  it("sửa câu ví dụ, xóa 1 ví dụ, thêm ví dụ mới rồi Lưu", async () => {
    const db = createTestDb();
    const r = await addWord(db, { term: "猫", reading: "ねこ", meanings: "con mèo" });
    if (r.status !== "added") throw new Error();
    await db.execute("INSERT INTO examples (word_id, ja, vi) VALUES (?, ?, ?), (?, ?, ?)", [
      r.wordId, "猫が好きでう。", "Tôi thích mèo.", r.wordId, "câu thừa", "xóa",
    ]);

    render(<WordsPanel db={db} selectedId={r.wordId} onSelect={() => {}} />);
    const first = (await screen.findByLabelText("Ví dụ 1: câu tiếng Nhật")) as HTMLInputElement;
    expect(first.value).toBe("猫が好きでう。");

    fireEvent.change(first, { target: { value: "猫が好きです。" } });
    fireEvent.click(screen.getByRole("button", { name: "Xóa ví dụ 2" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Thêm ví dụ" }));
    fireEvent.change(screen.getByLabelText("Ví dụ 2: câu tiếng Nhật"), { target: { value: "黒い猫がいます。" } });
    fireEvent.change(screen.getByLabelText("Ví dụ 2: nghĩa"), { target: { value: "Có một con mèo đen." } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));

    expect(await screen.findByText("Đã lưu.")).toBeTruthy();
    await vi.waitFor(async () =>
      expect(await db.select("SELECT ja, vi FROM examples WHERE word_id = ? ORDER BY id", [r.wordId])).toEqual([
        { ja: "猫が好きです。", vi: "Tôi thích mèo." },
        { ja: "黒い猫がいます。", vi: "Có một con mèo đen." },
      ]),
    );
  });
});
