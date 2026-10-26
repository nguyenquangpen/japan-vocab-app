import { describe, expect, it } from "vitest";
import { createTestDb } from "../db/nodeSqliteDb";
import { addWord, addWordsBatch, listWords } from "../vocab/vocab";
import {
  addWordsToTopic,
  createTopic,
  deleteTopic,
  getWordTopicIds,
  listTopics,
  removeWordFromTopic,
  renameTopic,
} from "./topics";

async function setup() {
  const db = createTestDb();
  const ids: number[] = [];
  for (const term of ["食べる", "飲む", "見る"]) {
    const r = await addWord(db, { term });
    if (r.status !== "added") throw new Error();
    ids.push(r.wordId);
  }
  return { db, ids };
}

describe("topics", () => {
  it("tạo (chuẩn hóa tên), báo trùng, báo rỗng", async () => {
    const { db } = await setup();
    const created = await createTopic(db, "  Ăn   uống ");
    expect(created.status).toBe("ok");
    expect(await createTopic(db, "Ăn uống")).toEqual({ status: "duplicate", id: created.status === "ok" ? created.id : -1 });
    expect(await createTopic(db, " ")).toMatchObject({ status: "invalid" });
    expect((await listTopics(db)).map((t) => t.name)).toEqual(["Ăn uống"]);
  });

  it("đổi tên, không cho trùng tên chủ đề khác, not_found", async () => {
    const { db } = await setup();
    const a = await createTopic(db, "A");
    const b = await createTopic(db, "B");
    if (a.status !== "ok" || b.status !== "ok") throw new Error();

    expect(await renameTopic(db, a.id, "Động từ")).toEqual({ status: "ok", id: a.id });
    expect(await renameTopic(db, b.id, "Động từ")).toEqual({ status: "duplicate", id: a.id });
    expect(await renameTopic(db, a.id, "Động từ")).toEqual({ status: "ok", id: a.id });
    expect(await renameTopic(db, 999, "X")).toEqual({ status: "not_found" });
  });

  it("gắn hàng loạt, bỏ qua liên kết đã có, gỡ, đếm từ, lọc theo chủ đề", async () => {
    const { db, ids } = await setup();
    const t = await createTopic(db, "Động từ");
    if (t.status !== "ok") throw new Error();

    expect(await addWordsToTopic(db, t.id, [ids[0], ids[1], ids[1]])).toBe(2);
    expect(await addWordsToTopic(db, t.id, [ids[0], ids[2]])).toBe(1);
    expect(await getWordTopicIds(db, ids[0])).toEqual([t.id]);
    expect((await listTopics(db))[0].wordCount).toBe(3);

    await removeWordFromTopic(db, ids[1], t.id);
    expect((await listWords(db, { topicId: t.id })).map((w) => w.term).sort()).toEqual(["見る", "食べる"]);
  });

  it("xóa chủ đề không xóa từ", async () => {
    const { db, ids } = await setup();
    const t = await createTopic(db, "X");
    if (t.status !== "ok") throw new Error();
    await addWordsToTopic(db, t.id, ids);

    expect(await deleteTopic(db, t.id)).toBe(true);
    expect(await listWords(db)).toHaveLength(3);
    expect(await db.select("SELECT * FROM word_topics")).toEqual([]);
  });

  it("nhập hàng loạt trả về id để gắn chủ đề", async () => {
    const db = createTestDb();
    const result = await addWordsBatch(db, "食べる\n飲む");
    const t = await createTopic(db, "Lô 1");
    if (t.status !== "ok") throw new Error();
    expect(await addWordsToTopic(db, t.id, result.added.map((a) => a.wordId))).toBe(2);
  });
});
