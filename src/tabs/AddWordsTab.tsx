import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Db } from "../db/db";
import { addWordsToTopic, listTopics, type Topic } from "../topics/topics";
import { addWord, addWordsBatch, type BatchResult } from "../vocab/vocab";
import EnrichPanel from "./EnrichPanel";

interface Props {
  db: Db;
  onOpenWord: (wordId: number) => void;
}

export default function AddWordsTab({ db, onOpenWord }: Props) {
  const [version, setVersion] = useState(0);
  const onAdded = () => setVersion((v) => v + 1);

  return (
    <section className="stack">
      <h1>Thêm từ</h1>
      <SingleWordForm db={db} onOpenWord={onOpenWord} onAdded={onAdded} />
      <BatchForm db={db} onAdded={onAdded} />
      <EnrichPanel db={db} version={version} />
    </section>
  );
}

function SingleWordForm({ db, onOpenWord, onAdded }: Props & { onAdded: () => void }) {
  const [term, setTerm] = useState("");
  const [reading, setReading] = useState("");
  const [meanings, setMeanings] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const termRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const result = await addWord(db, { term, reading, meanings });
      if (result.status === "invalid") {
        setMessage({ kind: "error", text: result.message });
        return;
      }
      if (result.status === "duplicate") {
        onOpenWord(result.wordId);
        return;
      }
      setMessage({ kind: "ok", text: `Đã thêm ${term.trim()}` });
      onAdded();
      setTerm("");
      setReading("");
      setMeanings("");
      termRef.current?.focus();
    } catch (error) {
      setMessage({ kind: "error", text: `Lỗi khi lưu: ${String(error)}` });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Từng từ</h2>
      <div className="row">
        <label className="field grow">
          <span>Từ</span>
          <input
            ref={termRef}
            className="jp"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            autoFocus
            placeholder="食べる"
          />
        </label>
        <label className="field grow">
          <span>Cách đọc (tùy chọn)</span>
          <input className="jp" value={reading} onChange={(e) => setReading(e.target.value)} placeholder="たべる" />
        </label>
        <label className="field grow">
          <span>Nghĩa (tùy chọn, ngăn bởi dấu phẩy)</span>
          <input value={meanings} onChange={(e) => setMeanings(e.target.value)} placeholder="ăn, dùng bữa" />
        </label>
      </div>
      <div className="row">
        <button type="submit" className="primary" disabled={saving}>
          Lưu (Enter)
        </button>
        {message && <span className={message.kind === "ok" ? "success" : "error"}>{message.text}</span>}
      </div>
      <p className="muted small">Nếu từ đã có trong kho, app mở từ cũ ở tab Kho từ.</p>
    </form>
  );
}

function BatchForm({ db, onAdded }: { db: Db; onAdded: () => void }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<BatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicIds, setTopicIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    listTopics(db)
      .then((rows) => !cancelled && setTopics(rows))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [db]);

  function toggleTopic(id: number) {
    setTopicIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (saving || text.trim() === "") return;
    setSaving(true);
    setError(null);
    try {
      const batch = await addWordsBatch(db, text);
      // Chủ đề áp cho cả từ mới lẫn từ đã có trong lô.
      const wordIds = [...batch.added, ...batch.duplicates].map((w) => w.wordId);
      for (const topicId of topicIds) await addWordsToTopic(db, topicId, wordIds);
      setResult(batch);
      if (batch.added.length > 0) onAdded();
      // Giữ lại các dòng lỗi để sửa tiếp.
      setText(batch.invalid.map((i) => i.line).join("\n"));
    } catch (e) {
      setError(`Lỗi khi lưu: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="card stack">
      <h2>Hàng loạt</h2>
      <p className="muted small">
        Mỗi dòng một từ: <code>từ</code>, <code>từ cách_đọc</code> hoặc <code>từ | cách đọc | nghĩa</code>.
      </p>
      <textarea
        className="jp"
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={"食べる たべる\n飲む | のむ | uống\n水"}
      />
      {topics.length > 0 && (
        <div className="field">
          <span>Gắn cả lô vào chủ đề (tùy chọn)</span>
          <div className="chips">
            {topics.map((t) => (
              <label key={t.id} className={topicIds.has(t.id) ? "chip active" : "chip"}>
                <input type="checkbox" checked={topicIds.has(t.id)} onChange={() => toggleTopic(t.id)} />
                {t.name}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="row">
        <button className="primary" onClick={() => void submit()} disabled={saving}>
          Thêm tất cả (Ctrl+Enter)
        </button>
        {error && <span className="error">{error}</span>}
      </div>
      {result && <BatchSummary result={result} />}
    </div>
  );
}

function BatchSummary({ result }: { result: BatchResult }) {
  return (
    <div className="stack small">
      <p className="success">Đã thêm {result.added.length} từ.</p>
      {result.duplicates.length > 0 && (
        <p className="muted">
          Bỏ qua {result.duplicates.length} từ đã có: <span className="jp">{result.duplicates.map((d) => d.term).join("、")}</span>
        </p>
      )}
      {result.invalid.length > 0 && (
        <div>
          <p className="error">{result.invalid.length} dòng lỗi (đã để lại trong ô để sửa):</p>
          <ul>
            {result.invalid.map((i) => (
              <li key={i.lineNo}>
                Dòng {i.lineNo}: <span className="jp">{i.line}</span> — {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
