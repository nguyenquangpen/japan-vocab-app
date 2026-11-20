import { useEffect, useRef, useState } from "react";
import type { Db } from "../db/db";
import { reportLessonCompleted } from "../hub/events";
import type { HubSender } from "../hub/sender";
import { DEFAULT_MASCOT, type MascotId } from "../mascot/mascot";
import {
  buildChoiceQuestions,
  buildClozeQuestions,
  buildKanaMatchRound,
  buildMatchRound,
  clozeFromExamples,
  dedupeCloze,
  kanaMatchWords,
  orderPiecesCheck,
  shufflePieces,
  type ChoiceQuestion,
  type ClozeQuestion,
  type MatchRound,
} from "../practice/exercises";
import type { ClozeItem, OrderItem } from "../practice/types";
import { loadPracticePool, shuffle, type ReviewItem, type ReviewScope } from "../review/review";
import { loadSettings } from "../settings/settings";
import { listTopics, type Topic } from "../topics/topics";
import GeneratePanel from "./GeneratePanel";
import MascotToast from "./MascotToast";

/**
 * Tab Luyện tập: bài tập theo phạm vi từ (nối từ, nối kana, chọn từ, điền từ, xếp câu).
 * Chỉ đọc dữ liệu — không gọi submitReview, không ghi cards / review_logs, không đổi lịch ôn.
 */

/** Nguồn câu điền / câu xếp đã tạo sẵn (bảng practice_items, do phần tạo bằng ChatGPT cung cấp). */
export interface GeneratedSource {
  loadCloze(db: Db, wordIds: number[]): Promise<ClozeItem[]>;
  loadOrder(db: Db, wordIds: number[]): Promise<OrderItem[]>;
}

/** Số từ tối thiểu cho các bài có 4 lựa chọn / bài nối. */
const MIN_WORDS = 4;
const MATCH_SIZE = 5;
const MATCH_ROUNDS = 2;
const QUESTION_COUNT = 10;

type ScopeKind = ReviewScope["kind"];
type ExerciseKind = "match" | "kana" | "choice" | "cloze" | "order";

interface Mistake {
  prompt: string;
  answer: string;
  chosen: string;
}

interface Result {
  exercise: ExerciseKind;
  total: number;
  correct: number;
  mistakes: Mistake[];
}

type Stage =
  | { kind: "setup" }
  | { kind: "match"; exercise: "match" | "kana"; rounds: MatchRound[] }
  | { kind: "choice"; exercise: "choice" | "cloze"; questions: (ChoiceQuestion | ClozeQuestion)[] }
  | { kind: "order"; items: OrderItem[]; shuffled: string[][] }
  | { kind: "done"; result: Result };

const TITLES: Record<ExerciseKind, string> = {
  match: "🔗 Nối từ",
  kana: "🈁 Nối chữ Hán ↔ kana",
  choice: "🇻🇳→🇯🇵 Chọn từ đúng",
  cloze: "✏️ Điền từ vào câu",
  order: "🧩 Xếp câu",
};

interface PoolData {
  words: ReviewItem[];
  cloze: ClozeItem[];
  order: OrderItem[];
}

export default function PracticeTab({
  db,
  generated,
  hub = null,
}: {
  db: Db;
  generated?: GeneratedSource;
  /** Bộ gửi sự kiện sang Hub (null nếu chưa sẵn sàng / trong test). */
  hub?: HubSender | null;
}) {
  // Lần làm bài hiện tại (mã + lúc bắt đầu) để báo Hub khi xong; chỉ đọc trong handler.
  const runStart = useRef<{ id: string; at: Date } | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [mascot, setMascot] = useState<MascotId>(DEFAULT_MASCOT);
  const [level, setLevel] = useState("N5");
  // Tăng sau khi lưu câu ChatGPT để tải lại dữ liệu bài tập.
  const [reloadKey, setReloadKey] = useState(0);
  const [kind, setKind] = useState<ScopeKind>("all");
  const [topicIds, setTopicIds] = useState<Set<number>>(new Set());
  // Dữ liệu đã tải kèm khóa phạm vi; khác phạm vi hiện tại thì coi như chưa có (tránh dùng từ của phạm vi cũ).
  const [loaded, setLoaded] = useState<{ key: string; value: PoolData } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "setup" });
  const [toast, setToast] = useState<{ remembered: number; total: number; id: number } | null>(null);

  const topicKey = [...topicIds].sort((a, b) => a - b).join(",");
  const noTopicPicked = kind === "topics" && topicIds.size === 0;
  const dataKey = `${kind}|${topicKey}|${reloadKey}`;
  const data = loaded?.key === dataKey ? loaded.value : null;
  // Cùng phạm vi (có thể đang tải lại sau khi lưu câu ChatGPT).
  const sameScope = loaded?.key.startsWith(`${kind}|${topicKey}|`) ? loaded.value : null;

  useEffect(() => {
    let cancelled = false;
    Promise.all([listTopics(db), loadSettings(db)])
      .then(([t, s]) => {
        if (cancelled) return;
        setTopics(t);
        setMascot(s.mascot);
        setLevel(s.level);
      })
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [db]);

  useEffect(() => {
    let cancelled = false;
    const ids = topicKey === "" ? [] : topicKey.split(",").map(Number);
    const scope: ReviewScope = kind === "topics" ? { kind, topicIds: ids } : { kind };
    (async () => {
      const words = await loadPracticePool(db, { scope });
      const wordIds = words.map((w) => w.wordId);
      const [genCloze, order] = generated
        ? await Promise.all([generated.loadCloze(db, wordIds), generated.loadOrder(db, wordIds)])
        : [[], []];
      const cloze = dedupeCloze([...genCloze, ...clozeFromExamples(words)]);
      if (cancelled) return;
      setLoaded({ key: `${kind}|${topicKey}|${reloadKey}`, value: { words, cloze, order } });
      setError(null);
    })().catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [db, generated, kind, topicKey, reloadKey]);

  function toggleTopic(id: number) {
    setTopicIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function start(exercise: ExerciseKind) {
    if (!data) return;
    runStart.current = { id: crypto.randomUUID(), at: new Date() };
    const { words } = data;
    if (exercise === "match" || exercise === "kana") {
      const source = exercise === "kana" ? kanaMatchWords(words) : words;
      const build = exercise === "kana" ? buildKanaMatchRound : buildMatchRound;
      const rounds: MatchRound[] = [];
      let remaining = shuffle(source);
      for (let i = 0; i < MATCH_ROUNDS; i++) {
        // Vòng sau ưu tiên từ chưa gặp; thiếu thì dùng lại cả phạm vi.
        if (remaining.length < 3) {
          if (i > 0) break;
          remaining = source;
        }
        const round = build(remaining, MATCH_SIZE);
        if (round.left.length === 0) break;
        rounds.push(round);
        const used = new Set(round.left.map((c) => c.key));
        remaining = remaining.filter((w) => !used.has(w.wordId));
      }
      setStage({ kind: "match", exercise, rounds });
    } else if (exercise === "choice") {
      setStage({ kind: "choice", exercise, questions: buildChoiceQuestions(words, QUESTION_COUNT) });
    } else if (exercise === "cloze") {
      setStage({ kind: "choice", exercise, questions: buildClozeQuestions(data.cloze, words, QUESTION_COUNT) });
    } else {
      const items = shuffle(data.order).slice(0, QUESTION_COUNT);
      setStage({ kind: "order", items, shuffled: items.map((i) => shufflePieces(i.pieces)) });
    }
  }

  function finish(result: Result) {
    setStage({ kind: "done", result });
    setToast({ remembered: result.correct, total: result.total, id: Date.now() });
    // Báo Hub "xong một bài" (chạy nền; lỗi không ảnh hưởng bài tập). Mỗi lần làm là 1 bài mới.
    const run = runStart.current;
    runStart.current = null;
    if (run && result.total > 0) {
      const endedAt = new Date();
      void reportLessonCompleted(db, {
        lessonId: `practice-${run.id}`,
        title: `Luyện tập: ${TITLES[result.exercise].replace(/^\S+\s/, "")}`,
        durationMinutes: Math.max(1, Math.round((endedAt.getTime() - run.at.getTime()) / 60_000)),
        score: Math.round((result.correct / result.total) * 100),
        occurredAt: endedAt,
      })
        .then(() => hub?.kick())
        .catch(() => {});
    }
  }

  const toastEl = toast && (
    <MascotToast
      key={toast.id}
      mascot={mascot}
      remembered={toast.remembered}
      total={toast.total}
      onClose={() => setToast(null)}
    />
  );

  if (stage.kind === "match") {
    return (
      <MatchRun
        key={`${stage.exercise}-${stage.rounds.length}`}
        exercise={stage.exercise}
        rounds={stage.rounds}
        onFinish={finish}
        onQuit={() => setStage({ kind: "setup" })}
      />
    );
  }
  if (stage.kind === "choice") {
    return (
      <ChoiceRun
        exercise={stage.exercise}
        questions={stage.questions}
        onFinish={finish}
        onQuit={() => setStage({ kind: "setup" })}
      />
    );
  }
  if (stage.kind === "order") {
    return (
      <OrderRun
        items={stage.items}
        shuffled={stage.shuffled}
        onFinish={finish}
        onQuit={() => setStage({ kind: "setup" })}
      />
    );
  }
  if (stage.kind === "done") {
    const { result } = stage;
    return (
      <div className="stack practice card-enter">
        <p className="session-title">Xong bài {TITLES[result.exercise]}!</p>
        <div className="stat-tiles">
          <div className="stat-tile">
            <span className="stat-value">{result.total}</span>
            <span className="stat-label">Câu</span>
          </div>
          <div className="stat-tile good">
            <span className="stat-value">{result.correct}</span>
            <span className="stat-label">Đúng ngay</span>
          </div>
          <div className="stat-tile bad">
            <span className="stat-value">{result.mistakes.length}</span>
            <span className="stat-label">Lần sai</span>
          </div>
        </div>
        {result.mistakes.length > 0 && (
          <div className="card stack">
            <h2>Chỗ sai</h2>
            <ul className="practice-mistakes">
              {result.mistakes.map((m, i) => (
                <li key={i}>
                  <span className="jp">{m.prompt}</span> → đúng: <strong className="jp">{m.answer}</strong>
                  <span className="muted">
                    {" "}
                    (bạn chọn: <span className="jp">{m.chosen}</span>)
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="row">
          <button className="primary" onClick={() => start(result.exercise)}>
            Làm lại
          </button>
          <button onClick={() => setStage({ kind: "setup" })}>Chọn bài khác</button>
        </div>
        {toastEl}
      </div>
    );
  }

  const words = data?.words ?? [];
  const termCount = new Set(words.map((w) => w.term)).size;
  const kanaCount = kanaMatchWords(words).length;
  const needWords = `Cần ít nhất ${MIN_WORDS} từ`;
  const exercises: { id: ExerciseKind; reason: string | null; hint: string }[] = [
    { id: "match", reason: words.length < MIN_WORDS ? needWords : null, hint: "Nối từ với nghĩa" },
    {
      id: "kana",
      reason: kanaCount < MIN_WORDS ? `Cần ít nhất ${MIN_WORDS} từ có chữ Hán và cách đọc` : null,
      hint: "Nối chữ Hán với cách đọc",
    },
    { id: "choice", reason: termCount < MIN_WORDS ? needWords : null, hint: "Đọc nghĩa, chọn từ tiếng Nhật" },
    {
      id: "cloze",
      reason: termCount < MIN_WORDS ? needWords : (data?.cloze.length ?? 0) === 0 ? "Chưa có câu nào chứa từ" : null,
      hint: `${data?.cloze.length ?? 0} câu`,
    },
    {
      id: "order",
      reason: (data?.order.length ?? 0) === 0 ? "Chưa có câu xếp — tạo bằng ChatGPT ở mục bên dưới" : null,
      hint: `${data?.order.length ?? 0} câu`,
    },
  ];

  return (
    <div className="stack practice">
      <p className="muted small">Luyện tập không ảnh hưởng lịch ôn.</p>
      <div className="card stack">
        <h2>Phạm vi</h2>
        <div className="scope-options">
          {(
            [
              ["all", "📚 Tất cả từ"],
              ["topics", "🏷️ Theo chủ đề"],
              ["noTopic", "📭 Từ chưa có chủ đề"],
            ] as [ScopeKind, string][]
          ).map(([k, text]) => (
            <label key={k} className={kind === k ? "scope-option active" : "scope-option"}>
              <input type="radio" name="practice-scope" checked={kind === k} onChange={() => setKind(k)} />
              {text}
            </label>
          ))}
        </div>
        {kind === "topics" &&
          (topics.length === 0 ? (
            <p className="muted small">Chưa có chủ đề nào. Tạo ở Kho từ → Chủ đề.</p>
          ) : (
            <div className="chips fade-in">
              {topics.map((t) => (
                <label key={t.id} className={topicIds.has(t.id) ? "chip active" : "chip"}>
                  <input type="checkbox" checked={topicIds.has(t.id)} onChange={() => toggleTopic(t.id)} />
                  {t.name} <span className="muted small">({t.wordCount})</span>
                </label>
              ))}
            </div>
          ))}
        {noTopicPicked ? (
          <p className="muted small">Chọn ít nhất 1 chủ đề.</p>
        ) : data === null ? (
          <p className="muted small">Đang đếm…</p>
        ) : (
          <p className="muted small practice-count">{words.length} từ có nghĩa trong phạm vi</p>
        )}
      </div>

      <div className="card stack">
        <div className="setup-actions practice-actions">
          {exercises.map((e) => (
            <button
              key={e.id}
              className="setup-action"
              onClick={() => start(e.id)}
              disabled={data === null || noTopicPicked || e.reason !== null}
            >
              <strong>{TITLES[e.id]}</strong>
              <span>{e.reason ?? e.hint}</span>
            </button>
          ))}
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      {/* Giữ khung ChatGPT khi chỉ tải lại sau khi lưu (cùng phạm vi) để không mất thông báo "Đã lưu". */}
      {generated && sameScope && !noTopicPicked && (
        <GeneratePanel
          db={db}
          words={sameScope.words}
          generatedWordIds={
            new Set([...sameScope.cloze.filter((c) => c.id > 0), ...sameScope.order].map((i) => i.wordId))
          }
          level={level}
          onSaved={() => setReloadKey((k) => k + 1)}
        />
      )}
    </div>
  );
}

function RunHeader({ exercise, label, onQuit }: { exercise: ExerciseKind; label: string; onQuit: () => void }) {
  return (
    <div className="row">
      <span className="card-label">
        {TITLES[exercise]} · {label}
      </span>
      <button className="push-right" onClick={onQuit}>
        ← Chọn bài khác
      </button>
    </div>
  );
}

function MatchRun({
  exercise,
  rounds,
  onFinish,
  onQuit,
}: {
  exercise: "match" | "kana";
  rounds: MatchRound[];
  onFinish: (r: Result) => void;
  onQuit: () => void;
}) {
  const [roundIndex, setRoundIndex] = useState(0);
  const [selected, setSelected] = useState<{ side: "left" | "right"; key: number } | null>(null);
  const [matched, setMatched] = useState<Set<number>>(new Set());
  const [wrong, setWrong] = useState<{ side: "left" | "right"; key: number; n: number } | null>(null);
  const [missedKeys, setMissedKeys] = useState<Set<string>>(new Set());
  const [mistakes, setMistakes] = useState<Mistake[]>([]);
  const round = rounds[roundIndex];
  const total = rounds.reduce((s, r) => s + r.left.length, 0);
  const roundDone = matched.size === round.left.length;

  useEffect(() => {
    if (!wrong) return;
    const timer = window.setTimeout(() => setWrong(null), 500);
    return () => window.clearTimeout(timer);
  }, [wrong]);

  function textOf(side: "left" | "right", key: number) {
    return round[side].find((c) => c.key === key)?.text ?? "";
  }

  function click(side: "left" | "right", key: number) {
    if (matched.has(key)) return;
    if (!selected || selected.side === side) {
      setSelected({ side, key });
      return;
    }
    const leftKey = side === "left" ? key : selected.key;
    const rightKey = side === "right" ? key : selected.key;
    setSelected(null);
    if (leftKey === rightKey) {
      setMatched((m) => new Set(m).add(key));
      return;
    }
    setWrong({ side, key, n: mistakes.length + 1 });
    setMissedKeys((s) => new Set(s).add(`${roundIndex}:${leftKey}`));
    setMistakes((m) => [
      ...m,
      { prompt: textOf("left", leftKey), answer: textOf("right", leftKey), chosen: textOf("right", rightKey) },
    ]);
  }

  function next() {
    if (roundIndex + 1 >= rounds.length) {
      onFinish({ exercise, total, correct: total - missedKeys.size, mistakes });
      return;
    }
    setRoundIndex(roundIndex + 1);
    setMatched(new Set());
    setSelected(null);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Enter" && roundDone && !event.repeat) {
        event.preventDefault();
        next();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const column = (side: "left" | "right") => (
    <div className="match-column">
      {round[side].map((c) => {
        const cls = matched.has(c.key)
          ? "correct"
          : wrong && wrong.side === side && wrong.key === c.key
            ? "wrong"
            : selected?.side === side && selected.key === c.key
              ? "selected"
              : "";
        return (
          <button
            key={`${c.key}-${cls === "wrong" ? wrong?.n : ""}`}
            className={`match-item ${cls} ${side === "left" || exercise === "kana" ? "jp" : ""}`}
            onClick={() => click(side, c.key)}
            disabled={matched.has(c.key)}
            aria-pressed={cls === "selected"}
          >
            <span className="match-text">{c.text}</span>
            {c.sub && <span className="kana-note">{c.sub}</span>}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="review-card stack practice card-enter" key={roundIndex}>
      <RunHeader exercise={exercise} label={`Vòng ${roundIndex + 1}/${rounds.length}`} onQuit={onQuit} />
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${(matched.size / round.left.length) * 100}%` }} />
      </div>
      <p className="muted small">Bấm một ô bên trái rồi bấm ô tương ứng bên phải.</p>
      <div className="match-board">
        {column("left")}
        {column("right")}
      </div>
      {roundDone && (
        <button className="primary" onClick={next}>
          {roundIndex + 1 >= rounds.length ? "Xem kết quả (Enter)" : "Vòng tiếp (Enter)"}
        </button>
      )}
    </div>
  );
}

function ChoiceRun({
  exercise,
  questions,
  onFinish,
  onQuit,
}: {
  exercise: "choice" | "cloze";
  questions: (ChoiceQuestion | ClozeQuestion)[];
  onFinish: (r: Result) => void;
  onQuit: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [correct, setCorrect] = useState(0);
  const [mistakes, setMistakes] = useState<Mistake[]>([]);
  const question = questions[index];
  const item = "item" in question ? question.item : null;

  function choose(option: number) {
    if (picked !== null) return;
    setPicked(option);
    if (option === question.answerIndex) setCorrect((c) => c + 1);
    else
      setMistakes((m) => [
        ...m,
        { prompt: question.prompt, answer: question.options[question.answerIndex], chosen: question.options[option] },
      ]);
  }

  function next() {
    if (picked === null) return;
    if (index + 1 >= questions.length) {
      onFinish({ exercise, total: questions.length, correct, mistakes });
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
    <div className="review-card stack quiz practice card-enter" key={index}>
      <RunHeader exercise={exercise} label={`Câu ${index + 1}/${questions.length}`} onQuit={onQuit} />
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${(index / questions.length) * 100}%` }} />
      </div>
      {item ? (
        <div className="term-block">
          <div className="jp cloze-sentence">
            {item.before}
            <span className="cloze-blank">{picked === null ? "＿＿" : item.answer}</span>
            {item.after}
          </div>
          {item.readings && (
            <div className="kana-note cloze-reading">
              {item.readings.before}
              {picked === null ? "＿＿" : item.readings.answer}
              {item.readings.after}
            </div>
          )}
          {item.vi && <div className="muted">{item.vi}</div>}
        </div>
      ) : (
        <div className="term-block">
          <div className="choice-prompt">{question.prompt}</div>
        </div>
      )}
      <div className="quiz-options">
        {question.options.map((option, i) => {
          const state = picked === null ? "" : i === question.answerIndex ? "correct" : i === picked ? "wrong" : "";
          return (
            <button key={i} className={`quiz-option jp ${state}`} onClick={() => choose(i)} disabled={picked !== null}>
              <span className="grade-key">{i + 1}</span>
              <span className="option-text">
                <span className="match-text">{option}</span>
                {question.optionNotes?.[i] && <span className="kana-note">{question.optionNotes[i]}</span>}
              </span>
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

function OrderRun({
  items,
  shuffled,
  onFinish,
  onQuit,
}: {
  items: OrderItem[];
  shuffled: string[][];
  onFinish: (r: Result) => void;
  onQuit: () => void;
}) {
  const [index, setIndex] = useState(0);
  /** Chỉ số (trong `shuffled[index]`) của các mảnh đã xếp, theo thứ tự. */
  const [placed, setPlaced] = useState<number[]>([]);
  /** idle: đang xếp · wrong: vừa kiểm tra sai (sửa rồi kiểm tra lại) · correct: đúng, được sang câu tiếp. */
  const [status, setStatus] = useState<"idle" | "wrong" | "correct">("idle");
  /** Số lần kiểm tra sai của câu hiện tại. */
  const [wrongTries, setWrongTries] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [mistakes, setMistakes] = useState<Mistake[]>([]);
  const item = items[index];
  const pieces = shuffled[index];
  const allPlaced = placed.length === pieces.length;
  const locked = status === "correct";

  /** Kana của 1 mảnh (null nếu câu chưa có cách đọc). */
  const readingOf = (piece: string) => item.readings?.[item.pieces.indexOf(piece)] ?? null;

  function place(i: number) {
    if (locked || placed.includes(i)) return;
    setStatus("idle");
    setPlaced((p) => [...p, i]);
  }

  function unplace(pos: number) {
    if (locked) return;
    setStatus("idle");
    setPlaced((p) => p.filter((_, k) => k !== pos));
  }

  function retry() {
    setStatus("idle");
    setPlaced([]);
  }

  function check() {
    if (!allPlaced || status !== "idle") return;
    const attempt = placed.map((i) => pieces[i]);
    if (orderPiecesCheck(item.pieces, attempt)) {
      setStatus("correct");
      // Chỉ tính điểm khi đúng ngay lần đầu.
      if (wrongTries === 0) setCorrect((c) => c + 1);
      return;
    }
    setStatus("wrong");
    if (wrongTries === 0) {
      setMistakes((m) => [...m, { prompt: item.vi ?? "", answer: item.pieces.join(""), chosen: attempt.join("") }]);
    }
    setWrongTries((n) => n + 1);
  }

  function next() {
    if (status !== "correct") return;
    if (index + 1 >= items.length) {
      onFinish({ exercise: "order", total: items.length, correct, mistakes });
      return;
    }
    setIndex(index + 1);
    setPlaced([]);
    setStatus("idle");
    setWrongTries(0);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.repeat) return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (status === "correct") next();
        else if (status === "wrong") retry();
        else check();
      } else if (event.key === "Backspace" && !locked && placed.length > 0) {
        event.preventDefault();
        unplace(placed.length - 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const piece = (text: string) => {
    const kana = readingOf(text);
    return (
      <>
        <span className="piece-text">{text}</span>
        {kana && kana !== text && <span className="kana-note">{kana}</span>}
      </>
    );
  };

  return (
    <div className="review-card stack practice card-enter" key={index}>
      <RunHeader exercise="order" label={`Câu ${index + 1}/${items.length}`} onQuit={onQuit} />
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${(index / items.length) * 100}%` }} />
      </div>
      {item.vi && <div className="choice-prompt">{item.vi}</div>}
      <div className={`order-answer ${status === "correct" ? "correct" : status === "wrong" ? "wrong" : ""}`} aria-label="Câu đang xếp">
        {placed.length === 0 && <span className="muted small">Bấm các mảnh bên dưới theo đúng thứ tự…</span>}
        {placed.map((i, pos) => (
          <button key={i} className="order-piece jp placed" onClick={() => unplace(pos)} disabled={locked}>
            {piece(pieces[i])}
          </button>
        ))}
      </div>
      <div className="order-pool">
        {pieces.map((p, i) => (
          <button key={i} className="order-piece jp" onClick={() => place(i)} disabled={locked || placed.includes(i)}>
            {piece(p)}
          </button>
        ))}
      </div>
      {status === "correct" ? (
        <>
          <p className="order-verdict good">
            ✅ Chính xác!{wrongTries > 0 ? ` (sau ${wrongTries} lần sai)` : ""} <span className="jp">{item.pieces.join("")}</span>
          </p>
          <button className="primary" onClick={next}>
            {index + 1 >= items.length ? "Xem kết quả (Enter)" : "Câu tiếp (Enter)"}
          </button>
        </>
      ) : status === "wrong" ? (
        <>
          <p className="order-verdict bad">
            ❌ Chưa đúng, thử lại nhé! Bấm vào mảnh để gỡ ra rồi xếp lại.
            {wrongTries >= 2 && (
              <>
                {" "}
                Gợi ý: <span className="jp">{item.pieces.join(" / ")}</span>
              </>
            )}
          </p>
          <button className="primary" onClick={retry}>
            Xếp lại từ đầu (Enter)
          </button>
        </>
      ) : (
        <button className="primary" onClick={check} disabled={!allPlaced}>
          Kiểm tra (Enter)
        </button>
      )}
    </div>
  );
}
