import type { Db } from "../db/db";
import packageJson from "../../package.json";
import { HUB_DEFAULT_URL } from "./types";

// Cấu hình tích hợp Hub (hợp đồng mục 8), lưu trong bảng settings.
// API key chỉ được đọc để gửi; không bao giờ đưa vào log, thông báo lỗi hay giao diện.

/** Version của app gửi trong `source.app_version`. */
export const APP_VERSION: string = packageJson.version;

export const HUB_SETTING_KEYS = { enabled: "hub_enabled", url: "hub_url", apiKey: "hub_api_key" } as const;

export interface HubConfig {
  enabled: boolean;
  url: string;
  /** Rỗng khi chưa có key. */
  apiKey: string;
}

export const DEFAULT_HUB_CONFIG: HubConfig = { enabled: false, url: HUB_DEFAULT_URL, apiKey: "" };

// Phải khớp đúng validate_hub_url trong src-tauri/src/hub.rs (không số 0 đứng đầu cổng).
const URL_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;
const API_KEY_PATTERN = /^pph_[A-Za-z0-9]{32}$/;

export function isValidHubUrl(url: string): boolean {
  const m = URL_PATTERN.exec(url);
  if (!m) return false;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535;
}

export function isValidApiKey(key: string): boolean {
  return API_KEY_PATTERN.test(key);
}

export type HubSaveResult = { ok: true } | { ok: false; message: string };

/**
 * Lưu cấu hình. `apiKey` rỗng = giữ key đang lưu (ô nhập để trống).
 * Thông báo lỗi không bao giờ chứa key người dùng nhập.
 */
export async function saveHubConfig(db: Db, config: HubConfig): Promise<HubSaveResult> {
  const url = config.url.trim();
  const apiKey = config.apiKey.trim();
  if (!isValidHubUrl(url)) {
    return { ok: false, message: "Địa chỉ Hub phải có dạng http://127.0.0.1:<cổng> (cổng 1–65535)." };
  }
  if (apiKey !== "" && !isValidApiKey(apiKey)) {
    return { ok: false, message: "API key không đúng định dạng (pph_ + 32 chữ/số)." };
  }

  const rows: string[] = [HUB_SETTING_KEYS.enabled, config.enabled ? "1" : "0", HUB_SETTING_KEYS.url, url];
  if (apiKey !== "") rows.push(HUB_SETTING_KEYS.apiKey, apiKey);
  const placeholders = Array.from({ length: rows.length / 2 }, () => "(?, ?)").join(", ");
  await db.execute(
    `INSERT INTO settings (key, value) VALUES ${placeholders}
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    rows,
  );
  // Đổi cấu hình (vd. sửa cổng, bật Hub) thì gửi lại ngay, không đợi hết backoff (có thể tới 1 giờ).
  await db.execute("UPDATE hub_outbox SET next_attempt_at = NULL WHERE status = 'pending'");
  return { ok: true };
}

/** Đọc cấu hình; giá trị thiếu/hỏng thì dùng mặc định (key hỏng coi như chưa có key). */
export async function loadHubConfig(db: Db): Promise<HubConfig> {
  const rows = await db.select<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key IN (?, ?, ?)",
    [HUB_SETTING_KEYS.enabled, HUB_SETTING_KEYS.url, HUB_SETTING_KEYS.apiKey],
  );
  const raw = new Map(rows.map((r) => [r.key, r.value]));
  const url = raw.get(HUB_SETTING_KEYS.url) ?? "";
  const apiKey = raw.get(HUB_SETTING_KEYS.apiKey) ?? "";
  return {
    enabled: raw.get(HUB_SETTING_KEYS.enabled) === "1",
    url: isValidHubUrl(url) ? url : DEFAULT_HUB_CONFIG.url,
    apiKey: isValidApiKey(apiKey) ? apiKey : "",
  };
}
