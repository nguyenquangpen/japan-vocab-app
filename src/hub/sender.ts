import type { Db } from "../db/db";
import { loadHubConfig, type HubConfig } from "./config";
import { buildEnvelope } from "./events";
import { HUB_APP_ID, type HubPost, type HubPostResult } from "./types";

// Bộ gửi nền (hợp đồng mục 7): gửi tuần tự từng sự kiện pending theo recorded_at, phân loại phản hồi,
// retry có backoff. Mọi request (kể cả heartbeat) đi qua 1 hàng đợi nội bộ nên không bao giờ gửi song song.

const SECOND = 1000;
const HOUR = 3600 * SECOND;
export const BACKOFF_BASE_MS = 30 * SECOND;
export const BACKOFF_MAX_MS = HOUR;
export const AUTH_PAUSE_MS = HOUR;
export const NOT_FOUND_RETRY_MS = HOUR;
export const MAX_TRANSIENT_ATTEMPTS = 20;
export const HEARTBEAT_INTERVAL_MS = 6 * HOUR;
export const DELIVERED_RETENTION_MS = 30 * 24 * HOUR;
const MAX_ERROR_LENGTH = 1000;

export interface HubStatus {
  enabled: boolean;
  hasApiKey: boolean;
  /** Số sự kiện chờ gửi (heartbeat không bao giờ nằm trong outbox). */
  pending: number;
  failed: number;
  /** ISO UTC, null nếu chưa gửi được lần nào (hoặc đã dọn sau 30 ngày). */
  lastDeliveredAt: string | null;
  /** Lỗi gần nhất của sự kiện chưa delivered (đã che API key). */
  lastError: string | null;
  /** Hub trả 401/403: cần cấu hình lại API key. */
  authProblem: boolean;
}

export interface HubSender {
  /** Gửi heartbeat, bắt đầu gửi outbox và hẹn heartbeat mỗi 6 giờ. */
  start(): void;
  /** Hủy mọi hẹn giờ; request đang chạy (nếu có) vẫn kết thúc bình thường. */
  stop(): void;
  /** Kích hoạt gửi ngay (sau khi tạo sự kiện mới / đổi cấu hình). Promise xong khi lượt gửi kết thúc. */
  kick(): Promise<void>;
  /** Chuyển các sự kiện failed về pending rồi gửi lại. */
  retryFailed(): Promise<void>;
  status(): Promise<HubStatus>;
  /** Gửi heartbeat nếu đã quá 6 giờ từ lần trước. Lỗi bị bỏ qua. */
  sendHeartbeat(): Promise<void>;
}

export interface HubSenderOptions {
  db: Db;
  post: HubPost;
  now?: () => Date;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Ghi lỗi nội bộ (DB...). Mặc định console.error. Không bao giờ nhận API key. */
  onError?: (message: string) => void;
}

/** 30 s × 2^(n−1), tối đa 1 giờ, ±20% ngẫu nhiên. `attempt` bắt đầu từ 1. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_MS);
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** Che API key (key đang dùng và mọi chuỗi dạng pph_…) trước khi ghi lỗi. */
export function redactSecrets(text: string, apiKey?: string): string {
  let out = apiKey ? text.split(apiKey).join("pph_••••") : text;
  out = out.replace(/pph_[A-Za-z0-9]{8,}/g, "pph_••••");
  return out.length > MAX_ERROR_LENGTH ? `${out.slice(0, MAX_ERROR_LENGTH)}…` : out;
}

/** Đọc trạng thái outbox (dùng được cả khi không có sender). */
export async function getHubStatus(db: Db, authProblem = false): Promise<HubStatus> {
  const config = await loadHubConfig(db);
  const [counts] = await db.select<{ pending: number | null; failed: number | null; last: string | null }>(
    `SELECT SUM(status = 'pending') AS pending, SUM(status = 'failed') AS failed, MAX(delivered_at) AS last
     FROM hub_outbox`,
  );
  const [err] = await db.select<{ last_error: string }>(
    `SELECT last_error FROM hub_outbox
     WHERE status IN ('pending', 'failed') AND last_error IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
  );
  return {
    enabled: config.enabled,
    hasApiKey: config.apiKey !== "",
    pending: Number(counts?.pending ?? 0),
    failed: Number(counts?.failed ?? 0),
    lastDeliveredAt: counts?.last ?? null,
    lastError: err ? redactSecrets(err.last_error, config.apiKey) : null,
    authProblem,
  };
}

/** Chuyển các sự kiện failed về pending, đếm lại số lần thử. */
export async function retryFailedEvents(db: Db): Promise<number> {
  const result = await db.execute(
    `UPDATE hub_outbox SET status = 'pending', attempts = 0, next_attempt_at = NULL
     WHERE status = 'failed'`,
  );
  return result.rowsAffected;
}

interface OutboxRow {
  id: number;
  payload: string;
  attempts: number;
  next_attempt_at: string | null;
}

function describeError(result: Extract<HubPostResult, { kind: "response" }>): string {
  let detail = "";
  try {
    const parsed = JSON.parse(result.body) as { error?: { code?: unknown; message?: unknown; details?: unknown } };
    const e = parsed?.error;
    if (e && typeof e === "object") {
      detail = [e.code, e.message].filter((x) => typeof x === "string" && x !== "").join(": ");
      if (e.details !== undefined) detail += ` | details: ${JSON.stringify(e.details)}`;
    }
  } catch {
    detail = result.body.slice(0, 300);
  }
  return detail ? `HTTP ${result.status} ${detail}` : `HTTP ${result.status}`;
}

export function createHubSender(options: HubSenderOptions): HubSender {
  const { db, post } = options;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const onError = options.onError ?? ((message: string) => console.error(message));

  let stopped = true;
  let queueTimer: unknown = null;
  let heartbeatTimer: unknown = null;
  /** 401/403: dừng cả hàng đợi tới khi cấu hình (url/key) đổi hoặc tới `until`. Chỉ giữ trong bộ nhớ. */
  let authPause: { fingerprint: string; until: number } | null = null;
  let lastHeartbeatAt: number | null = null;

  // Hàng đợi nội bộ: mọi request chạy nối tiếp nhau.
  let chain: Promise<void> = Promise.resolve();
  let pendingKick: Promise<void> | null = null;
  const serial = (task: () => Promise<void>): Promise<void> => {
    const run = chain.then(task).catch((e: unknown) => {
      onError(`Hub sender: ${e instanceof Error ? e.message : String(e)}`);
    });
    chain = run;
    return run;
  };

  const fingerprint = (c: HubConfig) => `${c.enabled}\n${c.url}\n${c.apiKey}`;

  function scheduleQueue(ms: number) {
    if (stopped) return;
    if (queueTimer !== null) clearTimer(queueTimer);
    queueTimer = setTimer(() => {
      queueTimer = null;
      void kick();
    }, Math.max(0, ms));
  }

  async function drain(): Promise<void> {
    const config = await loadHubConfig(db);
    if (!config.enabled || config.apiKey === "") return;

    const t = now().getTime();
    if (authPause) {
      if (authPause.fingerprint === fingerprint(config) && t < authPause.until) {
        scheduleQueue(authPause.until - t);
        return;
      }
      authPause = null;
    }

    await db.execute("DELETE FROM hub_outbox WHERE status = 'delivered' AND delivered_at < ?", [
      new Date(t - DELIVERED_RETENTION_MS).toISOString(),
    ]);

    // Chỉ truyền địa chỉ gốc http://127.0.0.1:<port>; đường dẫn cố định do lệnh Rust tự gắn.
    const url = config.url;
    for (;;) {
      const [row] = await db.select<OutboxRow>(
        `SELECT id, payload, attempts, next_attempt_at FROM hub_outbox
         WHERE status = 'pending' ORDER BY recorded_at, id LIMIT 1`,
      );
      if (!row) return;

      const current = now();
      if (row.next_attempt_at && row.next_attempt_at > current.toISOString()) {
        // Sự kiện đầu hàng đang chờ backoff (Hub tắt/quá tải): dừng cả hàng, giữ thứ tự.
        scheduleQueue(Date.parse(row.next_attempt_at) - current.getTime());
        return;
      }

      let result: HubPostResult;
      try {
        result = await post(url, config.apiKey, row.payload);
      } catch (e) {
        // Lệnh gửi từ chối đầu vào (URL/key/body sai) — lỗi cấu hình, không phải Hub tắt:
        // giữ sự kiện, dừng hàng đợi như 401 tới khi đổi cấu hình (hoặc 1 giờ).
        const message = e instanceof Error ? e.message : String(e);
        await db.execute("UPDATE hub_outbox SET last_error = ? WHERE id = ?", [
          redactSecrets(`Cấu hình Hub không hợp lệ: ${message}`, config.apiKey),
          row.id,
        ]);
        authPause = { fingerprint: fingerprint(config), until: now().getTime() + AUTH_PAUSE_MS };
        scheduleQueue(AUTH_PAUSE_MS);
        return;
      }
      const after = now();
      const attempts = row.attempts + 1;

      if (result.kind === "network") {
        // Hub tắt: retry không giới hạn, không bao giờ xóa; dừng cả hàng đợi.
        await retryLater(row.id, attempts, backoffMs(attempts, random), `Không kết nối được Hub: ${result.message}`, config, after);
        return;
      }

      const { status } = result;
      if (status === 202 || status === 200) {
        await db.execute(
          "UPDATE hub_outbox SET status = 'delivered', attempts = ?, delivered_at = ?, last_error = NULL, next_attempt_at = NULL WHERE id = ?",
          [attempts, after.toISOString(), row.id],
        );
        continue;
      }
      if (status === 401 || status === 403) {
        // Giữ nguyên sự kiện (không tính lần thử); chờ đổi cấu hình hoặc 1 giờ.
        authPause = { fingerprint: fingerprint(config), until: after.getTime() + AUTH_PAUSE_MS };
        scheduleQueue(AUTH_PAUSE_MS);
        return;
      }
      if (status === 404) {
        await retryLater(row.id, attempts, NOT_FOUND_RETRY_MS, "HTTP 404: Hub chưa có endpoint nhận sự kiện", config, after);
        return;
      }
      if (status === 429 || status >= 500) {
        if (attempts >= MAX_TRANSIENT_ATTEMPTS) {
          await markFailed(row.id, attempts, `${describeError(result)} (đã thử ${attempts} lần)`, config);
          continue;
        }
        await retryLater(row.id, attempts, backoffMs(attempts, random), describeError(result), config, after);
        return;
      }
      // 400 / 409 / 413 và mọi mã khác: lỗi phía app, không retry tự động; không chặn hàng đợi.
      await markFailed(row.id, attempts, describeError(result), config);
    }
  }

  async function retryLater(id: number, attempts: number, delay: number, error: string, config: HubConfig, at: Date) {
    await db.execute("UPDATE hub_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?", [
      attempts,
      new Date(at.getTime() + delay).toISOString(),
      redactSecrets(error, config.apiKey),
      id,
    ]);
    scheduleQueue(delay);
  }

  async function markFailed(id: number, attempts: number, error: string, config: HubConfig) {
    await db.execute(
      "UPDATE hub_outbox SET status = 'failed', attempts = ?, next_attempt_at = NULL, last_error = ? WHERE id = ?",
      [attempts, redactSecrets(error, config.apiKey), id],
    );
  }

  function kick(): Promise<void> {
    // Gộp nhiều lần kick liên tiếp thành 1 lượt chờ chạy.
    if (pendingKick) return pendingKick;
    const p = serial(async () => {
      pendingKick = null;
      await drain();
    });
    pendingKick = p;
    return p;
  }

  function sendHeartbeat(): Promise<void> {
    return serial(async () => {
      const t = now();
      if (lastHeartbeatAt !== null && t.getTime() - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
      const config = await loadHubConfig(db);
      if (!config.enabled || config.apiKey === "") return;
      const [{ n }] = await db.select<{ n: number }>("SELECT COUNT(*) AS n FROM hub_outbox WHERE status = 'pending'");
      const built = buildEnvelope({
        type: "external_app.heartbeat",
        subject: { type: "app", external_id: HUB_APP_ID },
        data: { outbox_pending: Number(n) },
        occurredAt: t,
        now: t,
      });
      if (!built.ok) return;
      lastHeartbeatAt = t.getTime();
      try {
        // Không đi qua outbox, không retry: kết quả (kể cả lỗi) bị bỏ qua.
        await post(config.url, config.apiKey, built.body);
      } catch {
        // Bỏ qua.
      }
    });
  }

  function scheduleHeartbeat() {
    if (stopped) return;
    heartbeatTimer = setTimer(() => {
      heartbeatTimer = null;
      void sendHeartbeat().then(scheduleHeartbeat);
    }, HEARTBEAT_INTERVAL_MS);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void sendHeartbeat();
      void kick();
      scheduleHeartbeat();
    },
    stop() {
      stopped = true;
      if (queueTimer !== null) clearTimer(queueTimer);
      if (heartbeatTimer !== null) clearTimer(heartbeatTimer);
      queueTimer = null;
      heartbeatTimer = null;
    },
    kick,
    async retryFailed() {
      await retryFailedEvents(db);
      await kick();
    },
    async status() {
      const s = await getHubStatus(db, false);
      if (authPause) {
        const config = await loadHubConfig(db);
        s.authProblem = authPause.fingerprint === fingerprint(config);
      }
      return s;
    },
    sendHeartbeat,
  };
}
