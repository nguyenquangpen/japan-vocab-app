import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Db } from "../db/db";
import { buildMistakesPrompt } from "../review/mistakesPrompt";
import {
  ALL_WORDS,
  getReviewOverview,
  loadPracticePool,
  loadMainRound,
  loadNewRound,
  pickPractice,
  shuffle,
  submitReview,
  type ReviewItem,
  type ReviewOverview,
  type ReviewScope,
} from "../review/review";
import { listTopics, type Topic } from "../topics/topics";
import { Rating, State, type Grade } from "../review/scheduler";
import { loadSettings, type Settings } from "../settings/settings";

interface Props {
  db: Db;
}

/**
 * main/new: chấm qua FSRS (ghi DB). Còn lại là luyện thêm, không ghi DB.
 * forgotten: từ vừa quên · recent: từ của lượt vừa học · mix: lượt vừa học + từ cũ
 * random: ngẫu nhiên có trọng số · all: luyện lại toàn bộ vốn từ theo từng lượt.
 */
type RoundKind = "main" | "new" | "forgotten" | "recent" | "mix" | "random" | "all";

interface Round {
  id: number;
  kind: RoundKind;
  items: ReviewItem[];
}

interface Result {
  item: ReviewItem;
  rating: Grade;
}

type Stage =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "setup" }
  | { kind: "playing"; round: Round; results: Result[] }
  | { kind: "summary"; round: Round | null; results: Result[]; overview: ReviewOverview };

/** Phạm vi ôn đã chọn + nhãn để hiển thị. */
interface ScopeChoice {
  scope: ReviewScope;
  label: string;
}

const ALL_SCOPE: ScopeChoice = { scope: ALL_WORDS, label: "Tất cả từ" };

const GRADED: Record<RoundKind, boolean> = {
  main: true,
  new: true,
  forgotten: false,
  recent: false,
  mix: false,
  random: false,
  all: false,
};

const ROUND_TITLE: Record<RoundKind, string> = {
  main: "Lượt ôn theo lịch",
  new: "Học thêm từ mới",
  forgotten: "Ôn lại từ vừa quên",
  recent: "Ôn lại từ vừa học",
  mix: "Từ vừa học + từ cũ",
  random: "Luyện ngẫu nhiên",
  all: "Luyện lại toàn bộ",
};

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

/** Kéo quá khoảng này (px) thì tính là chấm. */
const SWIPE_THRESHOLD = 110;
/** Thời gian thẻ bay ra khỏi màn hình trước khi chấm (ms). */
const FLY_MS = 250;

export default function ReviewTab({ db }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [choice, setChoice] = useState<ScopeChoice>(ALL_SCOPE);
  const [error, setError] = useState<string | null>(null);
  const roundId = useRef(0);
  // Phần còn lại của "Luyện toàn bộ" (đi qua hết phạm vi theo từng lượt).
  const [allQueue, setAllQueue] = useState<ReviewItem[]>([]);
  const busy = useRef(false);

  const showSummary = useCallback(
    async (round: Round | null, results: Result[], s: Settings, scope: ReviewScope) => {
      const overview = await getReviewOverview(db, s, new Date(), scope);
      setStage({ kind: "summary", round, results, overview });
    },
    [db],
  );

  // Mở tab: chọn phạm vi và cách ôn trước, chưa vào ôn ngay.
  useEffect(() => {
    let cancelled = false;
    loadSettings(db)
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        setStage({ kind: "setup" });
      })
      .catch((e: unknown) => !cancelled && setStage({ kind: "error", message: String(e) }));
    return () => {
      cancelled = true;
    };
  }, [db]);

  async function answer(rating: Grade) {
    if (stage.kind !== "playing" || !settings || busy.current) return;
    busy.current = true;
    const { round, results } = stage;
    const item = round.items[results.length];
    try {
      if (GRADED[round.kind]) await submitReview(db, item, rating, rating !== Rating.Again);
      const next = [...results, { item, rating }];
      setError(null);
      if (next.length < round.items.length) setStage({ kind: "playing", round, results: next });
      else await showSummary(round, next, settings, choice.scope);
    } catch (e) {
      setError(`Lỗi khi lưu: ${String(e)}`);
    } finally {
      busy.current = false;
    }
  }

  /** Bắt đầu 1 lượt trong phạm vi `sc` (từ màn chọn phạm vi hoặc màn hết lượt). */
  async function choose(kind: RoundKind, sc: ScopeChoice = choice) {
    if (!settings) return;
    const size = settings.sessionSize;
    const prev = stage.kind === "summary" ? stage : null;
    const lastItems = prev?.round?.items ?? [];
    const forgotten = (prev?.results ?? []).filter((r) => r.rating === Rating.Again).map((r) => r.item);
    const start = async (items: ReviewItem[]) => {
      if (items.length === 0) return void (await showSummary(null, [], settings, sc.scope));
      roundId.current += 1;
      setStage({ kind: "playing", round: { id: roundId.current, kind, items }, results: [] });
    };
    try {
      setChoice(sc);
      setStage({ kind: "loading" });
      if (kind === "main") return void (await start(await loadMainRound(db, settings, new Date(), sc.scope)));
      if (kind === "new") return void (await start(await loadNewRound(db, settings, new Date(), sc.scope)));
      if (kind === "forgotten") return void (await start(shuffle(forgotten)));
      if (kind === "recent") return void (await start(shuffle(lastItems)));

      // Mọi từ trong phạm vi, kể cả từ chưa ôn lần nào.
      const pool = await loadPracticePool(db, new Date(), sc.scope);
      const now = new Date();
      const lastIds = new Set(lastItems.map((i) => i.cardId));
      if (kind === "mix") {
        // "Từ cũ" = từ đã ôn trước đây, không tính từ chưa ôn và từ của lượt vừa rồi.
        const older = pool.filter((i) => i.card.state !== State.New && !lastIds.has(i.cardId));
        return void (await start(shuffle([...lastItems, ...pickPractice(older, Math.ceil(size / 2), now)])));
      }
      // Ngẫu nhiên: tránh lặp lại các từ của lượt ngay trước nếu còn đủ từ khác.
      if (kind === "random") return void (await start(pickPractice(pool, size, now, Math.random, lastIds)));
      // all: lượt đầu xáo cả phạm vi; các lượt sau đi tiếp phần còn lại.
      const queue = prev?.round?.kind === "all" && allQueue.length > 0 ? allQueue : shuffle(pool);
      setAllQueue(queue.slice(size));
      await start(queue.slice(0, size));
    } catch (e) {
      setStage({ kind: "error", message: String(e) });
    }
  }

  if (stage.kind === "error") return <p className="error">Lỗi khi tải phiên ôn: {stage.message}</p>;
  if (stage.kind === "loading" || !settings) return <p className="muted">Đang tải phiên ôn…</p>;

  if (stage.kind === "setup") {
    return <ReviewSetup db={db} settings={settings} initial={choice} onStart={(kind, sc) => void choose(kind, sc)} />;
  }

  if (stage.kind === "summary") {
    return (
      <RoundSummary
        round={stage.round}
        results={stage.results}
        overview={stage.overview}
        level={settings.level}
        scopeLabel={choice.label}
        allLeft={stage.round?.kind === "all" ? allQueue.length : 0}
        onChoose={(kind) => void choose(kind)}
        onChangeScope={() => setStage({ kind: "setup" })}
      />
    );
  }

  const { round, results } = stage;
  const graded = GRADED[round.kind];
  const current = round.items[results.length];
  return (
    <section className="review stack">
      <div className="row round-head">
        <span className="round-title">
          {ROUND_TITLE[round.kind]} <span className="muted small">· {choice.label}</span>
        </span>
        {!graded && <span className="badge">Luyện thêm · không đổi lịch ôn</span>}
      </div>
      <SessionProgress done={results.length} total={round.items.length} />
      <Flashcard
        key={`${round.id}-${results.length}`}
        item={current}
        grades={GRADES[graded ? settings.gradeButtons : 2]}
        counts={countByRating(results)}
        onAnswer={answer}
      />
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function countByRating(results: Result[]): Map<Grade, number> {
  const counts = new Map<Grade, number>();
  for (const r of results) counts.set(r.rating, (counts.get(r.rating) ?? 0) + 1);
  return counts;
}

interface FlashcardProps {
  item: ReviewItem;
  grades: { rating: Grade; label: string }[];
  /** Số lần đã bấm mỗi nút trong lượt này (hiện ngay trên nút). */
  counts: Map<Grade, number>;
  onAnswer: (rating: Grade) => Promise<void>;
}

/**
 * Flashcard: mặt trước chữ Hán + kana, mặt sau nghĩa + ví dụ.
 * Bấm thẻ / Space lật. Kéo trái (←) = Quên, kéo phải (→) = Nhớ. Phím số chấm theo nút.
 */
function Flashcard({ item, grades, counts, onAnswer }: FlashcardProps) {
  const [flipped, setFlipped] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState<"left" | "right" | null>(null);
  const drag = useRef<{ startX: number; moved: boolean } | null>(null);
  const answered = useRef(false);

  const submit = useCallback(
    (rating: Grade) => {
      if (answered.current) return;
      answered.current = true;
      void onAnswer(rating).finally(() => {
        // Lỗi khi lưu: cho thử lại trên cùng thẻ.
        answered.current = false;
        setLeaving(null);
        setDragX(0);
      });
    },
    [onAnswer],
  );

  /** Cho thẻ bay sang trái/phải rồi chấm (trái = Quên, phải = Nhớ). */
  const swipe = useCallback(
    (direction: "left" | "right") => {
      if (answered.current || leaving) return;
      setLeaving(direction);
      window.setTimeout(() => submit(direction === "right" ? Rating.Good : Rating.Again), FLY_MS);
    },
    [submit, leaving],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.repeat) return;
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        setFlipped((f) => !f);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        swipe("left");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        swipe("right");
      } else {
        const index = Number.parseInt(event.key, 10) - 1;
        if (index >= 0 && index < grades.length) submit(grades[index].rating);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [grades, submit, swipe]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (leaving || event.button !== 0) return;
    drag.current = { startX: event.clientX, moved: false };
    setDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const dx = event.clientX - drag.current.startX;
    if (Math.abs(dx) > 6) drag.current.moved = true;
    setDragX(dx);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;
    const dx = event.clientX - d.startX;
    if (dx > SWIPE_THRESHOLD) swipe("right");
    else if (dx < -SWIPE_THRESHOLD) swipe("left");
    else {
      setDragX(0);
      // Bấm (không kéo) thì lật thẻ.
      if (!d.moved) setFlipped((f) => !f);
    }
  }

  function onPointerCancel() {
    drag.current = null;
    setDragging(false);
    setDragX(0);
  }

  const x = leaving === "right" ? 900 : leaving === "left" ? -900 : dragX;
  const strength = Math.min(1, Math.abs(x) / SWIPE_THRESHOLD);

  return (
    <div className="stack card-enter">
      <div
        className={`swipe-card${dragging ? " dragging" : ""}${leaving ? " leaving" : ""}`}
        style={{ transform: `translateX(${x}px) rotate(${x / 18}deg)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        role="button"
        aria-label="Flashcard: bấm để lật, kéo trái là quên, kéo phải là nhớ"
      >
        <span className="swipe-stamp forgot" style={{ opacity: x < 0 ? strength : 0 }}>
          QUÊN
        </span>
        <span className="swipe-stamp remembered" style={{ opacity: x > 0 ? strength : 0 }}>
          NHỚ
        </span>
        <div className="flip-scene">
          <div className={flipped ? "flip-card flipped" : "flip-card"}>
            <div className="flip-face flip-front review-card stack">
              <span className="card-label">Bạn có nhớ từ này?</span>
              <TermWithKana item={item} />
              <span className="flip-hint">Bấm vào thẻ hoặc Space để lật</span>
            </div>
            <div className="flip-face flip-back review-card stack" aria-hidden={!flipped}>
              <TermWithKana item={item} small />
              <Answer item={item} />
            </div>
          </div>
        </div>
      </div>
      <div className="row grade-row">
        {grades.map((g, i) => (
          <button
            key={g.rating}
            className={`grade-button grade-${g.rating}`}
            onClick={() => submit(g.rating)}
            disabled={leaving !== null}
          >
            <span className="grade-key">{i + 1}</span>
            {g.label}
            <span className="grade-count" aria-label={`${g.label}: ${counts.get(g.rating) ?? 0} từ`}>
              {counts.get(g.rating) ?? 0}
            </span>
          </button>
        ))}
      </div>
      <p className="swipe-hint muted small">← Kéo trái: Quên · Kéo phải: Nhớ →</p>
    </div>
  );
}

function SessionProgress({ done, total }: { done: number; total: number }) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="session-progress">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="muted small">
        Thẻ {Math.min(done + 1, total)}/{total}
      </span>
    </div>
  );
}

/** Chữ Hán to ở trên, kana nhỏ bên dưới (từ toàn kana hoặc chưa có kana thì không hiện dòng kana). */
function TermWithKana({ item, small = false }: { item: ReviewItem; small?: boolean }) {
  return (
    <div className="term-block">
      <div className={`jp review-term${small ? " small-term" : ""}`}>{item.term}</div>
      {!item.kanaOnly && item.reading && <div className="jp term-kana">{item.reading}</div>}
    </div>
  );
}

function Answer({ item }: { item: ReviewItem }) {
  return (
    <div className="review-answer stack">
      <div className="review-meanings">{item.meanings.join("; ")}</div>
      {item.meaningDetail && <div className="meaning-detail pre-line">{item.meaningDetail}</div>}
      {item.example && (
        <div className="card-example">
          <div className="jp example-ja">{item.example.ja}</div>
          {item.example.reading && item.example.reading !== item.example.ja && (
            <div className="jp example-reading">{item.example.reading}</div>
          )}
          {item.example.vi && <div className="example-vi muted">{item.example.vi}</div>}
        </div>
      )}
    </div>
  );
}

const CHEERS = {
  perfect: [
    "Hoàn hảo! Không quên từ nào 🎯",
    "Xuất sắc! Trí nhớ của bạn đang ở phong độ đỉnh cao 💯",
    "Quá đỉnh! Cứ giữ nhịp này là JLPT chỉ là chuyện nhỏ 🏆",
  ],
  good: [
    "Làm tốt lắm! Mỗi lượt ôn là một bước gần hơn tới mục tiêu 🚀",
    "Tuyệt vời! Từ vựng đang bám rễ vào đầu bạn rồi đấy 🌸",
    "Giỏi lắm! Kiên trì mỗi ngày là bí quyết nhớ lâu 💪",
  ],
  keep: [
    "Quên là một phần của nhớ — ôn lại ngay là nhớ lâu hơn 🌱",
    "Không sao cả! Từ khó hôm nay sẽ là từ quen ngày mai ✨",
    "Bạn đang tiến bộ từng chút một. Ôn lại từ vừa quên nhé! 🔁",
  ],
};

function pickCheer(remembered: number, total: number): string {
  const rate = total === 0 ? 0 : remembered / total;
  const list = rate === 1 ? CHEERS.perfect : rate >= 0.7 ? CHEERS.good : CHEERS.keep;
  return list[Math.floor(Math.random() * list.length)];
}

type ScopeKind = ReviewScope["kind"];

interface SetupProps {
  db: Db;
  settings: Settings;
  initial: ScopeChoice;
  onStart: (kind: RoundKind, choice: ScopeChoice) => void;
}

/** Màn đầu tab Ôn tập: chọn phạm vi (tất cả / theo chủ đề / chưa có chủ đề) rồi chọn cách ôn. */
function ReviewSetup({ db, settings, initial, onStart }: SetupProps) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [kind, setKind] = useState<ScopeKind>(initial.scope.kind);
  const [topicIds, setTopicIds] = useState<Set<number>>(
    new Set(initial.scope.kind === "topics" ? initial.scope.topicIds : []),
  );
  const [overview, setOverview] = useState<ReviewOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scope: ReviewScope = kind === "topics" ? { kind, topicIds: [...topicIds] } : { kind };
  // Chuỗi ổn định của các chủ đề đã chọn để effect đếm lại khi đổi lựa chọn.
  const topicKey = [...topicIds].sort((a, b) => a - b).join(",");

  useEffect(() => {
    let cancelled = false;
    listTopics(db)
      .then((t) => !cancelled && setTopics(t))
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [db]);

  useEffect(() => {
    let cancelled = false;
    const ids = topicKey === "" ? [] : topicKey.split(",").map(Number);
    const sc: ReviewScope = kind === "topics" ? { kind, topicIds: ids } : { kind };
    getReviewOverview(db, settings, new Date(), sc)
      .then((o) => !cancelled && setOverview(o))
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [db, settings, kind, topicKey]);

  function toggleTopic(id: number) {
    setTopicIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function label(): string {
    if (kind === "noTopic") return "Từ chưa có chủ đề";
    if (kind === "topics") {
      const names = topics.filter((t) => topicIds.has(t.id)).map((t) => t.name);
      return `Chủ đề: ${names.join(", ")}`;
    }
    return "Tất cả từ";
  }

  const start = (round: RoundKind) => onStart(round, { scope, label: label() });
  const noTopicPicked = kind === "topics" && topicIds.size === 0;
  const nextMain = overview ? overview.dueNow + overview.newTodayLeft : 0;

  return (
    <section className="stack review-setup card-enter">
      <h1>Ôn tập</h1>

      <div className="card stack">
        <h2>1. Ôn phần nào?</h2>
        <div className="scope-options">
          {(
            [
              ["all", "📚 Tất cả từ"],
              ["topics", "🏷️ Theo chủ đề"],
              ["noTopic", "📭 Từ chưa có chủ đề"],
            ] as [ScopeKind, string][]
          ).map(([k, text]) => (
            <label key={k} className={kind === k ? "scope-option active" : "scope-option"}>
              <input type="radio" name="scope" checked={kind === k} onChange={() => setKind(k)} />
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
      </div>

      <div className="card stack">
        <h2>2. Ôn thế nào?</h2>
        {noTopicPicked ? (
          <p className="muted small">Chọn ít nhất 1 chủ đề.</p>
        ) : overview === null ? (
          <p className="muted small">Đang đếm…</p>
        ) : overview.total === 0 ? (
          <p className="muted small">Phạm vi này chưa có từ nào có nghĩa để ôn.</p>
        ) : (
          <div className="setup-actions">
            <button className="setup-action primary" onClick={() => start("main")} disabled={nextMain === 0}>
              <strong>▶️ Ôn theo lịch</strong>
              <span>{nextMain > 0 ? `${nextMain} thẻ đến hạn / từ mới hôm nay` : "Hôm nay đã ôn xong lịch"}</span>
            </button>
            <button className="setup-action" onClick={() => start("new")} disabled={overview.newLeft === 0}>
              <strong>✨ Học từ mới</strong>
              <span>{overview.newLeft} từ chưa học</span>
            </button>
            <button className="setup-action" onClick={() => start("random")}>
              <strong>🎲 Luyện ngẫu nhiên</strong>
              <span>Bốc {Math.min(settings.sessionSize, overview.total)} trong {overview.total} từ, ưu tiên từ yếu</span>
            </button>
            <button className="setup-action" onClick={() => start("all")}>
              <strong>🔄 Luyện toàn bộ</strong>
              <span>Đi hết {overview.total} từ, mỗi lượt {settings.sessionSize}</span>
            </button>
          </div>
        )}
        <p className="muted small">"Ôn theo lịch" và "Học từ mới" tính vào lịch ôn. Luyện ngẫu nhiên / toàn bộ không đổi lịch.</p>
        {error && <p className="error">{error}</p>}
      </div>
    </section>
  );
}

interface SummaryProps {
  round: Round | null;
  results: Result[];
  overview: ReviewOverview;
  level: string;
  /** Nhãn phạm vi đang ôn (vd. "Chủ đề: Động từ"). */
  scopeLabel: string;
  /** Số từ còn lại trong "Luyện lại toàn bộ". */
  allLeft: number;
  onChoose: (kind: RoundKind) => void;
  onChangeScope: () => void;
}

function RoundSummary({ round, results, overview, level, scopeLabel, allLeft, onChoose, onChangeScope }: SummaryProps) {
  const forgotten = results.filter((r) => r.rating === Rating.Again).map((r) => r.item);
  const remembered = results.length - forgotten.length;
  const [cheer] = useState(() => pickCheer(remembered, results.length));
  const [copyMessage, setCopyMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const finishedAll = overview.dueNow === 0 && overview.newLeft === 0 && overview.total > 0;
  const nextMain = overview.dueNow + overview.newTodayLeft;
  const graded = round !== null && GRADED[round.kind];

  async function copyPrompt() {
    try {
      await writeText(buildMistakesPrompt(forgotten, level));
      setCopyMessage({ kind: "ok", text: "Đã copy. Dán vào ChatGPT để đọc giải thích." });
    } catch (e) {
      setCopyMessage({ kind: "error", text: `Không copy được: ${String(e)}` });
    }
  }

  return (
    <section className="stack session-end card-enter">
      {results.length > 0 && <Confetti />}
      <div className="row">
        <h1>Ôn tập</h1>
        <span className="badge scope-badge">{scopeLabel}</span>
        <button className="push-right" onClick={onChangeScope}>
          ⚙️ Đổi phạm vi ôn
        </button>
      </div>
      {results.length === 0 ? (
        <div className="empty-state">
          <div className="empty-mark jp">休</div>
          <p>Không có thẻ nào đến hạn lúc này.</p>
        </div>
      ) : (
        <>
          <p className="session-title">Xong lượt! 🎉</p>
          <p className="cheer">{cheer}</p>
          <div className="stat-tiles">
            <StatTile label="Thẻ" value={results.length} />
            <StatTile label="Nhớ" value={remembered} tone="good" />
            <StatTile label="Quên" value={forgotten.length} tone="bad" />
            <StatTile label="Tỉ lệ nhớ" value={`${Math.round((remembered / results.length) * 100)}%`} />
          </div>
        </>
      )}

      {finishedAll && (
        <div className="all-done card stack">
          <p className="session-title">🏁 Bạn đã ôn hết toàn bộ vốn từ!</p>
          <p className="muted small">Không còn thẻ đến hạn và không còn từ mới. Muốn ôn lại từ đầu thì luyện toàn bộ nhé.</p>
        </div>
      )}

      <div className="card stack">
        <h2>Học tiếp</h2>
        <div className="next-actions">
          {forgotten.length > 0 && (
            <button className="primary" onClick={() => onChoose("forgotten")}>
              🔁 Ôn lại {forgotten.length} từ vừa quên
            </button>
          )}
          {graded && round.items.length > 0 && (
            <>
              <button onClick={() => onChoose("recent")}>📘 Ôn lại {round.items.length} từ vừa học</button>
              {overview.total > round.items.length && (
                <button onClick={() => onChoose("mix")}>📚 Từ vừa học + từ cũ</button>
              )}
            </>
          )}
          {nextMain > 0 && <button onClick={() => onChoose("main")}>▶️ Lượt ôn tiếp theo ({nextMain} thẻ chờ)</button>}
          {overview.newLeft > 0 && <button onClick={() => onChoose("new")}>✨ Học thêm từ mới ({overview.newLeft} từ)</button>}
          {overview.total > 0 && (
            <button onClick={() => onChoose("random")}>🎲 Luyện ngẫu nhiên (trong {overview.total} từ)</button>
          )}
          {overview.total > 0 &&
            (round?.kind === "all" && allLeft > 0 ? (
              <button className="primary" onClick={() => onChoose("all")}>
                🔄 Luyện tiếp toàn bộ (còn {allLeft} từ)
              </button>
            ) : (
              <button className={finishedAll ? "primary" : ""} onClick={() => onChoose("all")}>
                🔄 {round?.kind === "all" || finishedAll ? "Luyện lại toàn bộ từ đầu" : "Luyện toàn bộ vốn từ"} (
                {overview.total} từ)
              </button>
            ))}
        </div>
        <p className="muted small">Luyện thêm không đổi lịch ôn. Chỉ "Lượt ôn" và "Học thêm từ mới" mới tính vào lịch.</p>
      </div>

      {forgotten.length > 0 && (
        <div className="card stack">
          <h2>Các từ đã quên</h2>
          <ul>
            {forgotten.map((m) => (
              <li key={m.cardId}>
                <span className="jp">{m.term}</span>
                {m.reading && m.reading !== m.term && (
                  <>
                    {" "}
                    (<span className="jp">{m.reading}</span>)
                  </>
                )}
                : {m.meanings.join("; ")}
              </li>
            ))}
          </ul>
          <div className="row">
            <button onClick={() => void copyPrompt()}>Copy prompt giải thích từ đã quên</button>
            {copyMessage && <span className={copyMessage.kind === "ok" ? "success" : "error"}>{copyMessage.text}</span>}
          </div>
        </div>
      )}

      {overview.nextDue && nextMain === 0 && (
        <p className="muted small">Thẻ đến hạn gần nhất: {new Date(overview.nextDue).toLocaleString("vi-VN")}</p>
      )}
      {overview.notReady > 0 && (
        <p className="muted small">
          {overview.notReady} từ chưa có nghĩa nên chưa vào ôn. Bổ sung ở tab Thêm từ hoặc Kho từ.
        </p>
      )}
    </section>
  );
}

const CONFETTI_COLORS = ["#4f5bd5", "#c06c9a", "#f6c1cf", "#1a7f37", "#f2b134", "#5cc8e8"];

/** Pháo giấy chúc mừng (CSS thuần, tự biến mất sau ~3 giây). */
function Confetti() {
  const [pieces] = useState(() =>
    Array.from({ length: 70 }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.6,
      duration: 2.2 + Math.random() * 1.4,
      size: 6 + Math.random() * 8,
      drift: (Math.random() - 0.5) * 160,
      spin: 360 + Math.random() * 720,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      round: Math.random() < 0.3,
    })),
  );
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="confetti-piece"
          style={
            {
              left: `${p.left}%`,
              width: `${p.size}px`,
              height: `${p.round ? p.size : p.size * 0.45}px`,
              background: p.color,
              borderRadius: p.round ? "50%" : "2px",
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
              "--drift": `${p.drift}px`,
              "--spin": `${p.spin}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
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
