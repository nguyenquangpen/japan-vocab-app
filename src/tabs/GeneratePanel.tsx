import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useState } from "react";
import type { Db } from "../db/db";
import {
  buildPracticePrompt,
  listWordsForPrompt,
  parsePracticeResponse,
  savePracticeItems,
  type ParsedPractice,
} from "../practice/generated";
import type { ReviewItem } from "../review/review";

/** Số từ tối đa mỗi lần gửi ChatGPT. */
export const PRACTICE_BATCH = 30;

interface Props {
  db: Db;
  /** Từ trong phạm vi đang chọn. */
  words: ReviewItem[];
  /** wordId đã có câu do ChatGPT tạo (để ưu tiên từ chưa có). */
  generatedWordIds: ReadonlySet<number>;
  level: string;
  onSaved: () => void;
}

type Message = { kind: "ok" | "error" | "muted"; text: string };

/** Tạo câu điền từ / xếp câu bằng ChatGPT web: copy prompt → dán JSON → xem trước → lưu. Không đổi lịch ôn. */
export default function GeneratePanel({ db, words, generatedWordIds, level, onSaved }: Props) {
  const [pasted, setPasted] = useState("");
  const [preview, setPreview] = useState<{ items: ParsedPractice[]; notes: string[] } | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);

  // Lô: ưu tiên từ chưa có câu ChatGPT, tối đa PRACTICE_BATCH từ.
  const batch = [
    ...words.filter((w) => !generatedWordIds.has(w.wordId)),
    ...words.filter((w) => generatedWordIds.has(w.wordId)),
  ].slice(0, PRACTICE_BATCH);
  const missingCount = words.filter((w) => !generatedWordIds.has(w.wordId)).length;

  async function copyPrompt() {
    try {
      const promptWords = await listWordsForPrompt(db, batch.map((w) => w.wordId));
      await writeText(buildPracticePrompt(promptWords, level));
      setMessage({ kind: "ok", text: `Đã copy prompt cho ${promptWords.length} từ. Dán vào ChatGPT rồi copy kết quả về ô bên dưới.` });
    } catch (e) {
      setMessage({ kind: "error", text: `Không copy được: ${String(e)}` });
    }
  }

  function showPreview() {
    const result = parsePracticeResponse(pasted, batch.map((w) => ({ id: w.wordId, term: w.term })));
    if (!result.ok) {
      setPreview(null);
      setMessage({ kind: "error", text: result.message });
      return;
    }
    const notes: string[] = [];
    if (result.unmatched.length > 0) notes.push(`Bỏ qua từ không có trong lô: ${result.unmatched.join("、")}`);
    if (result.missing.length > 0) notes.push(`ChatGPT chưa trả về: ${result.missing.join("、")}`);
    setPreview({ items: result.items, notes });
    setMessage(null);
  }

  async function save() {
    if (!preview || busy) return;
    setBusy(true);
    try {
      const count = await savePracticeItems(db, preview.items);
      setMessage({ kind: "ok", text: `Đã lưu ${count} câu luyện tập cho ${preview.items.length} từ.` });
      setPreview(null);
      setPasted("");
      onSaved();
    } catch (e) {
      setMessage({ kind: "error", text: `Lỗi khi lưu: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  const clozeCount = preview?.items.reduce((n, i) => n + i.cloze.length, 0) ?? 0;
  const orderCount = preview?.items.reduce((n, i) => n + i.order.length, 0) ?? 0;

  return (
    <div className="card stack generate-panel">
      <h2>🤖 Tạo thêm câu luyện tập bằng ChatGPT</h2>
      <p className="muted small">
        Dùng cho bài ✏️ Điền từ và 🧩 Xếp câu. Lô này: {batch.length} từ trong phạm vi
        {missingCount > 0 ? ` (${missingCount} từ chưa có câu ChatGPT, được ưu tiên)` : " (tất cả đã có, tạo lại sẽ thay câu cũ)"}.
      </p>
      <div className="row">
        <button className="primary" onClick={() => void copyPrompt()} disabled={batch.length === 0}>
          Copy prompt
        </button>
      </div>
      <label className="field">
        <span>Dán kết quả từ ChatGPT</span>
        <textarea rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='{"items":[...]}' />
      </label>
      <div className="row">
        <button onClick={showPreview} disabled={pasted.trim() === "" || batch.length === 0}>
          Xem trước
        </button>
        {preview && (
          <button className="primary" onClick={() => void save()} disabled={busy || preview.items.length === 0}>
            Lưu {clozeCount} câu điền + {orderCount} câu xếp
          </button>
        )}
      </div>
      {preview && (
        <p className="small">
          {preview.items.length} từ khớp · {clozeCount} câu điền từ · {orderCount} câu xếp. Lưu sẽ thay câu ChatGPT cũ của các từ
          này.
        </p>
      )}
      {preview?.notes.map((n) => (
        <p key={n} className="muted small">
          {n}
        </p>
      ))}
      {message && <p className={`${message.kind === "ok" ? "success" : message.kind} pre-line`}>{message.text}</p>}
    </div>
  );
}
