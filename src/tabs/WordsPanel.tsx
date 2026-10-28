import { useEffect, useState, type FormEvent } from "react";
import type { Db } from "../db/db";
import {
  addWordsToTopic,
  getWordTopicIds,
  listTopics,
  removeWordFromTopic,
  removeWordsFromTopic,
  type Topic,
} from "../topics/topics";
import {
  deleteWord,
  getWord,
  listWords,
  updateWord,
  type WordDetail,
  type WordSort,
  type WordStatus,
  type WordSummary,
} from "../vocab/vocab";

interface Props {
  db: Db;
  selectedId: number | null;
  onSelect: (wordId: number | null) => void;
}

const SORTS: { id: WordSort; label: string }[] = [
  { id: "newest", label: "Mới thêm nhất" },
  { id: "oldest", label: "Cũ nhất" },
  { id: "kana", label: "Theo kana (あ→ん)" },
  { id: "due", label: "Sắp đến hạn ôn" },
  { id: "mistakes", label: "Sai nhiều nhất" },
];

export default function WordsPanel({ db, selectedId, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<WordStatus | "all">("all");
  const [topicFilter, setTopicFilter] = useState<number | "all" | "none">("all");
  const [sort, setSort] = useState<WordSort>("newest");
  const [topics, setTopics] = useState<Topic[]>([]);
  const [words, setWords] = useState<WordSummary[]>([]);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listWords(db, {
        query,
        status: status === "all" ? undefined : status,
        topicId: topicFilter === "all" ? undefined : topicFilter,
        sort,
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
  }, [db, query, status, topicFilter, sort, version]);

  const reload = () => setVersion((v) => v + 1);

  // Chỉ tính các từ đã tick còn nằm trong danh sách đang lọc.
  const checkedIds = words.filter((w) => checked.has(w.id)).map((w) => w.id);
  const allChecked = words.length > 0 && checkedIds.length === words.length;

  function toggle(id: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="library">
      <div className="library-list stack">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Tìm theo từ, cách đọc, nghĩa"
        />
        <div className="filter-grid">
          <select value={status} onChange={(e) => setStatus(e.target.value as WordStatus | "all")}>
            <option value="all">Tất cả trạng thái</option>
            <option value="pending">Chờ bổ sung</option>
            <option value="learning">Đang học</option>
            <option value="mastered">Đã nhớ vững</option>
          </select>
          <select
            value={topicFilter}
            onChange={(e) => {
              const v = e.target.value;
              setTopicFilter(v === "all" || v === "none" ? v : Number(v));
            }}
          >
            <option value="all">Tất cả chủ đề</option>
            <option value="none">Không có chủ đề</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.wordCount})
              </option>
            ))}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as WordSort)} className="span-2">
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                Sắp xếp: {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row small">
          <label className="row">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={() => setChecked(allChecked ? new Set() : new Set(words.map((w) => w.id)))}
              disabled={words.length === 0}
            />
            Chọn tất cả
          </label>
          <span className="muted">
            {words.length} từ{checkedIds.length > 0 ? ` · đã chọn ${checkedIds.length}` : ""}
          </span>
        </div>
        {checkedIds.length > 0 && (
          <BulkTopicBar
            db={db}
            topics={topics}
            wordIds={checkedIds}
            onDone={reload}
            onClear={() => setChecked(new Set())}
          />
        )}
        {error && <p className="error">{error}</p>}
        <ul className="word-list">
          {words.map((w) => (
            <li key={w.id} className={checked.has(w.id) ? "word-row checked" : "word-row"}>
              <input
                type="checkbox"
                className="word-check"
                checked={checked.has(w.id)}
                onChange={() => toggle(w.id)}
                aria-label={`Chọn ${w.term}`}
              />
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
  onClear,
}: {
  db: Db;
  topics: Topic[];
  wordIds: number[];
  onDone: () => void;
  onClear: () => void;
}) {
  const [topicId, setTopicId] = useState<number | "">("");
  const [message, setMessage] = useState<string | null>(null);
  const name = topics.find((t) => t.id === topicId)?.name ?? "";

  async function run(action: "add" | "remove") {
    if (topicId === "") return;
    try {
      if (action === "add") {
        const n = await addWordsToTopic(db, topicId, wordIds);
        setMessage(`Đã gắn thêm ${n} từ vào "${name}".`);
      } else {
        const n = await removeWordsFromTopic(db, topicId, wordIds);
        setMessage(`Đã gỡ ${n} từ khỏi "${name}".`);
      }
      onDone();
    } catch (e) {
      setMessage(`Lỗi khi đổi chủ đề: ${String(e)}`);
    }
  }

  return (
    <div className="bulk-bar stack small fade-in">
      {topics.length === 0 ? (
        <span className="muted">Chưa có chủ đề. Tạo ở mục Chủ đề.</span>
      ) : (
        <div className="row">
          <select value={topicId} onChange={(e) => setTopicId(e.target.value === "" ? "" : Number(e.target.value))}>
            <option value="">Chọn chủ đề…</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button type="button" className="primary" onClick={() => void run("add")} disabled={topicId === ""}>
            Gắn {wordIds.length} từ
          </button>
          <button type="button" onClick={() => void run("remove")} disabled={topicId === ""}>
            Gỡ
          </button>
          <button type="button" onClick={onClear}>
            Bỏ chọn
          </button>
        </div>
      )}
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
  const [form, setForm] = useState({
    term: "",
    reading: "",
    meanings: "",
    meaningDetail: "",
    partOfSpeech: "",
    usageNote: "",
    userNote: "",
  });
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
          meaningDetail: word.meaningDetail ?? "",
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
          <span>Chữ Hán (漢字)</span>
          <input className="jp" value={form.term} onChange={set("term")} />
        </label>
        <label className="field grow">
          <span>Kana (かな)</span>
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
        <span>Nghĩa mở rộng (tự ghi, hiện ở mặt sau flashcard)</span>
        <textarea
          rows={3}
          value={form.meaningDetail}
          onChange={set("meaningDetail")}
          placeholder="Giải thích thêm, sắc thái, mẹo nhớ…"
        />
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
