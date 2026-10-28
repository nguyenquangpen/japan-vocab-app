import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Db } from "../db/db";
import { advanceQueue, getReviewOverview, loadSession, submitReview, type ReviewItem, type ReviewOverview } from "../review/review";
import { buildMistakesPrompt, type Mistake } from "../review/mistakesPrompt";
import { Rating, isReadingCorrect, romajiToKanaWhileTyping, type Grade } from "../review/scheduler";
import { loadSettings, type Settings } from "../settings/settings";

interface Props {
  db: Db;
}

interface Stats {
  reviewed: number;
  correct: number;
  mistakes: Mistake[];
}

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; settings: Settings };

const EMPTY_STATS: Stats = { reviewed: 0, correct: 0, mistakes: [] };

const GRADES: Record<2 | 4, { rating: Grade; label: string }[]> = {
  2: [
    { rating: Rating.Again, label: "Quên" },
    { rating: Rating.Good, label: "Nhớ" },
  ],
  4: [
    { rating: Rating.Again, label: "Quên" },
    { rating: Rating.Hard, label: "Khó" },
    { rating: Rating.Good, label: "Nhớ" },
    { rating: Rating.Easy, label: "Dễ" },
  ],
};

export default function ReviewTab({ db }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [queue, setQueue] = useState<ReviewItem[]>([]);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [sessionKey, setSessionKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const settings = await loadSettings(db);
      const items = await loadSession(db, settings);
      if (cancelled) return;
      setQueue(items);
      setStats(EMPTY_STATS);
      setLoad({ kind: "ready", settings });
    })().catch((e: unknown) => !cancelled && setLoad({ kind: "error", message: String(e) }));
    return () => {
      cancelled = true;
    };
  }, [db, sessionKey]);

  const record = useCallback((item: ReviewItem, correct: boolean, answer: string | null) => {
    setStats((s) => ({
      reviewed: s.reviewed + 1,
      correct: s.correct + (correct ? 1 : 0),
      mistakes: correct
        ? s.mistakes
        : [...s.mistakes, { term: item.term, reading: item.reading, meanings: item.meanings, skill: item.skill, answer }],
    }));
  }, []);

  if (load.kind === "loading") return <p className="muted">Đang tải phiên ôn…</p>;
  if (load.kind === "error") return <p className="error">Lỗi khi tải phiên ôn: {load.message}</p>;

  const current = queue[0];
  if (!current) {
    return (
      <SessionEnd
        db={db}
        stats={stats}
        level={load.settings.level}
        onReload={() => {
          setLoad({ kind: "loading" });
          setSessionKey((k) => k + 1);
        }}
      />
    );
  }

  const onGraded = (graded: ReviewItem) => setQueue((q) => advanceQueue(q, graded, new Date()));

  return (
    <section className="review stack">
      <SessionProgress done={stats.reviewed} remaining={queue.length} />
      {current.skill === "meaning" ? (
        <MeaningCard
          key={`${current.cardId}-${stats.reviewed}`}
          db={db}
          item={current}
          gradeButtons={load.settings.gradeButtons}
          onRecord={record}
          onGraded={onGraded}
        />
      ) : (
        <ReadingCard key={`${current.cardId}-${stats.reviewed}`} db={db} item={current} onRecord={record} onGraded={onGraded} />
      )}
    </section>
  );
}

interface CardProps {
  db: Db;
  item: ReviewItem;
  onRecord: (item: ReviewItem, correct: boolean, answer: string | null) => void;
  onGraded: (graded: ReviewItem) => void;
}

function MeaningCard({ db, item, gradeButtons, onRecord, onGraded }: CardProps & { gradeButtons: 2 | 4 }) {
  const [flipped, setFlipped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const grades = GRADES[gradeButtons];

  const grade = useCallback(
    async (rating: Grade) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const graded = await submitReview(db, item, rating, null, rating !== Rating.Again);
        onRecord(item, rating !== Rating.Again, null);
        onGraded(graded);
      } catch (e) {
        setError(`Lỗi khi lưu: ${String(e)}`);
        busy.current = false;
      }
    },
    [db, item, onRecord, onGraded],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.repeat) return;
      if (!flipped) {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          setFlipped(true);
        }
        return;
      }
      const index = Number.parseInt(event.key, 10) - 1;
      if (index >= 0 && index < grades.length) void grade(grades[index].rating);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flipped, grades, grade]);

  return (
    <div className="stack card-enter">
      <div className="flip-scene">
        <div
          className={flipped ? "flip-card flipped" : "flip-card"}
          onClick={() => setFlipped(true)}
          role="button"
          aria-label="Lật thẻ"
        >
          <div className="flip-face flip-front review-card stack">
            <span className="card-label">Nghĩa của từ này?</span>
            <TermWithKana item={item} />
            <span className="flip-hint">Bấm vào thẻ hoặc Space để lật</span>
          </div>
          <div className="flip-face flip-back review-card stack" aria-hidden={!flipped}>
            <TermWithKana item={item} small />
            <Answer item={item} showReading={false} />
          </div>
        </div>
      </div>
      {flipped && (
        <div className="row grade-row fade-in">
          {grades.map((g, i) => (
            <button
              key={g.rating}
              className={`grade-button grade-${g.rating}`}
              onClick={() => void grade(g.rating)}
            >
              <span className="grade-key">{i + 1}</span>
              {g.label}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function ReadingCard({ db, item, onRecord, onGraded }: CardProps) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<{ correct: boolean; graded: ReviewItem } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const expected = item.kanaOnly ? item.term : item.reading;

  async function check() {
    if (busy.current || input.trim() === "") return;
    busy.current = true;
    const correct = isReadingCorrect(input, expected);
    try {
      const graded = await submitReview(db, item, correct ? Rating.Good : Rating.Again, input, correct);
      onRecord(item, correct, input);
      setResult({ correct, graded });
    } catch (e) {
      setError(`Lỗi khi lưu: ${String(e)}`);
    } finally {
      busy.current = false;
    }
  }

  useEffect(() => {
    if (!result) return;
    function onKey(event: KeyboardEvent) {
      if (event.repeat || event.key !== "Enter") return;
      event.preventDefault();
      onGraded(result!.graded);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [result, onGraded]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    // Không để Enter này lan lên window (sẽ bị hiểu là "sang thẻ tiếp").
    event.stopPropagation();
    void check();
  }

  const verdict = result === null ? "" : result.correct ? "is-correct" : "is-wrong";

  return (
    <div className={`review-card stack card-enter ${verdict}`}>
      {item.kanaOnly ? (
        <>
          <span className="card-label">Gõ từ có nghĩa:</span>
          <div className="review-meanings">{item.meanings.join("; ")}</div>
        </>
      ) : (
        <>
          <span className="card-label">Cách đọc của từ này?</span>
          <div className="jp review-term">{item.term}</div>
        </>
      )}
      <input
        className={`jp review-input ${verdict}`}
        value={input}
        onChange={(e) => setInput(romajiToKanaWhileTyping(e.target.value))}
        onKeyDown={onKeyDown}
        disabled={result !== null}
        autoFocus
        placeholder="Gõ romaji hoặc kana rồi Enter"
      />
      {result && (
        <>
          <p className={`verdict ${result.correct ? "success" : "error"}`}>
            {result.correct ? "✓ Đúng!" : <>✗ Sai. Đáp án: <span className="jp">{expected}</span></>}
          </p>
          <Answer item={item} />
          <button className="primary" onClick={() => onGraded(result.graded)}>
            Tiếp (Enter)
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function SessionProgress({ done, remaining }: { done: number; remaining: number }) {
  const total = done + remaining;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="session-progress">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="muted small">
        Đã ôn {done} · còn {remaining} thẻ
      </span>
    </div>
  );
}

/** Chữ Hán to ở trên, kana nhỏ bên dưới (từ toàn kana thì không lặp lại). */
function TermWithKana({ item, small = false }: { item: ReviewItem; small?: boolean }) {
  return (
    <div className="term-block">
      <div className={`jp review-term${small ? " small-term" : ""}`}>{item.term}</div>
      {!item.kanaOnly && <div className="jp term-kana">{item.reading}</div>}
    </div>
  );
}

function Answer({ item, showReading = true }: { item: ReviewItem; showReading?: boolean }) {
  return (
    <div className="review-answer stack">
      {showReading && !item.kanaOnly && <div className="jp review-reading">{item.reading}</div>}
      <div className="review-meanings">{item.meanings.join("; ")}</div>
      {item.meaningDetail && <div className="meaning-detail pre-line">{item.meaningDetail}</div>}
      {item.example && (
        <div className="small">
          <div className="jp">{item.example.ja}</div>
          {item.example.vi && <div className="muted">{item.example.vi}</div>}
        </div>
      )}
    </div>
  );
}

function SessionEnd({ db, stats, level, onReload }: { db: Db; stats: Stats; level: string; onReload: () => void }) {
  const [overview, setOverview] = useState<ReviewOverview | null>(null);
  const [copyMessage, setCopyMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function copyMistakesPrompt() {
    try {
      await writeText(buildMistakesPrompt(stats.mistakes, level));
      setCopyMessage({ kind: "ok", text: "Đã copy. Dán vào ChatGPT để đọc giải thích." });
    } catch (e) {
      setCopyMessage({ kind: "error", text: `Không copy được: ${String(e)}` });
    }
  }

  useEffect(() => {
    let cancelled = false;
    getReviewOverview(db)
      .then((o) => !cancelled && setOverview(o))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [db]);

  return (
    <section className="stack session-end card-enter">
      <h1>Ôn tập</h1>
      {stats.reviewed === 0 ? (
        <div className="empty-state">
          <div className="empty-mark jp">休</div>
          <p>Không có thẻ nào cần ôn lúc này.</p>
        </div>
      ) : (
        <>
          <p className="session-title">Hết phiên! 🎉</p>
          <div className="stat-tiles">
            <StatTile label="Lượt ôn" value={stats.reviewed} />
            <StatTile label="Đúng" value={stats.correct} tone="good" />
            <StatTile label="Sai" value={stats.reviewed - stats.correct} tone="bad" />
            <StatTile label="Tỉ lệ đúng" value={`${Math.round((stats.correct / stats.reviewed) * 100)}%`} />
          </div>
        </>
      )}
      {stats.mistakes.length > 0 && (
        <div className="card stack">
          <h2>Trả lời sai</h2>
          <ul>
            {stats.mistakes.map((m, i) => (
              <li key={i}>
                <span className="jp">{m.term}</span> (<span className="jp">{m.reading}</span>): {m.meanings.join("; ")}
                {m.answer && (
                  <span className="muted">
                    {" "}
                    — bạn gõ <span className="jp">{m.answer}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="row">
            <button className="primary" onClick={() => void copyMistakesPrompt()}>
              Copy prompt giải thích lỗi sai
            </button>
            {copyMessage && <span className={copyMessage.kind === "ok" ? "success" : "error"}>{copyMessage.text}</span>}
          </div>
        </div>
      )}
      {overview?.nextDue && <p className="muted small">Thẻ đến hạn gần nhất: {new Date(overview.nextDue).toLocaleString("vi-VN")}</p>}
      {overview && overview.notReady > 0 && (
        <p className="muted small">
          {overview.notReady} từ chưa có đủ cách đọc và nghĩa nên chưa vào ôn. Bổ sung ở tab Thêm từ hoặc Kho từ.
        </p>
      )}
      <div className="row">
        <button onClick={onReload}>Tải lại phiên ôn</button>
      </div>
    </section>
  );
}

function StatTile({ label, value, tone }: { label: string; value: number | string; tone?: "good" | "bad" }) {
  return (
    <div className={`stat-tile ${tone ?? ""}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
