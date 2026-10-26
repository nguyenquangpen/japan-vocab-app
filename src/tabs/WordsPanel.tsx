import { useEffect, useState, type FormEvent } from "react";
import type { Db } from "../db/db";
import {
  addWordsToTopic,
  getWordTopicIds,
  listTopics,
  removeWordFromTopic,
  type Topic,
} from "../topics/topics";
import {
  deleteWord,
  getWord,
  listWords,
  updateWord,
  type WordDetail,
  type WordStatus,
  type WordSummary,
} from "../vocab/vocab";

interface Props {
  db: Db;
  selectedId: number | null;
  onSelect: (wordId: number | null) => void;
}

export default function WordsPanel({ db, selectedId, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<WordStatus | "all">("all");
  const [topicFilter, setTopicFilter] = useState<number | "all">("all");
  const [topics, setTopics] = useState<Topic[]>([]);
  const [words, setWords] = useState<WordSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listWords(db, {
        query,
        status: status === "all" ? undefined : status,
        topicId: topicFilter === "all" ? undefined : topicFilter,
      }),
      listTopics(db),
    ])
      .then(([rows, topicRows]) => {
        if (cancelled) return;
        setWords(rows);
        setTopics(topicRows);
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(`Lỗi khi tải danh sách: ${String(e)}`));
    return () => {
      cancelled = true;
    };
  }, [db, query, status, topicFilter, version]);

  const reload = () => setVersion((v) => v + 1);

  return (
    <section className="library">
      <div className="library-list stack">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Tìm theo từ, cách đọc, nghĩa"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value as WordStatus | "all")}>
          <option value="all">Tất cả trạng thái</option>
          <option value="pending">Chờ bổ sung</option>
          <option value="learning">Đang học</option>
          <option value="mastered">Đã nhớ vững</option>
        </select>
        <select
          value={topicFilter}
          onChange={(e) => setTopicFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
        >
          <option value="all">Tất cả chủ đề</option>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.wordCount})
            </option>
          ))}
        </select>
        <p className="muted small">{words.length} từ</p>
        {words.length > 0 && topics.length > 0 && (
          <BulkTopicBar db={db} topics={topics} wordIds={words.map((w) => w.id)} onDone={reload} />
        )}
        {error && <p className="error">{error}</p>}
        <ul className="word-list">
          {words.map((w) => (
            <li key={w.id}>
              <button
                className={w.id === selectedId ? "word-item active" : "word-item"}
                onClick={() => onSelect(w.id)}
              >
                <span className="jp word-term">{w.term}</span>
                {w.reading && <span className="jp muted">{w.reading}</span>}
                <span className="word-meaning">{w.meanings[0] ?? ""}</span>
                {!w.enriched && <span className="badge">Chờ bổ sung</span>}
                {w.mastered && <span className="badge mastered">Vững</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="library-detail">
        {selectedId === null ? (
          <p className="muted">Chọn một từ để xem và sửa.</p>
        ) : (
          <WordEditor
            key={selectedId}
            db={db}
            wordId={selectedId}
            topics={topics}
            onSaved={reload}
            onDeleted={() => {
              onSelect(null);
              reload();
            }}
            onOpenWord={onSelect}
          />
        )}
      </div>
    </section>
  );
}

function BulkTopicBar({
  db,
  topics,
  wordIds,
  onDone,
}: {
  db: Db;
  topics: Topic[];
  wordIds: number[];
  onDone: () => void;
}) {
  const [topicId, setTopicId] = useState<number | "">("");
  const [message, setMessage] = useState<string | null>(null);

  async function attach() {
    if (topicId === "") return;
    try {
      const added = await addWordsToTopic(db, topicId, wordIds);
      const name = topics.find((t) => t.id === topicId)?.name ?? "";
      setMessage(`Đã gắn thêm ${added} từ vào "${name}".`);
      onDone();
    } catch (e) {
      setMessage(`Lỗi khi gắn chủ đề: ${String(e)}`);
    }
  }

  return (
    <div className="stack small">
      <div className="row">
        <select value={topicId} onChange={(e) => setTopicId(e.target.value === "" ? "" : Number(e.target.value))}>
          <option value="">Gắn các từ đang lọc vào…</option>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void attach()} disabled={topicId === ""}>
          Gắn {wordIds.length} từ
        </button>
      </div>
      {message && <span className="muted">{message}</span>}
    </div>
  );
}

function WordTopics({ db, wordId, topics, onChanged }: { db: Db; wordId: number; topics: Topic[]; onChanged: () => void }) {
  const [attached, setAttached] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWordTopicIds(db, wordId)
      .then((ids) => !cancelled && setAttached(new Set(ids)))
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [db, wordId]);

  async function toggle(topicId: number) {
    try {
      if (attached.has(topicId)) await removeWordFromTopic(db, wordId, topicId);
      else await addWordsToTopic(db, topicId, [wordId]);
      setAttached((prev) => {
        const next = new Set(prev);
        if (next.has(topicId)) next.delete(topicId);
        else next.add(topicId);
        return next;
      });
      onChanged();
    } catch (e) {
      setError(`Lỗi khi đổi chủ đề: ${String(e)}`);
    }
  }

  return (
    <div className="field">
      <span>Chủ đề</span>
      {topics.length === 0 ? (
        <p className="muted small">Chưa có chủ đề. Tạo ở mục Chủ đề.</p>
      ) : (
        <div className="chips">
          {topics.map((t) => (
            <label key={t.id} className={attached.has(t.id) ? "chip active" : "chip"}>
              <input type="checkbox" checked={attached.has(t.id)} onChange={() => void toggle(t.id)} />
              {t.name}
            </label>
          ))}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

interface EditorProps {
  db: Db;
  wordId: number;
  topics: Topic[];
  onSaved: () => void;
  onDeleted: () => void;
  onOpenWord: (wordId: number) => void;
}

type LoadState = { kind: "loading" } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "ready"; word: WordDetail };

function WordEditor({ db, wordId, topics, onSaved, onDeleted, onOpenWord }: EditorProps) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [form, setForm] = useState({ term: "", reading: "", meanings: "", partOfSpeech: "", usageNote: "", userNote: "" });
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string; duplicateId?: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getWord(db, wordId)
      .then((word) => {
        if (cancelled) return;
        if (!word) {
          setLoad({ kind: "missing" });
          return;
        }
        setLoad({ kind: "ready", word });
        setForm({
          term: word.term,
          reading: word.reading ?? "",
          meanings: word.meanings.join("\n"),
          partOfSpeech: word.partOfSpeech ?? "",
          usageNote: word.usageNote ?? "",
          userNote: word.userNote ?? "",
        });
      })
      .catch((e: unknown) => !cancelled && setLoad({ kind: "error", message: String(e) }));
    return () => {
      cancelled = true;
    };
  }, [db, wordId, loadVersion]);

  if (load.kind === "loading") return <p className="muted">Đang tải…</p>;
  if (load.kind === "missing") return <p className="muted">Từ này không còn trong kho.</p>;
  if (load.kind === "error") return <p className="error">Lỗi khi tải từ: {load.message}</p>;
  const { word } = load;

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      const result = await updateWord(db, wordId, { ...form, meanings: form.meanings.split("\n") });
      if (result.status === "updated") {
        setMessage({ kind: "ok", text: "Đã lưu." });
        setLoadVersion((v) => v + 1);
        onSaved();
      } else if (result.status === "duplicate") {
        setMessage({ kind: "error", text: "Đã có từ khác trùng chữ và cách đọc.", duplicateId: result.wordId });
      } else if (result.status === "invalid") {
        setMessage({ kind: "error", text: result.message });
      } else {
        setMessage({ kind: "error", text: "Từ này không còn trong kho." });
      }
    } catch (e) {
      setMessage({ kind: "error", text: `Lỗi khi lưu: ${String(e)}` });
    }
  }

  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await deleteWord(db, wordId);
      onDeleted();
    } catch (e) {
      setMessage({ kind: "error", text: `Lỗi khi xóa: ${String(e)}` });
    }
  }

  return (
    <form className="stack" onSubmit={save}>
      <div className="row">
        <span className="jp word-heading">{word.term}</span>
        {!word.enriched && <span className="badge">Chờ bổ sung</span>}
      </div>
      <div className="row">
        <label className="field grow">
          <span>Từ</span>
          <input className="jp" value={form.term} onChange={set("term")} />
        </label>
        <label className="field grow">
          <span>Cách đọc</span>
          <input className="jp" value={form.reading} onChange={set("reading")} />
        </label>
        <label className="field grow">
          <span>Từ loại</span>
          <input value={form.partOfSpeech} onChange={set("partOfSpeech")} />
        </label>
      </div>
      <label className="field">
        <span>Nghĩa (mỗi dòng một nghĩa)</span>
        <textarea rows={3} value={form.meanings} onChange={set("meanings")} />
      </label>
      <label className="field">
        <span>Cách dùng</span>
        <textarea rows={2} value={form.usageNote} onChange={set("usageNote")} />
      </label>
      <label className="field">
        <span>Ghi chú của tôi</span>
        <textarea rows={2} value={form.userNote} onChange={set("userNote")} />
      </label>

      <WordTopics db={db} wordId={wordId} topics={topics} onChanged={onSaved} />

      {word.examples.length > 0 && (
        <div className="field">
          <span>Ví dụ</span>
          <ul>
            {word.examples.map((ex) => (
              <li key={ex.id}>
                <span className="jp">{ex.ja}</span>
                {ex.reading && <span className="jp muted"> ({ex.reading})</span>}
                {ex.vi && <div className="muted">{ex.vi}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {word.confusables.length > 0 && (
        <div className="field">
          <span>Từ dễ nhầm</span>
          <ul>
            {word.confusables.map((c, i) => (
              <li key={i}>
                <span className="jp">{c.term}</span>: {c.note}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="row">
        <button type="submit" className="primary">
          Lưu
        </button>
        <button type="button" className={confirmDelete ? "danger" : ""} onClick={() => void remove()} onBlur={() => setConfirmDelete(false)}>
          {confirmDelete ? "Bấm lần nữa để xóa" : "Xóa từ"}
        </button>
        {message && <span className={message.kind === "ok" ? "success" : "error"}>{message.text}</span>}
        {message?.duplicateId !== undefined && (
          <button type="button" onClick={() => onOpenWord(message.duplicateId!)}>
            Mở từ đó
          </button>
        )}
      </div>
    </form>
  );
}
