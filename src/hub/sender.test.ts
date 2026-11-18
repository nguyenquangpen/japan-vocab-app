import { describe, expect, it } from "vitest";
import type { Db } from "../db/db";
import { createTestDb } from "../db/nodeSqliteDb";
import { saveHubConfig } from "./config";
import { enqueueEvent } from "./events";
import { createFakeClock, createFakeHub } from "./fakeHub.test-helpers";
import { backoffMs, createHubSender, redactSecrets } from "./sender";

const START = new Date("2026-11-07T02:30:00Z");
const KEY = `pph_${"Ab12".repeat(8)}`;
const NEW_KEY = `pph_${"Zz98".repeat(8)}`;
const MIN = 60_000;
const HOUR = 60 * MIN;

async function setup(options: { enabled?: boolean; key?: string } = {}) {
  const db = createTestDb();
  await saveHubConfig(db, { enabled: options.enabled ?? true, url: "http://127.0.0.1:4999", apiKey: options.key ?? KEY });
  const hub = createFakeHub(KEY);
  const clock = createFakeClock(START);
  const errors: string[] = [];
  const sender = createHubSender({
    db,
    post: hub.post,
    now: clock.now,
    random: () => 0.5, // không jitter: backoff đúng 30 s × 2^(n−1)
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (m) => errors.push(m),
  });
  return { db, hub, clock, sender, errors };
}

let seq = 0;
async function addEvent(db: Db, now: Date, title = `Bài ${++seq}`) {
  const r = await enqueueEvent(db, {
    type: "lesson.completed",
    subject: { type: "lesson", external_id: `l-${seq}` },
    data: { title },
    occurredAt: now,
    now,
  });
  return r.eventId!;
}

async function rows(db: Db) {
  return db.select<{ event_id: string; status: string; attempts: number; next_attempt_at: string | null; last_error: string | null; payload: string }>(
    "SELECT event_id, status, attempts, next_attempt_at, last_error, payload FROM hub_outbox ORDER BY id",
  );
}

const sentEvents = (hub: ReturnType<typeof createFakeHub>) =>
  hub.requests.filter((r) => r.envelope.event_type !== "external_app.heartbeat");

describe("hub sender", () => {
  it("202 → delivered, không gửi lại (tiêu chí 2); gửi theo recorded_at tới đúng URL", async () => {
    const { db, hub, clock, sender } = await setup();
    const a = await addEvent(db, new Date(START.getTime() - 2 * MIN));
    const b = await addEvent(db, new Date(START.getTime() - MIN));
    await sender.kick();
    await sender.kick();
    expect(sentEvents(hub).map((r) => r.envelope.event_id)).toEqual([a, b]);
    // Chỉ địa chỉ gốc (lệnh Rust tự gắn đường dẫn) và phải qua đúng quy tắc của Rust: http://127.0.0.1:<port>.
    expect(hub.requests[0].url).toBe("http://127.0.0.1:4999");
    expect(hub.requests[0].url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
    expect(hub.requests[0].apiKey).toBe(KEY);
    expect((await rows(db)).map((r) => r.status)).toEqual(["delivered", "delivered"]);
    const status = await sender.status();
    expect(status.pending).toBe(0);
    expect(status.lastDeliveredAt).toBe(clock.now().toISOString());
    expect(hub.invalid).toEqual([]);
  });

  it("Hub tắt → giữ sự kiện, dừng cả hàng, backoff; bật lại → gửi với event_id/occurred_at/recorded_at như lúc tạo (tiêu chí 3)", async () => {
    const { db, hub, clock, sender } = await setup();
    await addEvent(db, START);
    await addEvent(db, START);
    const before = (await rows(db)).map((r) => r.payload);
    hub.offline = true;
    sender.start();
    await sender.kick();

    const [initial, second] = await rows(db);
    let first = initial;
    expect(first.status).toBe("pending");
    expect(first.attempts).toBe(1);
    expect(first.next_attempt_at).toBe(new Date(START.getTime() + 30_000).toISOString());
    expect(second.attempts).toBe(0); // không gửi sự kiện sau khi Hub đang tắt
    expect(first.last_error).toMatch(/Không kết nối được/);

    clock.advance(30_000);
    await sender.kick();
    [first] = await rows(db);
    expect(first.attempts).toBe(2);
    expect(first.next_attempt_at).toBe(new Date(clock.now().getTime() + 60_000).toISOString());

    hub.offline = false;
    clock.advance(60_000);
    await sender.kick();
    const after = await rows(db);
    expect(after.map((r) => r.status)).toEqual(["delivered", "delivered"]);
    expect(sentEvents(hub).map((r) => r.body)).toEqual(before);
    expect(hub.invalid).toEqual([]);
    sender.stop();
  });

  it("tắt app khi còn sự kiện chờ → mở lại vẫn còn và được gửi (tiêu chí 4)", async () => {
    const { db, hub, clock } = await setup();
    const id = await addEvent(db, START);
    // "Phiên" 1: không có sender nào chạy (app bị kill trước khi gửi).
    const sender2 = createHubSender({ db, post: hub.post, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    sender2.start();
    await sender2.kick();
    expect(sentEvents(hub).map((r) => r.envelope.event_id)).toEqual([id]);
    expect((await rows(db))[0].status).toBe("delivered");
    sender2.stop();
  });

  it("Hub đã nhận rồi (200 duplicate) → delivered, không báo lỗi (tiêu chí 5)", async () => {
    const { db, hub, sender } = await setup();
    const id = await addEvent(db, START);
    hub.markReceived(id);
    await sender.kick();
    const [row] = await rows(db);
    expect(row.status).toBe("delivered");
    expect(row.last_error).toBeNull();
    expect((await sender.status()).lastError).toBeNull();
  });

  it("400 → failed có lý do, sự kiện sau vẫn gửi; thử lại thủ công (tiêu chí 6)", async () => {
    const { db, hub, sender } = await setup();
    const bad = await addEvent(db, START);
    const good = await addEvent(db, START);
    hub.respond = (req) =>
      req.envelope.event_id === bad
        ? { kind: "response", status: 400, body: '{"error":{"code":"VALIDATION","message":"title quá dài","details":{"field":"data.title"}}}' }
        : undefined;
    await sender.kick();
    const [r1, r2] = await rows(db);
    expect(r1.status).toBe("failed");
    expect(r1.last_error).toContain("HTTP 400 VALIDATION: title quá dài");
    expect(r1.last_error).toContain("data.title");
    expect(r2.status).toBe("delivered");
    expect(sentEvents(hub).map((r) => r.envelope.event_id)).toEqual([bad, good]);
    const status = await sender.status();
    expect(status.failed).toBe(1);
    expect(status.lastError).toContain("title quá dài");

    hub.respond = undefined;
    await sender.retryFailed();
    expect((await rows(db)).map((r) => r.status)).toEqual(["delivered", "delivered"]);
  });

  it("409 và 413 → failed, không chặn hàng đợi", async () => {
    const { db, hub, sender } = await setup();
    await addEvent(db, START);
    await addEvent(db, START);
    await addEvent(db, START);
    const codes = [409, 413];
    hub.respond = () => {
      const status = codes.shift();
      return status ? { kind: "response", status, body: "" } : undefined;
    };
    await sender.kick();
    expect((await rows(db)).map((r) => r.status)).toEqual(["failed", "failed", "delivered"]);
  });

  it("401 → dừng, giữ outbox, báo cần cấu hình key; sửa key → gửi tiếp (tiêu chí 7)", async () => {
    const { db, hub, clock, sender } = await setup({ key: NEW_KEY }); // key sai
    hub.validKey = KEY;
    await addEvent(db, START);
    await addEvent(db, START);
    sender.start();
    await sender.kick();
    expect(sentEvents(hub)).toHaveLength(1);
    expect((await rows(db)).map((r) => [r.status, r.attempts])).toEqual([["pending", 0], ["pending", 0]]);
    expect((await sender.status()).authProblem).toBe(true);

    // Kick lại khi chưa đổi cấu hình: không gửi.
    clock.advance(10 * MIN);
    await sender.kick();
    expect(sentEvents(hub)).toHaveLength(1);

    await saveHubConfig(db, { enabled: true, url: "http://127.0.0.1:4999", apiKey: KEY });
    await sender.kick();
    expect((await rows(db)).map((r) => r.status)).toEqual(["delivered", "delivered"]);
    expect((await sender.status()).authProblem).toBe(false);
    sender.stop();
  });

  it("lệnh gửi từ chối đầu vào (cấu hình sai) → dừng như 401, không tăng số lần thử, có lý do", async () => {
    const { db, hub, sender } = await setup();
    await addEvent(db, START);
    const rejecting = createHubSender({
      db,
      post: () => Promise.reject(new Error("URL Hub không hợp lệ")),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await rejecting.kick();
    const [row] = await rows(db);
    expect([row.status, row.attempts, row.next_attempt_at]).toEqual(["pending", 0, null]);
    expect(row.last_error).toContain("Cấu hình Hub không hợp lệ: URL Hub không hợp lệ");
    expect((await rejecting.status()).authProblem).toBe(true);
    // Đổi sang bộ gửi đúng → gửi được.
    await sender.kick();
    expect(sentEvents(hub)).toHaveLength(1);
  });

  it("lưu cấu hình → sự kiện đang chờ backoff được gửi lại ngay", async () => {
    const { db, hub, sender } = await setup();
    await addEvent(db, START);
    hub.offline = true;
    await sender.kick();
    expect((await rows(db))[0].next_attempt_at).not.toBeNull();

    hub.offline = false;
    await saveHubConfig(db, { enabled: true, url: "http://127.0.0.1:4999", apiKey: "" });
    expect((await rows(db))[0].next_attempt_at).toBeNull();
    await sender.kick();
    expect((await rows(db))[0].status).toBe("delivered");
  });

  it("401 → tự thử lại sau 1 giờ dù cấu hình không đổi", async () => {
    const { db, hub, clock, sender } = await setup();
    await addEvent(db, START);
    hub.respond = () => ({ kind: "response", status: 403, body: "" });
    sender.start();
    await sender.kick();
    hub.respond = undefined;
    clock.advance(HOUR);
    await sender.kick();
    expect((await rows(db))[0].status).toBe("delivered");
    sender.stop();
  });

  it("404 → giữ, thử lại sau 1 giờ, không giới hạn số lần", async () => {
    const { db, hub, clock, sender } = await setup();
    await addEvent(db, START);
    hub.respond = () => ({ kind: "response", status: 404, body: "" });
    sender.start();
    for (let i = 0; i < 25; i++) {
      await sender.kick();
      clock.advance(HOUR);
    }
    await sender.kick();
    const [row] = await rows(db);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBeGreaterThan(20);
    sender.stop();
  });

  it("5xx/429 → backoff, tối đa 20 lần rồi failed, sự kiện sau tiếp tục", async () => {
    const { db, hub, clock, sender } = await setup();
    const a = await addEvent(db, START);
    await addEvent(db, START);
    hub.respond = (req) => (req.envelope.event_id === a ? { kind: "response", status: hub.requests.length % 2 ? 500 : 429, body: "" } : undefined);
    sender.start();
    for (let i = 0; i < 20; i++) {
      await sender.kick();
      clock.advance(HOUR + 1);
    }
    await sender.kick();
    const [r1, r2] = await rows(db);
    expect(r1.status).toBe("failed");
    expect(r1.attempts).toBe(20);
    expect(r2.status).toBe("delivered");
    sender.stop();
  });

  it("chỉ gửi khi đã bật và có key; tắt thì sự kiện vẫn nằm trong outbox", async () => {
    const off = await setup({ enabled: false });
    await addEvent(off.db, START);
    off.sender.start();
    await off.sender.kick();
    expect(off.hub.requests).toHaveLength(0);
    expect((await off.sender.status()).pending).toBe(1);
    off.sender.stop();
  });

  it("dọn sự kiện delivered quá 30 ngày", async () => {
    const { db, clock, sender } = await setup();
    await addEvent(db, START);
    await sender.kick();
    clock.advance(31 * 24 * HOUR);
    await addEvent(db, clock.now());
    await sender.kick();
    expect((await rows(db)).map((r) => r.status)).toEqual(["delivered"]);
  });

  it("heartbeat khi khởi động, tối đa 1 lần/6 giờ; Hub tắt → không lỗi, không lưu outbox (tiêu chí 10)", async () => {
    const { db, hub, clock, sender, errors } = await setup();
    await enqueueEvent(db, { type: "lesson.completed", subject: { type: "lesson", external_id: "x" }, data: { title: "t" }, occurredAt: START, now: START });
    hub.respond = (req) => (req.envelope.event_type === "lesson.completed" ? { kind: "response", status: 503, body: "" } : undefined);
    sender.start();
    await sender.kick();
    const beats = () => hub.requests.filter((r) => r.envelope.event_type === "external_app.heartbeat");
    expect(beats()).toHaveLength(1);
    expect(beats()[0].envelope.data).toEqual({ outbox_pending: 1 });
    expect(beats()[0].envelope.subject).toEqual({ type: "app", external_id: "japanese-learning-app" });

    await sender.sendHeartbeat();
    expect(beats()).toHaveLength(1);

    hub.offline = true;
    clock.advance(6 * HOUR);
    await sender.sendHeartbeat();
    await sender.kick();
    expect(errors).toEqual([]);
    const types = await db.select<{ event_type: string }>("SELECT event_type FROM hub_outbox");
    expect(types.map((t) => t.event_type)).toEqual(["lesson.completed"]);
    expect(hub.invalid).toEqual([]);
    sender.stop();
  });

  it("API key không xuất hiện trong last_error / trạng thái / log (tiêu chí 12)", async () => {
    const { db, hub, sender, errors } = await setup();
    await addEvent(db, START);
    await addEvent(db, START);
    hub.respond = (req) =>
      hub.requests.length === 1
        ? { kind: "response", status: 400, body: JSON.stringify({ error: { code: "VALIDATION", message: `bad key ${req.apiKey}` } }) }
        : { kind: "network", message: `failed Bearer ${req.apiKey}` };
    await sender.kick();
    const all = JSON.stringify(await rows(db)) + JSON.stringify(await sender.status()) + errors.join("");
    expect(all).not.toContain(KEY);
    expect(all).toContain("pph_••••");
  });
});

describe("backoffMs / redactSecrets", () => {
  it("30 s × 2^(n−1), tối đa 1 giờ, ±20%", () => {
    expect(backoffMs(1, () => 0.5)).toBe(30_000);
    expect(backoffMs(3, () => 0.5)).toBe(120_000);
    expect(backoffMs(20, () => 0.5)).toBe(HOUR);
    expect(backoffMs(1, () => 0)).toBe(24_000);
    expect(backoffMs(1, () => 1)).toBe(36_000);
  });

  it("che key", () => {
    expect(redactSecrets(`x ${KEY} y`)).toBe("x pph_•••• y");
  });
});
