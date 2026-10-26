import { useEffect, useState, type FormEvent } from "react";
import type { Db } from "../db/db";
import { createTopic, deleteTopic, listTopics, renameTopic, type Topic, type TopicResult } from "../topics/topics";

type Message = { kind: "ok" | "error"; text: string };

export default function TopicsPanel({ db }: { db: Db }) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<Message | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listTopics(db)
      .then((rows) => !cancelled && setTopics(rows))
      .catch((e: unknown) => !cancelled && setMessage({ kind: "error", text: `Lỗi khi tải chủ đề: ${String(e)}` }));
    return () => {
      cancelled = true;
    };
  }, [db, version]);

  const reload = () => setVersion((v) => v + 1);

  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      const result = await createTopic(db, name);
      setMessage(describe(result, "Đã tạo chủ đề."));
      if (result.status === "ok") {
        setName("");
        reload();
      }
    } catch (e) {
      setMessage({ kind: "error", text: `Lỗi khi tạo: ${String(e)}` });
    }
  }

  return (
    <div className="stack topics-panel">
      <form className="row" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên chủ đề mới" className="grow" />
        <button type="submit" className="primary">
          Tạo (Enter)
        </button>
      </form>
      {message && <p className={message.kind === "ok" ? "success" : "error"}>{message.text}</p>}
      {topics.length === 0 ? (
        <p className="muted">Chưa có chủ đề nào.</p>
      ) : (
        <ul className="word-list">
          {topics.map((t) => (
            <TopicRow key={t.id} db={db} topic={t} onChanged={reload} onMessage={setMessage} />
          ))}
        </ul>
      )}
      <p className="muted small">Xóa chủ đề không xóa từ. Gắn từ vào chủ đề ở mục Danh sách.</p>
    </div>
  );
}

function TopicRow({
  db,
  topic,
  onChanged,
  onMessage,
}: {
  db: Db;
  topic: Topic;
  onChanged: () => void;
  onMessage: (m: Message) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(topic.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function rename(event: FormEvent) {
    event.preventDefault();
    try {
      const result = await renameTopic(db, topic.id, name);
      onMessage(describe(result, "Đã đổi tên."));
      if (result.status === "ok") {
        setEditing(false);
        onChanged();
      }
    } catch (e) {
      onMessage({ kind: "error", text: `Lỗi khi đổi tên: ${String(e)}` });
    }
  }

  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await deleteTopic(db, topic.id);
      onMessage({ kind: "ok", text: `Đã xóa chủ đề "${topic.name}".` });
      onChanged();
    } catch (e) {
      onMessage({ kind: "error", text: `Lỗi khi xóa: ${String(e)}` });
    }
  }

  return (
    <li className="topic-row row">
      {editing ? (
        <form className="row grow" onSubmit={rename}>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="grow" />
          <button type="submit" className="primary">
            Lưu
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setName(topic.name);
            }}
          >
            Hủy
          </button>
        </form>
      ) : (
        <>
          <span className="grow">
            {topic.name} <span className="muted small">({topic.wordCount} từ)</span>
          </span>
          <button type="button" onClick={() => setEditing(true)}>
            Đổi tên
          </button>
          <button
            type="button"
            className={confirmDelete ? "danger" : ""}
            onClick={() => void remove()}
            onBlur={() => setConfirmDelete(false)}
          >
            {confirmDelete ? "Bấm lần nữa để xóa" : "Xóa"}
          </button>
        </>
      )}
    </li>
  );
}

function describe(result: TopicResult, okText: string): Message {
  if (result.status === "ok") return { kind: "ok", text: okText };
  if (result.status === "duplicate") return { kind: "error", text: "Đã có chủ đề cùng tên." };
  if (result.status === "invalid") return { kind: "error", text: result.message };
  return { kind: "error", text: "Chủ đề không còn tồn tại." };
}
