import { useEffect, useState } from "react";
import type { Db } from "../db/db";
import {
  listQuizHistory,
  saveQuizResult,
  startQuiz,
  type QuizAnswer,
  type QuizHistoryEntry,
  type Question,
} from "../quiz/quiz";
import { listTopics, type Topic } from "../topics/topics";

type Stage =
  | { kind: "setup" }
  | { kind: "playing"; questions: Question[]; topicNames: string[]; startedAt: Date }
  | { kind: "done"; answers: QuizAnswer[]; questions: Question[]; saveError: string | null };

export default function QuizPanel({ db }: { db: Db }) {
  const [stage, setStage] = useState<Stage>({ kind: "setup" });

  if (stage.kind === "playing") {
    return (
      <QuizRun
        questions={stage.questions}
        onFinish={async (answers) => {
          let saveError: string | null = null;
          try {
            await saveQuizResult(db, { topicNames: stage.topicNames, startedAt: stage.startedAt, answers });
          } catch (e) {
            saveError = String(e);
          }
          setStage({ kind: "done", answers, questions: stage.questions, saveError });
        }}
      />
    );
  }

  if (stage.kind === "done") {
    const correct = stage.answers.filter((a) => a.correct).length;
    const wrong = stage.questions.filter((q) => !stage.answers.find((a) => a.wordId === q.wordId)?.correct);
    return (
      <div className="stack quiz">
        <p className="success">
          Xong: đúng {correct}/{stage.answers.length}.
        </p>
        {stage.saveError && <p className="error">Không lưu được kết quả: {stage.saveError}</p>}
        {wrong.length > 0 && (
          <div className="card stack">
            <h2>Làm sai</h2>
            <ul>
              {wrong.map((q) => (
                <li key={q.wordId}>
                  <span className="jp">{q.term}</span>
                  {q.reading && <span className="jp muted"> ({q.reading})</span>}: {q.options[q.answerIndex]}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="row">
          <button className="primary" onClick={() => setStage({ kind: "setup" })}>
            Làm quiz khác
          </button>
        </div>
      </div>
    );
  }

  return (
    <QuizSetup
      db={db}
      onStart={(questions, topicNames) => setStage({ kind: "playing", questions, topicNames, startedAt: new Date() })}
    />
  );
}

function QuizSetup({ db, onStart }: { db: Db; onStart: (questions: Question[], topicNames: string[]) => void }) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [history, setHistory] = useState<QuizHistoryEntry[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listTopics(db), listQuizHistory(db)])
      .then(([t, h]) => {
        if (cancelled) return;
        setTopics(t);
        setHistory(h);
      })
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [db]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function start() {
    const ids = [...selected];
    try {
      const result = await startQuiz(db, ids);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onStart(result.questions, topics.filter((t) => selected.has(t.id)).map((t) => t.name));
    } catch (e) {
      setError(`Lỗi khi tạo quiz: ${String(e)}`);
    }
  }

  return (
    <div className="stack quiz">
      <p className="muted small">Chọn chủ đề rồi bắt đầu. Quiz không ảnh hưởng lịch ôn.</p>
      {topics.length === 0 ? (
        <p className="muted">Chưa có chủ đề nào. Tạo và gắn từ ở mục Chủ đề / Danh sách.</p>
      ) : (
        <div className="chips">
          {topics.map((t) => (
            <label key={t.id} className={selected.has(t.id) ? "chip active" : "chip"}>
              <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
              {t.name} <span className="muted small">({t.wordCount})</span>
            </label>
          ))}
        </div>
      )}
      <div className="row">
        <button className="primary" onClick={() => void start()} disabled={selected.size === 0}>
          Bắt đầu
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {history.length > 0 && (
        <div className="card stack">
          <h2>Lần làm gần đây</h2>
          <ul className="small">
            {history.map((h) => (
              <li key={h.id}>
                {new Date(h.finishedAt).toLocaleString("vi-VN")} · {h.topicNames.join(", ")} · đúng {h.correct}/{h.total}
                {h.wrongTerms.length > 0 && (
                  <span className="muted">
                    {" "}
                    · sai: <span className="jp">{h.wrongTerms.join("、")}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function QuizRun({ questions, onFinish }: { questions: Question[]; onFinish: (answers: QuizAnswer[]) => void }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<QuizAnswer[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const question = questions[index];

  function choose(option: number) {
    if (picked !== null) return;
    setPicked(option);
    setAnswers((a) => [
      ...a,
      { wordId: question.wordId, correct: option === question.answerIndex, chosen: question.options[option] },
    ]);
  }

  function next() {
    if (picked === null) return;
    if (index + 1 >= questions.length) {
      onFinish(answers);
      return;
    }
    setIndex(index + 1);
    setPicked(null);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.repeat) return;
      if (picked === null) {
        const n = Number.parseInt(event.key, 10) - 1;
        if (n >= 0 && n < question.options.length) choose(n);
      } else if (event.key === "Enter") {
        event.preventDefault();
        next();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="review-card stack quiz">
      <span className="muted small">
        Câu {index + 1}/{questions.length} · Nghĩa của từ này?
      </span>
      <div className="jp review-term">{question.term}</div>
      {picked !== null && question.reading && <div className="jp review-reading">{question.reading}</div>}
      <div className="quiz-options">
        {question.options.map((option, i) => {
          const state =
            picked === null ? "" : i === question.answerIndex ? "correct" : i === picked ? "wrong" : "";
          return (
            <button key={i} className={`quiz-option ${state}`} onClick={() => choose(i)} disabled={picked !== null}>
              <span className="muted">{i + 1}.</span> {option}
            </button>
          );
        })}
      </div>
      {picked !== null && (
        <button className="primary" onClick={next}>
          {index + 1 >= questions.length ? "Xem kết quả (Enter)" : "Câu tiếp (Enter)"}
        </button>
      )}
    </div>
  );
}
