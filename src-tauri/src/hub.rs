//! Đoạn code mạng DUY NHẤT của app: gửi 1 sự kiện tới Personal Productivity Hub
//! chạy trên cùng máy (docs/2026-11-07-japanese-app-integration.md).
//!
//! Ràng buộc an toàn:
//! - Chỉ chấp nhận URL đúng dạng `http://127.0.0.1:<port>` (không host khác, không path).
//! - Đường dẫn cố định `/api/v1/integrations/events`, chỉ POST.
//! - Không TLS, không proxy (kể cả biến môi trường), không theo redirect, timeout 10 giây.
//! - API key chỉ nằm trong header `Authorization`, không bao giờ xuất hiện trong log/thông báo lỗi.

use std::io::Read;
use std::time::Duration;

use serde::Serialize;

const EVENTS_PATH: &str = "/api/v1/integrations/events";
const URL_PREFIX: &str = "http://127.0.0.1:";
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BODY_BYTES: u64 = 8 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);

/// Khớp với kiểu TS `HubPostResult` trong `src/hub/types.ts`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HubPostResult {
    /// Hub đã trả lời (mọi mã HTTP, kể cả 4xx/5xx).
    Response { status: u16, body: String },
    /// Không kết nối được / quá thời gian / lỗi IO.
    Network { message: String },
}

/// Kiểm tra URL nghiêm ngặt: đúng `http://127.0.0.1:<port>`, port 1–65535,
/// không số 0 ở đầu, không path/query/fragment/userinfo. Trả về port.
pub fn validate_hub_url(url: &str) -> Result<u16, String> {
    const INVALID: &str = "URL Hub không hợp lệ: chỉ chấp nhận http://127.0.0.1:<port>";
    let port_str = url.strip_prefix(URL_PREFIX).ok_or(INVALID)?;
    if port_str.is_empty()
        || port_str.len() > 5
        || !port_str.bytes().all(|b| b.is_ascii_digit())
        || port_str.starts_with('0')
    {
        return Err(INVALID.to_string());
    }
    match port_str.parse::<u16>() {
        Ok(port) if port >= 1 => Ok(port),
        _ => Err(INVALID.to_string()),
    }
}

/// API key chỉ được chứa ký tự ASCII nhìn thấy được (chặn chèn header bằng CR/LF).
fn validate_api_key(api_key: &str) -> Result<(), String> {
    if api_key.is_empty() || !api_key.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err("API key của Hub trống hoặc chứa ký tự không hợp lệ".to_string());
    }
    Ok(())
}

fn post_blocking(port: u16, api_key: &str, body: String) -> HubPostResult {
    let config = ureq::Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(TIMEOUT))
        .build();
    let agent: ureq::Agent = config.into();
    let url = format!("http://127.0.0.1:{port}{EVENTS_PATH}");

    let result = agent
        .post(&url)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Authorization", format!("Bearer {api_key}"))
        .send(body);

    match result {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let mut bytes = Vec::new();
            // Lỗi khi đọc body không làm mất mã trạng thái: giữ phần đã đọc được.
            let _ = response
                .body_mut()
                .as_reader()
                .take(MAX_RESPONSE_BODY_BYTES)
                .read_to_end(&mut bytes);
            HubPostResult::Response {
                status,
                body: String::from_utf8_lossy(&bytes).into_owned(),
            }
        }
        // Thông báo lỗi của ureq không chứa header nên không lộ API key.
        Err(err) => HubPostResult::Network {
            message: err.to_string(),
        },
    }
}

/// Lệnh Tauri: `invoke("hub_post", { url, apiKey, body })`.
/// Lỗi kiểm tra đầu vào → `Err(String)` (promise bị reject, không gửi gì cả).
#[tauri::command]
pub async fn hub_post(url: String, api_key: String, body: String) -> Result<HubPostResult, String> {
    let port = validate_hub_url(&url)?;
    validate_api_key(&api_key)?;
    if body.len() > MAX_REQUEST_BODY_BYTES {
        return Err("Sự kiện quá lớn (giới hạn 64 KB)".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || post_blocking(port, &api_key, body))
        .await
        .map_err(|_| "Lỗi nội bộ khi gửi tới Hub".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_loopback_ipv4_with_port() {
        assert_eq!(validate_hub_url("http://127.0.0.1:4317"), Ok(4317));
        assert_eq!(validate_hub_url("http://127.0.0.1:1"), Ok(1));
        assert_eq!(validate_hub_url("http://127.0.0.1:65535"), Ok(65535));
    }

    #[test]
    fn rejects_bad_ports() {
        for url in [
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
        ] {
            assert!(validate_hub_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn rejects_other_hosts_and_schemes() {
        for url in [
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
        ] {
            assert!(validate_hub_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn rejects_path_query_fragment_userinfo() {
        for url in [
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
        ] {
            assert!(validate_hub_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn validates_api_key() {
        assert!(validate_api_key("pph_0123456789abcdef0123456789abcdef").is_ok());
        assert!(validate_api_key("").is_err());
        assert!(validate_api_key("pph_abc\r\nX-Evil: 1").is_err());
        assert!(validate_api_key("pph abc").is_err());
    }

    #[test]
    fn serializes_like_ts_type() {
        let r = HubPostResult::Response {
            status: 202,
            body: "{}".into(),
        };
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"kind":"response","status":202,"body":"{}"}"#
        );
        let n = HubPostResult::Network {
            message: "x".into(),
        };
        assert_eq!(
            serde_json::to_string(&n).unwrap(),
            r#"{"kind":"network","message":"x"}"#
        );
    }

    #[test]
    fn closed_port_is_network_error() {
        // Port 1 trên loopback gần như chắc chắn không có ai nghe.
        match post_blocking(1, "pph_test", "{}".into()) {
            HubPostResult::Network { message } => assert!(!message.contains("pph_test")),
            other => panic!("expected network error, got {other:?}"),
        }
    }
    /// Chạy tay với Hub giả lập: `npm run fake-hub -- 4399 k1` rồi
    /// `HUB_TEST_PORT=4399 cargo test -- --ignored against_fake_hub`.
    #[test]
    #[ignore]
    fn against_fake_hub() {
        let port: u16 = std::env::var("HUB_TEST_PORT").unwrap().parse().unwrap();
        let body = r#"{"event_id":"rust-1","event_type":"external_app.heartbeat","data":{}}"#;
        let first = post_blocking(port, "k1", body.into());
        assert!(
            matches!(
                first,
                HubPostResult::Response {
                    status: 202 | 200,
                    ..
                }
            ),
            "{first:?}"
        );
        let again = post_blocking(port, "k1", body.into());
        assert!(
            matches!(again, HubPostResult::Response { status: 200, .. }),
            "{again:?}"
        );
        let unauthorized = post_blocking(port, "wrong", body.into());
        assert!(
            matches!(unauthorized, HubPostResult::Response { status: 401, .. }),
            "{unauthorized:?}"
        );
    }
}
