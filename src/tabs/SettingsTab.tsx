import { useEffect, useState, type FormEvent } from "react";
import type { Db } from "../db/db";
import {
  LEVELS,
  MAX_REVIEWS_MAX,
  NEW_PER_DAY_MAX,
  loadSettings,
  saveSettings,
  type Settings,
} from "../settings/settings";

type Form = { level: string; newPerDay: string; maxReviewsPerSession: string; gradeButtons: "2" | "4" };

export default function SettingsTab({ db }: { db: Db }) {
  const [form, setForm] = useState<Form | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadSettings(db)
      .then((s) => !cancelled && setForm(toForm(s)))
      .catch((e: unknown) => !cancelled && setMessage({ kind: "error", text: `Lỗi khi tải cài đặt: ${String(e)}` }));
    return () => {
      cancelled = true;
    };
  }, [db]);

  if (!form) return message ? <p className="error">{message.text}</p> : <p className="muted">Đang tải…</p>;

  const set = (key: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => (f ? { ...f, [key]: e.target.value } : f));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    try {
      const result = await saveSettings(db, {
        level: form.level,
        newPerDay: Number(form.newPerDay),
        maxReviewsPerSession: Number(form.maxReviewsPerSession),
        gradeButtons: form.gradeButtons === "4" ? 4 : 2,
      });
      setMessage(result.ok ? { kind: "ok", text: "Đã lưu. Áp dụng từ phiên ôn tiếp theo." } : { kind: "error", text: result.message });
    } catch (e) {
      setMessage({ kind: "error", text: `Lỗi khi lưu: ${String(e)}` });
    }
  }

  return (
    <section className="stack settings">
      <h1>Cài đặt</h1>
      <form className="card stack" onSubmit={save}>
        <label className="field">
          <span>Trình độ (dùng trong prompt gửi ChatGPT)</span>
          <select value={form.level} onChange={set("level")}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Số từ mới mỗi ngày (0–{NEW_PER_DAY_MAX}, mỗi từ 2 thẻ)</span>
          <input type="number" min={0} max={NEW_PER_DAY_MAX} value={form.newPerDay} onChange={set("newPerDay")} />
        </label>
        <label className="field">
          <span>Số thẻ ôn tối đa mỗi phiên (1–{MAX_REVIEWS_MAX})</span>
          <input
            type="number"
            min={1}
            max={MAX_REVIEWS_MAX}
            value={form.maxReviewsPerSession}
            onChange={set("maxReviewsPerSession")}
          />
        </label>
        <div className="field">
          <span>Nút chấm thẻ nghĩa</span>
          <label className="row">
            <input type="radio" name="grade" value="2" checked={form.gradeButtons === "2"} onChange={set("gradeButtons")} />
            2 nút: Quên / Nhớ
          </label>
          <label className="row">
            <input type="radio" name="grade" value="4" checked={form.gradeButtons === "4"} onChange={set("gradeButtons")} />
            4 nút: Quên / Khó / Nhớ / Dễ
          </label>
        </div>
        <div className="row">
          <button type="submit" className="primary">
            Lưu
          </button>
          {message && <span className={message.kind === "ok" ? "success" : "error"}>{message.text}</span>}
        </div>
      </form>
    </section>
  );
}

function toForm(s: Settings): Form {
  return {
    level: s.level,
    newPerDay: String(s.newPerDay),
    maxReviewsPerSession: String(s.maxReviewsPerSession),
    gradeButtons: s.gradeButtons === 4 ? "4" : "2",
  };
}
