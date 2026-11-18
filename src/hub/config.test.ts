import { describe, expect, it } from "vitest";
import { isValidHubUrl } from "./config";

// Cùng bộ ca với test `validate_hub_url` trong src-tauri/src/hub.rs: TS cho qua URL nào thì Rust cũng phải
// nhận URL đó (nếu không, mọi sự kiện bị lệnh hub_post từ chối — lỗi đã gặp khi ghép hai bên).
const VALID = ["http://127.0.0.1:4317", "http://127.0.0.1:1", "http://127.0.0.1:65535"];
const INVALID = [
  "http://127.0.0.1",
  "http://127.0.0.1:",
  "http://127.0.0.1:0",
  "http://127.0.0.1:04317",
  "http://127.0.0.1:65536",
  "http://127.0.0.1:999999",
  "http://127.0.0.1:-1",
  "http://127.0.0.1:+80",
  "http://127.0.0.1:43 17",
  "http://127.0.0.1:４３１７",
  "http://localhost:4317",
  "http://[::1]:4317",
  "http://0.0.0.0:4317",
  "http://127.0.0.2:4317",
  "http://127.0.0.1.evil.com:4317",
  "https://127.0.0.1:4317",
  "HTTP://127.0.0.1:4317",
  "ftp://127.0.0.1:4317",
  "//127.0.0.1:4317",
  "127.0.0.1:4317",
  " http://127.0.0.1:4317",
  "",
  "http://127.0.0.1:4317/",
  "http://127.0.0.1:4317/api/v1/integrations/events",
  "http://127.0.0.1:4317?x=1",
  "http://127.0.0.1:4317#a",
  "http://user@127.0.0.1:4317",
  "http://user:pw@127.0.0.1:4317",
  "http://127.0.0.1:4317@evil.com",
  "http://127.0.0.1:4317@evil.com:80",
  "http://127.0.0.1:4317\r\nHost: evil",
  "http://127.0.0.1:4317 ",
];

describe("isValidHubUrl (khớp validate_hub_url phía Rust)", () => {
  it.each(VALID)("nhận %s", (url) => expect(isValidHubUrl(url)).toBe(true));
  it.each(INVALID)("từ chối %j", (url) => expect(isValidHubUrl(url)).toBe(false));
});
