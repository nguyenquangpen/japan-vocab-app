import { useState } from "react";
import type { Db } from "../db/db";
import QuizPanel from "./QuizPanel";
import TopicsPanel from "./TopicsPanel";
import WordsPanel from "./WordsPanel";

interface Props {
  db: Db;
  selectedId: number | null;
  onSelect: (wordId: number | null) => void;
}

const VIEWS = [
  { id: "words", label: "Danh sách" },
  { id: "topics", label: "Chủ đề" },
  { id: "quiz", label: "Quiz" },
] as const;

type View = (typeof VIEWS)[number]["id"];

export default function LibraryTab({ db, selectedId, onSelect }: Props) {
  const [view, setView] = useState<View>("words");

  return (
    <section className="library-tab stack">
      <div className="row">
        <h1>Kho từ</h1>
        <div className="segmented">
          {VIEWS.map((v) => (
            <button key={v.id} className={v.id === view ? "active" : ""} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
      </div>
      {view === "words" && <WordsPanel db={db} selectedId={selectedId} onSelect={onSelect} />}
      {view === "topics" && <TopicsPanel db={db} />}
      {view === "quiz" && <QuizPanel db={db} />}
    </section>
  );
}
