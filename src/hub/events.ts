import type { Db } from "../db/db";
import { MASTERED_STABILITY } from "../review/scheduler";
import { APP_VERSION } from "./config";
import { HUB_APP_ID, HUB_SCHEMA_VERSION, type HubEnvelope, type HubEventType } from "./types";

// Tạo sự kiện và ghi vào outbox (hợp đồng mục 4–6). Việc gửi do sender.ts làm.
//
// Định nghĩa dùng cho Hub (hợp đồng mục 5):
// - "Đã thuộc" (vocabulary.learned): lần đầu thẻ meaning của từ đạt stability >= MASTERED_STABILITY (21 ngày,
//   cùng ngưỡng "Vững" của app). Mỗi từ chỉ báo 1 lần (bảng hub_mastered_reported).
// - "Xong phiên" (learning.session.completed): kết thúc 1 lượt ôn từ vựng dài >= 1 phút.
// - "Xong bài" (lesson.completed): hoàn thành 1 lượt luyện tập/kiểm tra có kết quả.
// Hoàn tác tiến độ không gửi gì (v1 không có sự kiện đảo ngược).

export const MAX_BODY_BYTES = 64 * 1024;
const LEVELS = ["N5", "N4", "N3", "N2", "N1"];
const ACTIVITIES = ["vocabulary", "kanji", "grammar", "listening", "reading", "mixed", "other"];

/** Giờ địa phương dạng ISO 8601 có offset, vd. 2026-11-07T09:30:00+07:00 (không có mili giây). */
export function isoWithOffset(date: Date): string {
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}

/** Cắt chuỗi còn tối đa `max` đơn vị UTF-16 mà không cắt đôi ký tự (đúng giới hạn dù Hub đếm kiểu nào). */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let out = "";
  for (const ch of value) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

type Validated = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isIso = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/.test(v);

/**
 * Kiểm tra `data` theo mục 6. Chuỗi hiển thị (title, deck, words) quá dài thì cắt; số ngoài khoảng hoặc
 * thiếu trường bắt buộc thì từ chối (không tự bịa số liệu). Trường ngoài đặc tả bị bỏ.
 */
export function validateEventData(type: HubEventType, data: Record<string, unknown>): Validated {
  const out: Record<string, unknown> = {};
  const fail = (error: string): Validated => ({ ok: false, error: `${type}: ${error}` });
  const optionalLevel = () => {
    if (data.level === undefined) return true;
    if (typeof data.level !== "string" || !LEVELS.includes(data.level)) return false;
    out.level = data.level;
    return true;
  };

  switch (type) {
    case "vocabulary.learned": {
      if (!isInt(data.count) || data.count < 1 || data.count > 1000) return fail("count phải là số nguyên 1–1000");
      out.count = data.count;
      if (!optionalLevel()) return fail("level không hợp lệ");
      if (data.deck !== undefined) {
        if (typeof data.deck !== "string") return fail("deck phải là chuỗi");
        if (data.deck.trim() !== "") out.deck = clip(data.deck, 100);
      }
      if (data.words !== undefined) {
        if (!Array.isArray(data.words) || data.words.some((w) => typeof w !== "string")) {
          return fail("words phải là mảng chuỗi");
        }
        const words = (data.words as string[]).filter((w) => w !== "").slice(0, 100).map((w) => clip(w, 50));
        if (words.length > 0) out.words = words;
      }
      break;
    }
    case "lesson.completed": {
      if (typeof data.title !== "string" || data.title.trim() === "") return fail("title bắt buộc");
      out.title = clip(data.title, 200);
      if (data.duration_minutes !== undefined) {
        if (!isInt(data.duration_minutes) || data.duration_minutes < 1 || data.duration_minutes > 1440) {
          return fail("duration_minutes phải là số nguyên 1–1440");
        }
        out.duration_minutes = data.duration_minutes;
      }
      if (data.score !== undefined) {
        if (typeof data.score !== "number" || !Number.isFinite(data.score) || data.score < 0 || data.score > 100) {
          return fail("score phải trong 0–100");
        }
        out.score = data.score;
      }
      if (!optionalLevel()) return fail("level không hợp lệ");
      break;
    }
    case "learning.session.completed": {
      if (!isInt(data.duration_minutes) || data.duration_minutes < 1 || data.duration_minutes > 1440) {
        return fail("duration_minutes phải là số nguyên 1–1440");
      }
      out.duration_minutes = data.duration_minutes;
      if (typeof data.activity !== "string" || !ACTIVITIES.includes(data.activity)) return fail("activity không hợp lệ");
      out.activity = data.activity;
      if (!isIso(data.started_at) || !isIso(data.ended_at)) return fail("started_at/ended_at phải là ISO 8601 có offset");
      out.started_at = data.started_at;
      out.ended_at = data.ended_at;
      if (data.items_reviewed !== undefined) {
        if (!isInt(data.items_reviewed) || data.items_reviewed < 0) return fail("items_reviewed phải là số nguyên >= 0");
        out.items_reviewed = data.items_reviewed;
      }
      break;
    }
    case "external_app.heartbeat": {
      if (!isInt(data.outbox_pending) || data.outbox_pending < 0) return fail("outbox_pending phải là số nguyên >= 0");
      out.outbox_pending = data.outbox_pending;
      break;
    }
  }
  return { ok: true, data: out };
}

export interface BuildEnvelopeInput {
  type: HubEventType;
  subject: { type: string; external_id: string };
  data: Record<string, unknown>;
  occurredAt: Date;
  now?: Date;
}

export type BuildResult = { ok: true; envelope: HubEnvelope; body: string } | { ok: false; error: string };

/** Dựng envelope (event_id mới) và kiểm tra theo hợp đồng. Dùng chung cho outbox và heartbeat. */
export function buildEnvelope(input: BuildEnvelopeInput): BuildResult {
  const { type, subject, occurredAt } = input;
  const now = input.now ?? new Date();
  if (subject.external_id === "" || subject.external_id.length > 200) {
    return { ok: false, error: `${type}: subject.external_id phải dài 1–200 ký tự` };
  }
  if (Number.isNaN(occurredAt.getTime())) return { ok: false, error: `${type}: occurred_at không hợp lệ` };
  const validated = validateEventData(type, input.data);
  if (!validated.ok) return validated;

  const envelope: HubEnvelope = {
    event_id: crypto.randomUUID(),
    event_type: type,
    schema_version: HUB_SCHEMA_VERSION,
    source: { app_id: HUB_APP_ID, app_version: APP_VERSION },
    subject: { type: subject.type, external_id: subject.external_id },
    data: validated.data,
    occurred_at: isoWithOffset(occurredAt),
    recorded_at: isoWithOffset(now),
    metadata: {},
  };
  const body = JSON.stringify(envelope);
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return { ok: false, error: `${type}: body vượt 64 KB` };
  return { ok: true, envelope, body };
}

export interface EnqueueInput extends BuildEnvelopeInput {
  /** Khóa nghiệp vụ: cùng khóa thì không tạo sự kiện thứ 2 (mở lại màn kết quả, chạy lại...). */
  dedupeKey?: string;
}

export interface EnqueueResult {
  enqueued: boolean;
  eventId?: string;
  /** Lý do khi dữ liệu không hợp lệ (không chứa bí mật). */
  error?: string;
}

/**
 * Ghi 1 sự kiện vào outbox với status pending. Ghi cả khi tích hợp đang tắt (hợp đồng mục 8).
 * Payload đóng băng: event_id, occurred_at, recorded_at không đổi khi gửi lại.
 */
export async function enqueueEvent(db: Db, input: EnqueueInput): Promise<EnqueueResult> {
  if (input.type === "external_app.heartbeat") return { enqueued: false, error: "heartbeat không đi qua outbox" };
  const built = buildEnvelope(input);
  if (!built.ok) return { enqueued: false, error: built.error };
  const now = input.now ?? new Date();
  const result = await db.execute(
    `INSERT INTO hub_outbox (event_id, event_type, payload, dedupe_key, status, recorded_at)
     VALUES (?, ?, ?, ?, 'pending', ?)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [built.envelope.event_id, input.type, built.body, input.dedupeKey ?? null, now.toISOString()],
  );
  return result.rowsAffected > 0 ? { enqueued: true, eventId: built.envelope.event_id } : { enqueued: false };
}

// ---- Helper cho giao diện ----

/** Kết thúc 1 lượt ôn từ vựng. Phiên < 1 phút không gửi. Gọi lại với cùng sessionId không tạo sự kiện mới. */
export async function reportSessionCompleted(
  db: Db,
  input: { sessionId: string; startedAt: Date; endedAt: Date; itemsReviewed?: number; now?: Date },
): Promise<EnqueueResult> {
  const minutes = Math.floor((input.endedAt.getTime() - input.startedAt.getTime()) / 60_000);
  if (!(minutes >= 1)) return { enqueued: false };
  const data: Record<string, unknown> = {
    // Phiên quá 24 giờ (để app mở rồi bỏ đó): giới hạn ở mức tối đa hợp đồng cho phép.
    duration_minutes: Math.min(minutes, 1440),
    activity: "vocabulary",
    started_at: isoWithOffset(input.startedAt),
    ended_at: isoWithOffset(input.endedAt),
  };
  if (input.itemsReviewed !== undefined) data.items_reviewed = Math.max(0, Math.trunc(input.itemsReviewed));
  return enqueueEvent(db, {
    type: "learning.session.completed",
    subject: { type: "session", external_id: input.sessionId },
    data,
    occurredAt: input.endedAt,
    dedupeKey: `session:${input.sessionId}`,
    now: input.now,
  });
}

/** Hoàn thành 1 bài (lượt luyện tập). `lessonId` ổn định cho mỗi lần hoàn thành; dùng làm subject.external_id. */
export async function reportLessonCompleted(
  db: Db,
  input: {
    lessonId: string;
    title: string;
    durationMinutes?: number;
    score?: number;
    level?: string;
    occurredAt?: Date;
    now?: Date;
  },
): Promise<EnqueueResult> {
  const occurredAt = input.occurredAt ?? input.now ?? new Date();
  const data: Record<string, unknown> = { title: input.title };
  if (input.durationMinutes !== undefined) {
    const minutes = Math.round(input.durationMinutes);
    if (minutes >= 1) data.duration_minutes = Math.min(minutes, 1440);
  }
  if (input.score !== undefined && Number.isFinite(input.score)) data.score = Math.min(100, Math.max(0, input.score));
  if (input.level !== undefined && LEVELS.includes(input.level)) data.level = input.level;
  return enqueueEvent(db, {
    type: "lesson.completed",
    subject: { type: "lesson", external_id: input.lessonId },
    data,
    occurredAt,
    dedupeKey: `lesson:${input.lessonId}`,
    now: input.now,
  });
}

/**
 * Sau 1 lượt ôn: từ nào trong `wordIds` lần đầu đạt "Vững" thì gom vào 1 sự kiện vocabulary.learned.
 * Gọi 1 lần cho mỗi lượt ôn (khi kết thúc lượt): gọi lại với cùng sessionId không tạo sự kiện mới.
 */
export async function reportNewlyMastered(
  db: Db,
  input: { sessionId: string; wordIds: number[]; occurredAt: Date; deck?: string; now?: Date },
): Promise<EnqueueResult> {
  if (input.wordIds.length === 0) return { enqueued: false };
  const rows = await db.select<{ id: number; term: string }>(
    `SELECT w.id, w.term FROM words w
     JOIN cards c ON c.word_id = w.id AND c.skill = 'meaning'
     WHERE w.id IN (SELECT value FROM json_each(?))
       AND c.stability >= ?
       AND NOT EXISTS (SELECT 1 FROM hub_mastered_reported r WHERE r.word_id = w.id)
     ORDER BY w.id`,
    [JSON.stringify([...new Set(input.wordIds)]), MASTERED_STABILITY],
  );
  if (rows.length === 0) return { enqueued: false };

  const data: Record<string, unknown> = { count: rows.length, words: rows.map((r) => r.term) };
  if (input.deck !== undefined) data.deck = input.deck;
  // Ghi outbox trước rồi mới đánh dấu: nếu crash giữa chừng, lần chạy lại bị dedupeKey chặn trùng.
  const result = await enqueueEvent(db, {
    type: "vocabulary.learned",
    subject: { type: "vocabulary_batch", external_id: input.sessionId },
    data,
    occurredAt: input.occurredAt,
    dedupeKey: `vocab:${input.sessionId}`,
    now: input.now,
  });
  if (result.error) return result;

  const reportedAt = (input.now ?? new Date()).toISOString();
  await db.execute(
    `INSERT INTO hub_mastered_reported (word_id, reported_at)
     SELECT value, ? FROM json_each(?)
     WHERE true
     ON CONFLICT (word_id) DO NOTHING`,
    [reportedAt, JSON.stringify(rows.map((r) => r.id))],
  );
  return result;
}
