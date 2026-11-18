// Hub giả lập và đồng hồ/hẹn giờ giả cho test (hợp đồng mục 9). Chỉ import từ file *.test.ts(x).
import { z } from "zod";
import type { HubPost, HubPostResult } from "./types";

z.config({ jitless: true });

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/);
const level = z.enum(["N5", "N4", "N3", "N2", "N1"]).optional();

const dataSchemas = {
  "vocabulary.learned": z.strictObject({
    count: z.int().min(1).max(1000),
    level,
    deck: z.string().max(100).optional(),
    words: z.array(z.string().max(50)).max(100).optional(),
  }),
  "lesson.completed": z.strictObject({
    title: z.string().min(1).max(200),
    duration_minutes: z.int().min(1).max(1440).optional(),
    score: z.number().min(0).max(100).optional(),
    level,
  }),
  "learning.session.completed": z.strictObject({
    duration_minutes: z.int().min(1).max(1440),
    activity: z.enum(["vocabulary", "kanji", "grammar", "listening", "reading", "mixed", "other"]),
    started_at: iso,
    ended_at: iso,
    items_reviewed: z.int().min(0).optional(),
  }),
  "external_app.heartbeat": z.strictObject({ outbox_pending: z.int().min(0) }),
} as const;

const subjectTypes = {
  "vocabulary.learned": "vocabulary_batch",
  "lesson.completed": "lesson",
  "learning.session.completed": "session",
  "external_app.heartbeat": "app",
} as const;

/** Schema envelope theo hợp đồng mục 4 + data theo mục 6. */
export const envelopeSchema = z
  .strictObject({
    event_id: z.uuid({ version: "v4" }),
    event_type: z.enum(["vocabulary.learned", "lesson.completed", "learning.session.completed", "external_app.heartbeat"]),
    schema_version: z.literal(1),
    source: z.strictObject({ app_id: z.literal("japanese-learning-app"), app_version: z.string().min(1) }),
    subject: z.strictObject({ type: z.string(), external_id: z.string().min(1).max(200) }),
    data: z.record(z.string(), z.unknown()),
    occurred_at: iso,
    recorded_at: iso,
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((env, ctx) => {
    const parsed = dataSchemas[env.event_type].safeParse(env.data);
    if (!parsed.success) ctx.addIssue({ code: "custom", message: `data: ${parsed.error.message}` });
    if (env.subject.type !== subjectTypes[env.event_type]) ctx.addIssue({ code: "custom", message: "subject.type" });
  });

export interface FakeRequest {
  url: string;
  apiKey: string;
  body: string;
  envelope: z.infer<typeof envelopeSchema>;
}

/**
 * Hub giả lập: mặc định trả 202, 200 duplicate khi event_id lặp; `offline` = không kết nối được;
 * `respond` để ép mã lỗi (trả undefined = hành vi mặc định).
 */
export interface FakeHub {
  offline: boolean;
  validKey: string;
  respond: ((req: FakeRequest) => HubPostResult | undefined) | undefined;
  requests: FakeRequest[];
  invalid: string[];
  markReceived: (eventId: string) => void;
  post: HubPost;
}

export function createFakeHub(validKey: string): FakeHub {
  const received = new Set<string>();
  const requests: FakeRequest[] = [];
  const hub: FakeHub = {
    offline: false,
    validKey,
    respond: undefined,
    requests,
    /** Body không khớp schema (tiêu chí 11: phải luôn rỗng). */
    invalid: [] as string[],
    /** Giả lập Hub đã nhận event_id này từ trước (vd. mất phản hồi). */
    markReceived: (eventId: string) => {
      received.add(eventId);
    },
    post: async (url, apiKey, body): Promise<HubPostResult> => {
      if (hub.offline) return { kind: "network", message: "connection refused" };
      const parsed = envelopeSchema.safeParse(JSON.parse(body));
      if (!parsed.success) {
        hub.invalid.push(parsed.error.message);
        return { kind: "response", status: 400, body: '{"error":{"code":"VALIDATION","message":"schema"}}' };
      }
      const req = { url, apiKey, body, envelope: parsed.data };
      requests.push(req);
      const forced = hub.respond?.(req);
      if (forced) return forced;
      if (apiKey !== hub.validKey) {
        return { kind: "response", status: 401, body: '{"error":{"code":"UNAUTHORIZED","message":"bad key"}}' };
      }
      const id = parsed.data.event_id;
      const status = received.has(id) ? "duplicate" : "accepted";
      received.add(id);
      return {
        kind: "response",
        status: status === "accepted" ? 202 : 200,
        body: JSON.stringify({ success: true, event_id: id, status }),
      };
    },
  };
  return hub;
}

/** Đồng hồ + hẹn giờ giả: `advance(ms)` chạy các hẹn giờ tới hạn. */
export function createFakeClock(start: Date) {
  let t = start.getTime();
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => new Date(t),
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    pendingTimers: () => [...timers.values()].map((x) => x.at - t).sort((a, b) => a - b),
    /** Tiến đồng hồ; chạy các hẹn giờ tới hạn theo thứ tự. */
    advance(ms: number) {
      const target = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
      }
      t = target;
    },
  };
}
