// Hub giả lập CHỈ dùng khi phát triển/kiểm thử (docs/2026-11-07-japanese-app-integration.md, mục 7 và 9).
// Chỉ lắng nghe 127.0.0.1, không lưu gì ra đĩa (nhớ event_id trong bộ nhớ).
//
// Cách chạy:
//   npm run fake-hub -- [port] [apiKey]          (mặc định 4317, key lấy từ HUB_API_KEY hoặc "pph_devdevdevdevdevdevdevdevdevdev00")
//   MODE=500 npm run fake-hub                     (ép mọi request trả 400/401/404/429/500)
/* global console */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import process from "node:process";

const EVENTS_PATH = "/api/v1/integrations/events";
const MAX_BODY_BYTES = 64 * 1024;
const FORCED_MODES = new Set(["400", "401", "404", "429", "500"]);

const port = Number(process.argv[2] ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Port không hợp lệ: ${process.argv[2]}`);
  process.exit(1);
}
const apiKey = process.argv[3] ?? process.env.HUB_API_KEY ?? "pph_devdevdevdevdevdevdevdevdevdev00";
const mode = process.env.MODE ?? "";
if (mode !== "" && !FORCED_MODES.has(mode)) {
  console.error(`MODE không hợp lệ: ${mode} (chỉ nhận ${[...FORCED_MODES].join("/")})`);
  process.exit(1);
}

/** event_id → sha256 của body đã nhận lần đầu. */
const seen = new Map();

function send(res, status, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function errorBody(code, message, details) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function log(status, text) {
  console.log(`${new Date().toISOString()} → ${status} ${text}`);
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== EVENTS_PATH) {
    log(404, `${req.method} ${req.url}`);
    send(res, 404, errorBody("NOT_FOUND", "Không có endpoint này"));
    return;
  }

  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) tooLarge = true;
    else chunks.push(chunk);
  });
  req.on("end", () => {
    if (mode !== "") {
      const status = Number(mode);
      log(status, `(MODE=${mode} ép lỗi)`);
      const codes = { 400: "VALIDATION", 401: "UNAUTHORIZED", 404: "NOT_FOUND", 429: "RATE_LIMITED", 500: "INTERNAL" };
      send(res, status, status === 404 ? undefined : errorBody(codes[status], `Lỗi giả lập ${status}`));
      return;
    }

    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      // Không in key nhận được ra log.
      log(401, "sai hoặc thiếu API key");
      send(res, 401, errorBody("UNAUTHORIZED", "API key không hợp lệ"));
      return;
    }

    if (tooLarge) {
      log(413, `body ${size} byte`);
      send(res, 413, errorBody("PAYLOAD_TOO_LARGE", "Body quá lớn"));
      return;
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      log(400, "body không phải JSON");
      send(res, 400, errorBody("VALIDATION", "Body không phải JSON hợp lệ"));
      return;
    }
    const eventId = event?.event_id;
    if (typeof eventId !== "string" || eventId === "" || typeof event?.event_type !== "string") {
      log(400, "thiếu event_id/event_type");
      send(res, 400, errorBody("VALIDATION", "Thiếu event_id hoặc event_type", { body: event }));
      return;
    }

    const hash = createHash("sha256").update(raw).digest("hex");
    const previous = seen.get(eventId);
    if (previous !== undefined) {
      if (previous === hash) {
        log(200, `duplicate ${event.event_type} ${eventId}`);
        send(res, 200, { success: true, event_id: eventId, status: "duplicate" });
      } else {
        log(409, `conflict ${event.event_type} ${eventId}`);
        send(res, 409, errorBody("CONFLICT", "Cùng event_id nhưng nội dung khác"));
      }
      return;
    }

    seen.set(eventId, hash);
    log(202, `accepted ${event.event_type} ${eventId}\n${JSON.stringify(event, null, 2)}`);
    send(res, 202, { success: true, event_id: eventId, status: "accepted" });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Hub giả lập: http://127.0.0.1:${port}${EVENTS_PATH}${mode ? ` (MODE=${mode})` : ""}`);
});
