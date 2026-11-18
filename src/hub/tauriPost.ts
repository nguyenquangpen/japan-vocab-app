import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { HubPost, HubPostResult } from "./types";

// Kết quả từ lệnh Rust `hub_post` (src-tauri/src/hub.rs) — kiểm tra lại hình dạng trước khi dùng.
const hubPostResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("response"), status: z.number().int(), body: z.string() }),
  z.object({ kind: z.literal("network"), message: z.string() }),
]);

/**
 * Gửi 1 request tới Hub qua lệnh Rust (code mạng duy nhất của app).
 * Lỗi đầu vào (URL không phải http://127.0.0.1:<port>, key/body sai) → promise bị reject;
 * thông báo lỗi không bao giờ chứa API key.
 */
export const tauriHubPost: HubPost = async (url, apiKey, body) => {
  const raw = await invoke<unknown>("hub_post", { url, apiKey, body });
  const parsed = hubPostResultSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Kết quả hub_post không đúng định dạng");
  return parsed.data satisfies HubPostResult;
};
