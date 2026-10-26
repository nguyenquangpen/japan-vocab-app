import { describe, expect, it } from "vitest";
import { createTestDb } from "../db/nodeSqliteDb";
import { addWord, addWordsBatch, deleteWord, getWord, listWords, updateWord } from "./vocab";

const NOW = new Date("2026-10-26T01:02:03.000Z");

describe("addWord", () => {
  it("thêm từ mới với nghĩa tách sẵn, chưa bổ sung", async () => {
    const db = createTestDb();
    const result = await addWord(db, { term: " 食べる ", reading: "たべる", meanings: "ăn, dùng bữa" }, NOW);
    expect(result.status).toBe("added");
    if (result.status !== "added") return;

    const word = await getWord(db, result.wordId);
    expect(word).toMatchObject({
      term: "食べる",
      reading: "たべる",
      meanings: ["ăn", "dùng bữa"],
      enriched: false,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  it("báo trùng (sau NFKC) và trả id từ cũ", async () => {
    const db = createTestDb();
    const first = await addWord(db, { term: "ﾀﾍﾞﾙ" });
    const second = await addWord(db, { term: "タベル" });
    expect(second).toEqual({ status: "duplicate", wordId: first.status === "added" ? first.wordId : -1 });
  });

  it("trùng khi một bên chưa có cách đọc", async () => {
    const db = createTestDb();
    await addWord(db, { term: "上手", reading: "じょうず" });
    expect((await addWord(db, { term: "上手" })).status).toBe("duplicate");
  });

  it("cùng chữ khác cách đọc thì không trùng", async () => {
    const db = createTestDb();
    await addWord(db, { term: "上手", reading: "じょうず" });
    expect((await addWord(db, { term: "上手", reading: "うわて" })).status).toBe("added");
  });

  it("báo lỗi khi không hợp lệ", async () => {
    const db = createTestDb();
    expect(await addWord(db, { term: "" })).toMatchObject({ status: "invalid" });
    expect(await listWords(db)).toEqual([]);
  });
});

describe("addWordsBatch", () => {
  it("phân loại từng dòng: thêm, trùng (kể cả trong cùng lô), lỗi", async () => {
    const db = createTestDb();
    await addWord(db, { term: "水" });

    const result = await addWordsBatch(
      db,
      ["食べる たべる", "", "飲む | のむ | uống", "水", "食べる", "見る みる xem", "行く iku"].join("\n"),
    );

    expect(result.added.map((a) => [a.lineNo, a.term])).toEqual([
      [1, "食べる"],
      [3, "飲む"],
    ]);
    expect(result.duplicates.map((d) => [d.lineNo, d.term])).toEqual([
      [4, "水"],
      [5, "食べる"],
    ]);
    expect(result.invalid.map((i) => i.lineNo)).toEqual([6, 7]);
    expect(await listWords(db)).toHaveLength(3);
  });
});

describe("listWords", () => {
  it("tìm theo term, reading, nghĩa; lọc chờ bổ sung", async () => {
    const db = createTestDb();
    await addWord(db, { term: "食べる", reading: "たべる", meanings: "ăn" });
    await addWord(db, { term: "飲む", reading: "のむ", meanings: "uống" });
    await db.execute("UPDATE words SET enriched = 1 WHERE term = ?", ["飲む"]);

    const terms = async (filter: Parameters<typeof listWords>[1]) =>
      (await listWords(db, filter)).map((w) => w.term);

    expect(await terms({ query: "食" })).toEqual(["食べる"]);
    expect(await terms({ query: "のむ" })).toEqual(["飲む"]);
    expect(await terms({ query: "uống" })).toEqual(["飲む"]);
    expect(await terms({ status: "pending" })).toEqual(["食べる"]);
    expect(await terms({ query: "%" })).toEqual([]);
  });

  it("từ mới nhất đứng đầu", async () => {
    const db = createTestDb();
    await addWord(db, { term: "一" }, new Date("2026-01-01T00:00:00Z"));
    await addWord(db, { term: "二" }, new Date("2026-01-02T00:00:00Z"));
    expect((await listWords(db)).map((w) => w.term)).toEqual(["二", "一"]);
  });
});

describe("updateWord", () => {
  const edit = {
    term: "食べる",
    reading: "たべる",
    meanings: ["ăn", "dùng bữa"],
    partOfSpeech: "động từ",
    usageNote: "",
    userNote: "nhóm 2",
  };

  it("cập nhật các trường và updated_at", async () => {
    const db = createTestDb();
    const added = await addWord(db, { term: "たべる" });
    if (added.status !== "added") throw new Error();
    const later = new Date("2026-10-27T00:00:00Z");

    expect(await updateWord(db, added.wordId, edit, later)).toEqual({ status: "updated" });
    expect(await getWord(db, added.wordId)).toMatchObject({
      ...edit,
      usageNote: null,
      updatedAt: later.toISOString(),
    });
  });

  it("không cho sửa thành từ đã có", async () => {
    const db = createTestDb();
    const a = await addWord(db, { term: "食べる", reading: "たべる" });
    const b = await addWord(db, { term: "飲む" });
    if (a.status !== "added" || b.status !== "added") throw new Error();

    expect(await updateWord(db, b.wordId, edit)).toEqual({ status: "duplicate", wordId: a.wordId });
  });

  it("sửa chính nó mà giữ nguyên term thì không tính trùng", async () => {
    const db = createTestDb();
    const a = await addWord(db, { term: "食べる", reading: "たべる" });
    if (a.status !== "added") throw new Error();
    expect(await updateWord(db, a.wordId, edit)).toEqual({ status: "updated" });
  });

  it("báo not_found và invalid", async () => {
    const db = createTestDb();
    expect(await updateWord(db, 999, edit)).toEqual({ status: "not_found" });
    expect(await updateWord(db, 999, { ...edit, term: "" })).toMatchObject({ status: "invalid" });
  });
});

describe("deleteWord", () => {
  it("xóa từ cùng ví dụ", async () => {
    const db = createTestDb();
    const a = await addWord(db, { term: "食べる" });
    if (a.status !== "added") throw new Error();
    await db.execute("INSERT INTO examples (word_id, ja) VALUES (?, ?)", [a.wordId, "食べる。"]);

    expect(await deleteWord(db, a.wordId)).toBe(true);
    expect(await getWord(db, a.wordId)).toBeNull();
    expect(await db.select("SELECT * FROM examples")).toEqual([]);
    expect(await deleteWord(db, a.wordId)).toBe(false);
  });
});
