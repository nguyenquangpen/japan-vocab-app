// Hợp đồng v1 với Personal Productivity Hub (docs/2026-11-07-japanese-app-integration.md).
// App chỉ gửi "sự thật đã xảy ra"; không gửi XP/Goal/tiến độ của Hub.

export const HUB_APP_ID = "japanese-learning-app";
export const HUB_SCHEMA_VERSION = 1;
export const HUB_DEFAULT_URL = "http://127.0.0.1:4317";
export const HUB_EVENTS_PATH = "/api/v1/integrations/events";

export type HubEventType =
  | "vocabulary.learned"
  | "lesson.completed"
  | "learning.session.completed"
  | "external_app.heartbeat";

export interface HubEnvelope {
  event_id: string;
  event_type: HubEventType;
  schema_version: 1;
  source: { app_id: typeof HUB_APP_ID; app_version: string };
  subject: { type: string; external_id: string };
  data: Record<string, unknown>;
  /** ISO 8601 có offset (vd. 2026-11-07T09:30:00+07:00). */
  occurred_at: string;
  /** ISO 8601 có offset; không đổi khi gửi lại. */
  recorded_at: string;
  metadata?: Record<string, unknown>;
}

/** Kết quả 1 lần POST (từ lệnh Rust `hub_post`). */
export type HubPostResult =
  | { kind: "response"; status: number; body: string }
  /** Không kết nối được / quá 10 giây (Hub đang tắt — bình thường). */
  | { kind: "network"; message: string };

/**
 * Hàm gửi 1 request, truyền vào để test thay bằng Hub giả lập.
 * `baseUrl` là địa chỉ gốc `http://127.0.0.1:<port>` (không kèm đường dẫn); lệnh Rust tự gắn
 * `HUB_EVENTS_PATH`. Reject khi đầu vào không hợp lệ (lỗi cấu hình).
 */
export type HubPost = (baseUrl: string, apiKey: string, body: string) => Promise<HubPostResult>;
