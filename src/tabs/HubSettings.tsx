import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Db } from "../db/db";
import { loadHubConfig, saveHubConfig } from "../hub/config";
import { getHubStatus, retryFailedEvents, type HubSender, type HubStatus } from "../hub/sender";

type Form = { enabled: boolean; url: string; apiKey: string };

const STATUS_REFRESH_MS = 10_000;

/** Mục cài đặt tích hợp Personal Productivity Hub. API key không bao giờ hiện lại sau khi lưu. */
export default function HubSettings({ db, sender }: { db: Db; sender?: HubSender }) {
  const [form, setForm] = useState<Form | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [status, setStatus] = useState<HubStatus | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const readStatus = useCallback(() => (sender ? sender.status() : getHubStatus(db)), [db, sender]);

  useEffect(() => {
    let cancelled = false;
    loadHubConfig(db)
      .then((c) => {
        if (cancelled) return;
        setForm({ enabled: c.enabled, url: c.url, apiKey: "" });
        setHasKey(c.apiKey !== "");
      })
      .catch((e: unknown) => !cancelled && setMessage({ kind: "error", text: `Lỗi khi tải cấu hình Hub: ${String(e)}` }));
    return () => {
      cancelled = true;
    };
  }, [db]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      readStatus()
        .then((s) => !cancelled && setStatus(s))
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, STATUS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [readStatus]);

  if (!form) {
    return message ? <p className="error">{message.text}</p> : <p className="muted">Đang tải…</p>;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    try {
      const result = await saveHubConfig(db, form);
      if (!result.ok) {
        setMessage({ kind: "error", text: result.message });
        return;
      }
      if (form.apiKey.trim() !== "") setHasKey(true);
      setForm((f) => (f ? { ...f, apiKey: "" } : f));
      setMessage({ kind: "ok", text: "Đã lưu cấu hình Hub." });
      setStatus(await readStatus());
      // Gửi nền, không bắt Save chờ (Hub chậm có thể mất tới 10 giây/sự kiện); vừa bật thì báo heartbeat luôn.
      if (sender) {
        void sender
          .sendHeartbeat()
          .then(() => sender.kick())
          .then(readStatus)
          .then(setStatus)
          .catch(() => {});
      }
    } catch {
      setMessage({ kind: "error", text: "Lỗi khi lưu cấu hình Hub." });
    }
  }

  async function retry() {
    try {
      if (sender) await sender.retryFailed();
      else await retryFailedEvents(db);
      setStatus(await readStatus());
    } catch {
      setMessage({ kind: "error", text: "Không thử lại được sự kiện lỗi." });
    }
  }

  return (
    <section className="stack">
      <h2>Tích hợp Personal Productivity Hub</h2>
      <form className="card stack" onSubmit={save}>
        <label className="row">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Gửi tiến độ học sang Hub
        </label>
        <label className="field">
          <span>Địa chỉ Hub</span>
          <input
            type="text"
            value={form.url}
            placeholder="http://127.0.0.1:4317"
            onChange={(e) => setForm({ ...form, url: e.target.value })}
          />
        </label>
        <label className="field">
          <span>API key</span>
          <input
            type="password"
            autoComplete="off"
            value={form.apiKey}
            placeholder={hasKey ? "Để trống để giữ key đã lưu" : "pph_…"}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          />
          <span className="muted">{hasKey ? "Đã lưu key (pph_••••)" : "Chưa có key"}</span>
        </label>
        <div className="row">
          <button type="submit" className="primary">
            Lưu cấu hình Hub
          </button>
          {message && <span className={message.kind === "ok" ? "success" : "error"}>{message.text}</span>}
        </div>
      </form>

      {status && (
        <div className="card stack" aria-label="Trạng thái gửi sang Hub">
          {status.authProblem && <p className="error">Cần cấu hình lại API key của Hub</p>}
          {status.enabled && !status.hasApiKey && <p className="muted">Cần nhập API key để bắt đầu gửi.</p>}
          {!status.enabled && <p className="muted">Tích hợp đang tắt: sự kiện vẫn được lưu và sẽ gửi khi bật.</p>}
          <p>Đang chờ gửi: {status.pending} sự kiện</p>
          <div className="row">
            <span>Gửi lỗi: {status.failed} sự kiện</span>
            {status.failed > 0 && (
              <button type="button" onClick={retry}>
                Thử lại sự kiện lỗi
              </button>
            )}
          </div>
          <p>
            Gửi thành công gần nhất:{" "}
            {status.lastDeliveredAt ? new Date(status.lastDeliveredAt).toLocaleString("vi-VN") : "chưa có"}
          </p>
          {status.lastError && <p className="muted">Lỗi gần nhất: {status.lastError}</p>}
        </div>
      )}
    </section>
  );
}
