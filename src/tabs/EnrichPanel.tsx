import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useState } from "react";
import type { Db } from "../db/db";
import {
  MAX_BATCH,
  buildEnrichPrompt,
  mergeEnrichment,
  parseEnrichResponse,
  previewFields,
  type EnrichItem,
  type FieldKey,
  type FieldPreview,
} from "../enrichment/enrichment";
import { loadSettings } from "../settings/settings";
import { getWord, listWords, saveEnrichment, type WordDetail, type WordSummary } from "../vocab/vocab";

interface Props {
  db: Db;
  /** Tăng lên mỗi khi có từ mới để tải lại danh sách. */
  version: number;
}

interface PreviewEntry {
  word: WordDetail;
  item: EnrichItem;
  fields: FieldPreview[];
  chosen: Set<FieldKey>;
}

type Message = { kind: "ok" | "error" | "muted"; text: string };

export default function EnrichPanel({ db, version }: Props) {
  const [pending, setPending] = useState<WordSummary[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pasted, setPasted] = useState("");
  const [preview, setPreview] = useState<PreviewEntry[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listWords(db, { status: "pending" })
      .then((rows) => {
        if (cancelled) return;
        setPending(rows);
        setSelected(new Set(rows.slice(0, MAX_BATCH).map((w) => w.id)));
      })
      .catch((e: unknown) => !cancelled && setMessage({ kind: "error", text: `Lỗi khi tải từ chờ bổ sung: ${String(e)}` }));
    return () => {
      cancelled = true;
    };
  }, [db, version, reloadKey]);

  const batch = pending.filter((w) => selected.has(w.id));

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_BATCH) next.add(id);
      return next;
    });
  }

  async function copyPrompt() {
    if (batch.length === 0) return;
    try {
      const { level } = await loadSettings(db);
      await writeText(buildEnrichPrompt(batch.map((w) => w.term), level));
      setMessage({ kind: "ok", text: `Đã copy prompt cho ${batch.length} từ. Dán vào ChatGPT rồi copy kết quả về ô bên dưới.` });
    } catch (e) {
      setMessage({ kind: "error", text: `Không copy được: ${String(e)}` });
    }
  }

  async function showPreview() {
    if (busy) return;
    setBusy(true);
    setPreview(null);
    setNotes([]);
    try {
      const result = parseEnrichResponse(pasted, batch);
      if (!result.ok) {
        setMessage({ kind: "error", text: result.message });
        return;
      }
      const entries: PreviewEntry[] = [];
      for (const { wordId, item } of result.matches) {
        const word = await getWord(db, wordId);
        if (!word) continue;
        const fields = previewFields(word, item);
        entries.push({
          word,
          item,
          fields,
          chosen: new Set(fields.filter((f) => f.useSuggestedByDefault).map((f) => f.key)),
        });
      }
      const extra: string[] = [];
      if (result.unmatched.length > 0) extra.push(`Bỏ qua từ không có trong lô: ${result.unmatched.join("、")}`);
      if (result.missing.length > 0) extra.push(`AI chưa trả về: ${result.missing.join("、")}`);
      setNotes(extra);
      setPreview(entries);
      setMessage(
        entries.length > 0
          ? { kind: "muted", text: "Kiểm tra bản xem trước rồi bấm Lưu." }
          : { kind: "error", text: "Không có từ nào khớp với lô đang chọn." },
      );
    } catch (e) {
      setMessage({ kind: "error", text: `Lỗi khi xem trước: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  function toggleField(wordId: number, key: FieldKey) {
    setPreview((entries) =>
      entries?.map((entry) => {
        if (entry.word.id !== wordId) return entry;
        const chosen = new Set(entry.chosen);
        if (chosen.has(key)) chosen.delete(key);
        else chosen.add(key);
        return { ...entry, chosen };
      }) ?? null,
    );
  }

  async function save() {
    if (!preview || busy) return;
    setBusy(true);
    const failed: string[] = [];
    let saved = 0;
    try {
      for (const entry of preview) {
        const result = await saveEnrichment(db, entry.word.id, mergeEnrichment(entry.word, entry.item, entry.chosen));
        if (result.status === "updated") saved += 1;
        else if (result.status === "duplicate") failed.push(`${entry.word.term}: cách đọc trùng với một từ khác`);
        else if (result.status === "invalid") failed.push(`${entry.word.term}: ${result.message}`);
        else failed.push(`${entry.word.term}: không còn trong kho`);
      }
      setPreview(null);
      setPasted("");
      setNotes(failed);
      setMessage({ kind: failed.length > 0 ? "error" : "ok", text: `Đã lưu ${saved} từ.${failed.length > 0 ? ` ${failed.length} từ lỗi:` : ""}` });
    } catch (e) {
      setMessage({ kind: "error", text: `Lỗi khi lưu (đã lưu ${saved} từ): ${String(e)}` });
    } finally {
      setBusy(false);
      setReloadKey((k) => k + 1);
    }
  }

  return (
    <div className="card stack">
      <h2>Chờ bổ sung ({pending.length})</h2>
      {pending.length === 0 ? (
        <p className="muted small">Không có từ nào chờ bổ sung.</p>
      ) : (
        <>
          <div className="row small">
            <span className="muted">
              Đã chọn {batch.length}/{Math.min(pending.length, MAX_BATCH)} (tối đa {MAX_BATCH} từ mỗi lô)
            </span>
            <button type="button" onClick={() => setSelected(new Set(pending.slice(0, MAX_BATCH).map((w) => w.id)))}>
              Chọn tất cả
            </button>
            <button type="button" onClick={() => setSelected(new Set())}>
              Bỏ chọn
            </button>
          </div>
          <div className="chips">
            {pending.map((w) => (
              <label key={w.id} className={selected.has(w.id) ? "chip active" : "chip"}>
                <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} />
                <span className="jp">{w.term}</span>
              </label>
            ))}
          </div>
          <div className="row">
            <button type="button" className="primary" onClick={() => void copyPrompt()} disabled={batch.length === 0}>
              Copy prompt
            </button>
          </div>
          <label className="field">
            <span>Dán kết quả từ ChatGPT</span>
            <textarea rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='{"words":[...]}' />
          </label>
          <div className="row">
            <button type="button" onClick={() => void showPreview()} disabled={busy || pasted.trim() === "" || batch.length === 0}>
              Xem trước
            </button>
          </div>
        </>
      )}

      {message && <p className={`${message.kind === "ok" ? "success" : message.kind} pre-line`}>{message.text}</p>}
      {notes.length > 0 && (
        <ul className="small">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {preview && preview.length > 0 && (
        <div className="stack">
          {preview.map((entry) => (
            <PreviewCard key={entry.word.id} entry={entry} onToggle={(key) => toggleField(entry.word.id, key)} />
          ))}
          <div className="row">
            <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
              Lưu {preview.length} từ
            </button>
            <button type="button" onClick={() => setPreview(null)} disabled={busy}>
              Hủy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewCard({ entry, onToggle }: { entry: PreviewEntry; onToggle: (key: FieldKey) => void }) {
  return (
    <div className="preview-card stack">
      <span className="jp word-term">{entry.word.term}</span>
      {entry.fields.length === 0 ? (
        <p className="muted small">AI không có gì mới. Lưu sẽ chỉ đánh dấu từ này là đã bổ sung.</p>
      ) : (
        <table className="preview-table small">
          <thead>
            <tr>
              <th>Trường</th>
              <th>Hiện có</th>
              <th>Gợi ý AI</th>
              <th>Dùng AI</th>
            </tr>
          </thead>
          <tbody>
            {entry.fields.map((f) => (
              <tr key={f.key}>
                <td>{f.label}</td>
                <td className="jp pre-line muted">{f.current || "(trống)"}</td>
                <td className="jp pre-line">{f.suggested}</td>
                <td>
                  <input type="checkbox" checked={entry.chosen.has(f.key)} onChange={() => onToggle(f.key)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
