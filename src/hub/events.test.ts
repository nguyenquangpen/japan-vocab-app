import { describe, expect, it } from "vitest";
import type { Db } from "../db/db";
import { createTestDb } from "../db/nodeSqliteDb";
import { loadHubConfig, saveHubConfig } from "./config";
import {
  buildEnvelope,
  clip,
  enqueueEvent,
  isoWithOffset,
  reportLessonCompleted,
  reportNewlyMastered,
  reportSessionCompleted,
} from "./events";
import { envelopeSchema } from "./fakeHub.test-helpers";

const NOW = new Date("2026-11-07T02:30:02Z");
const KEY = `pph_${"a1B2".repeat(8)}`;

async function addWord(db: Db, term: string, stability: number | null): Promise<number> {
  const { lastInsertId } = await db.execute(
    "INSERT INTO words (term, created_at, updated_at) VALUES (?, ?, ?)",
    [term, NOW.toISOString(), NOW.toISOString()],
  );
  if (stability !== null) {
    await db.execute(
      `INSERT INTO cards (word_id, skill, due, stability, difficulty, elapsed_days,
         scheduled_days, reps, lapses, state) VALUES (?, 'meaning', ?, ?, 5, 0, 0, 3, 0, 2)`,
      [lastInsertId, NOW.toISOString(), stability],
    );
  }
  return lastInsertId!;
}

async function outbox(db: Db) {
  return db.select<{ event_type: string; payload: string; status: string; dedupe_key: string | null }>(
    "SELECT event_type, payload, status, dedupe_key FROM hub_outbox ORDER BY id",
  );
}

describe("isoWithOffset", () => {
  it("có offset, cùng thời điểm", () => {
    const s = isoWithOffset(NOW);
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(Date.parse(s)).toBe(NOW.getTime());
  });
});

describe("clip", () => {
  it("không cắt đôi ký tự ngoài BMP", () => {
    expect(clip("𠮷𠮷", 3)).toBe("𠮷");
    expect(clip("abc", 5)).toBe("abc");
  });
});

describe("hub config", () => {
  it("mặc định tắt, URL mặc định, chưa có key", async () => {
    expect(await loadHubConfig(createTestDb())).toEqual({ enabled: false, url: "http://127.0.0.1:4317", apiKey: "" });
  });

  it("chỉ nhận http://127.0.0.1:<cổng 1–65535>", async () => {
    const db = createTestDb();
    for (const url of ["http://localhost:4317", "https://127.0.0.1:4317", "http://127.0.0.1:0", "http://127.0.0.1:70000", "http://127.0.0.1:4317/x"]) {
      expect((await saveHubConfig(db, { enabled: true, url, apiKey: "" })).ok, url).toBe(false);
    }
    expect((await saveHubConfig(db, { enabled: true, url: "http://127.0.0.1:5000", apiKey: "" })).ok).toBe(true);
  });

  it("key sai định dạng bị từ chối và không xuất hiện trong thông báo; để trống thì giữ key cũ", async () => {
    const db = createTestDb();
    const bad = "pph_short";
    const r = await saveHubConfig(db, { enabled: true, url: "http://127.0.0.1:4317", apiKey: bad });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(bad);

    await saveHubConfig(db, { enabled: true, url: "http://127.0.0.1:4317", apiKey: KEY });
    await saveHubConfig(db, { enabled: false, url: "http://127.0.0.1:4318", apiKey: "" });
    expect(await loadHubConfig(db)).toEqual({ enabled: false, url: "http://127.0.0.1:4318", apiKey: KEY });
  });
});

describe("enqueueEvent", () => {
  it("ghi vào outbox cả khi tích hợp đang tắt; payload khớp hợp đồng", async () => {
    const db = createTestDb();
    const r = await enqueueEvent(db, {
      type: "lesson.completed",
      subject: { type: "lesson", external_id: "l-1" },
      data: { title: "Bài 1" },
      occurredAt: NOW,
      now: NOW,
    });
    expect(r.enqueued).toBe(true);
    const [row] = await outbox(db);
    expect(row.status).toBe("pending");
    const env = envelopeSchema.parse(JSON.parse(row.payload));
    expect(env.event_id).toBe(r.eventId);
  });

  it("cùng dedupeKey không tạo sự kiện thứ 2", async () => {
    const db = createTestDb();
    const input = {
      type: "lesson.completed" as const,
      subject: { type: "lesson", external_id: "l-1" },
      data: { title: "Bài 1" },
      occurredAt: NOW,
      dedupeKey: "lesson:l-1",
    };
    expect((await enqueueEvent(db, input)).enqueued).toBe(true);
    expect((await enqueueEvent(db, input)).enqueued).toBe(false);
    expect(await outbox(db)).toHaveLength(1);
  });

  it("từ chối dữ liệu sai đặc tả, cắt chuỗi hiển thị quá dài, bỏ trường lạ", async () => {
    const db = createTestDb();
    const bad = await enqueueEvent(db, {
      type: "vocabulary.learned",
      subject: { type: "vocabulary_batch", external_id: "b" },
      data: { count: 0 },
      occurredAt: NOW,
    });
    expect(bad.enqueued).toBe(false);
    expect(bad.error).toMatch(/count/);

    const built = buildEnvelope({
      type: "vocabulary.learned",
      subject: { type: "vocabulary_batch", external_id: "b" },
      data: { count: 150, words: Array.from({ length: 150 }, () => "あ".repeat(60)), xp: 10 },
      occurredAt: NOW,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    envelopeSchema.parse(built.envelope);
    expect(built.envelope.data).not.toHaveProperty("xp");
    expect((built.envelope.data.words as string[]).length).toBe(100);

    expect(
      buildEnvelope({ type: "lesson.completed", subject: { type: "lesson", external_id: "x".repeat(201) }, data: { title: "t" }, occurredAt: NOW }).ok,
    ).toBe(false);
  });
});

describe("reportSessionCompleted", () => {
  it("phiên < 1 phút không gửi", async () => {
    const db = createTestDb();
    const r = await reportSessionCompleted(db, { sessionId: "s1", startedAt: NOW, endedAt: new Date(NOW.getTime() + 59_000) });
    expect(r.enqueued).toBe(false);
    expect(await outbox(db)).toHaveLength(0);
  });

  it("ended_at = occurred_at, mở lại kết quả không tạo sự kiện mới (tiêu chí 8)", async () => {
    const db = createTestDb();
    const endedAt = new Date(NOW.getTime() + 12 * 60_000 + 30_000);
    const input = { sessionId: "s1", startedAt: NOW, endedAt, itemsReviewed: 15 };
    expect((await reportSessionCompleted(db, input)).enqueued).toBe(true);
    expect((await reportSessionCompleted(db, input)).enqueued).toBe(false);
    const rows = await outbox(db);
    expect(rows).toHaveLength(1);
    const env = envelopeSchema.parse(JSON.parse(rows[0].payload));
    expect(env.data).toEqual({
      duration_minutes: 12,
      activity: "vocabulary",
      started_at: isoWithOffset(NOW),
      ended_at: isoWithOffset(endedAt),
      items_reviewed: 15,
    });
    expect(env.occurred_at).toBe(env.data.ended_at);
  });
});

describe("reportLessonCompleted", () => {
  it("tạo lesson.completed với title, thời lượng, điểm", async () => {
    const db = createTestDb();
    const r = await reportLessonCompleted(db, { lessonId: "practice-1", title: "Luyện câu", durationMinutes: 4.6, score: 80, now: NOW });
    expect(r.enqueued).toBe(true);
    expect((await reportLessonCompleted(db, { lessonId: "practice-1", title: "Luyện câu" })).enqueued).toBe(false);
    const [row] = await outbox(db);
    const env = envelopeSchema.parse(JSON.parse(row.payload));
    expect(env.subject).toEqual({ type: "lesson", external_id: "practice-1" });
    expect(env.data).toEqual({ title: "Luyện câu", duration_minutes: 5, score: 80 });
    expect(row.dedupe_key).toBe("lesson:practice-1");
  });
});

describe("reportNewlyMastered", () => {
  it("lô 20 từ mới đạt Vững → đúng 1 vocabulary.learned, count = 20, occurred_at = lúc học xong (tiêu chí 1)", async () => {
    const db = createTestDb();
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) ids.push(await addWord(db, `語${i}`, 25));
    ids.push(await addWord(db, "未熟", 5));
    ids.push(await addWord(db, "無カード", null));

    const occurredAt = new Date("2026-11-07T02:30:00Z");
    const r = await reportNewlyMastered(db, { sessionId: "s1", wordIds: ids, occurredAt });
    expect(r.enqueued).toBe(true);

    const rows = await outbox(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("vocabulary.learned");
    const env = envelopeSchema.parse(JSON.parse(rows[0].payload));
    expect(env.data.count).toBe(20);
    expect(env.data.words).toHaveLength(20);
    expect(env.occurred_at).toBe(isoWithOffset(occurredAt));
    expect(env.subject).toEqual({ type: "vocabulary_batch", external_id: "s1" });
  });

  it("từ đã báo không báo lại ở phiên sau; chạy lại cùng phiên không tạo sự kiện mới", async () => {
    const db = createTestDb();
    const a = await addWord(db, "犬", 30);
    await reportNewlyMastered(db, { sessionId: "s1", wordIds: [a], occurredAt: NOW });
    expect((await reportNewlyMastered(db, { sessionId: "s1", wordIds: [a], occurredAt: NOW })).enqueued).toBe(false);
    expect((await reportNewlyMastered(db, { sessionId: "s2", wordIds: [a], occurredAt: NOW })).enqueued).toBe(false);

    const b = await addWord(db, "猫", 22);
    const r = await reportNewlyMastered(db, { sessionId: "s3", wordIds: [a, b], occurredAt: NOW });
    expect(r.enqueued).toBe(true);
    const rows = await outbox(db);
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1].payload).data).toEqual({ count: 1, words: ["猫"] });
  });

  it("không có từ mới đạt Vững thì không ghi gì", async () => {
    const db = createTestDb();
    const a = await addWord(db, "犬", 3);
    expect((await reportNewlyMastered(db, { sessionId: "s1", wordIds: [a], occurredAt: NOW })).enqueued).toBe(false);
    expect((await reportNewlyMastered(db, { sessionId: "s1", wordIds: [], occurredAt: NOW })).enqueued).toBe(false);
    expect(await outbox(db)).toHaveLength(0);
  });
});
