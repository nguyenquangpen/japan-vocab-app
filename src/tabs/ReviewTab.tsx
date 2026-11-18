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
import { reportNewlyMastered, reportSessionCompleted } from "../hub/events";
import type { HubSender } from "../hub/sender";
import { buildMistakesPrompt } from "../review/mistakesPrompt";
import { countUnseenOldWords, pickOldWords } from "../review/oldWordsMemory";
import {
  ALL_WORDS,
  getReviewOverview,
  loadNewRound,
  loadPracticePool,
  loadTodayRound,
  shuffle,
  submitReview,
  wordStatus,
  type ReviewItem,
  type ReviewOverview,
  type ReviewScope,
  type WordStatus,
} from "../review/review";
import { Rating, type Grade } from "../review/scheduler";
import { loadSettings, type Settings } from "../settings/settings";
import { listTopics, type Topic } from "../topics/topics";
import MascotToast from "./MascotToast";

interface Props {
  db: Db;
  /** Bộ gửi sự kiện sang Hub (null nếu chưa sẵn sàng / trong test). */
  hub?: HubSender | null;
}

/**
 * today: Ôn hôm nay (đến hạn → từ mới, mới nhất trước) — mở app là chạy, tính vào lịch.
 * new: Học thêm từ mới (mới nhất trước) — tính vào lịch.
 * forgotten: Ôn lại từ vừa quên · old: Ôn từ vựng cũ (ngẫu nhiên trong từ đã học)
 * free: Luyện tự do theo phạm vi (đi hết phạm vi theo từng lượt). Ba kiểu này không đổi lịch.
 */
type RoundKind = "today" | "new" | "forgotten" | "old" | "free";

interface Round {
  id: number;
  kind: RoundKind;
  items: ReviewItem[];
  /** Mã phiên ổn định (gửi Hub làm subject.external_id) và lúc bắt đầu. */
  sessionId: string;
  startedAt: Date;
}

interface Result {
  item: ReviewItem;
  rating: Grade;
}

type Stage =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "options" }
  | { kind: "playing"; round: Round; results: Result[] }
  | { kind: "summary"; round: Round | null; results: Result[]; overview: ReviewOverview; oldLeft: number };

/** Phạm vi ôn đã chọn + nhãn để hiển thị. */
interface ScopeChoice {
  scope: ReviewScope;
  label: string;
}

const ALL_SCOPE: ScopeChoice = { scope: ALL_WORDS, label: "Tất cả từ" };

const GRADED: Record<RoundKind, boolean> = {
  today: true,
  new: true,
  forgotten: false,
  old: false,
  free: false,
};

const ROUND_TITLE: Record<RoundKind, string> = {
  today: "Ôn hôm nay",
  new: "Học từ mới",
  forgotten: "Ôn lại từ vừa quên",
  old: "Ôn từ vựng cũ",
  free: "Luyện tự do",
};

const STATUS_BADGE: Record<WordStatus, { text: string; className: string }> = {
  new: { text: "🆕 Mới", className: "status-new" },
  learning: { text: "📖 Đang học", className: "status-learning" },
  mastered: { text: "✅ Vững", className: "status-mastered" },
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

export default function ReviewTab({ db, hub = null }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [choice, setChoice] = useState<ScopeChoice>(ALL_SCOPE);
  const [includeMastered, setIncludeMastered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roundId = useRef(0);
  // Phần còn lại của "Luyện tự do" (đi hết phạm vi theo từng lượt).
  const [freeQueue, setFreeQueue] = useState<ReviewItem[]>([]);
  const busy = useRef(false);

  const showSummary = useCallback(
    async (round: Round | null, results: Result[], s: Settings, scope: ReviewScope) => {
      const overview = await getReviewOverview(db, s, new Date(), scope);
      // Từ cũ (đã học) trong phạm vi chưa gặp ở "Ôn từ vựng cũ" của lần mở app này.
      const learned = await loadPracticePool(db, { scope, learnedOnly: true });
      setStage({ kind: "summary", round, results, overview, oldLeft: countUnseenOldWords(scope, learned) });
    },
    [db],
  );

  /**
   * Bắt đầu 1 lượt. Tùy chọn (`sc`, `mastered`) và phần còn lại của Luyện tự do (`pendingFree`)
   * truyền qua tham số để hàm không phụ thuộc state.
   */
  const choose = useCallback(
    async (
      kind: RoundKind,
      s: Settings,
      prev: { round: Round | null; results: Result[] } | null,
      sc: ScopeChoice,
      mastered: boolean,
      pendingFree: ReviewItem[] = [],
    ) => {
      const size = s.sessionSize;
      const forgotten = (prev?.results ?? []).filter((r) => r.rating === Rating.Again).map((r) => r.item);
      const start = async (items: ReviewItem[]) => {
        if (items.length === 0) return void (await showSummary(null, [], s, sc.scope));
        roundId.current += 1;
        setStage({
          kind: "playing",
          round: { id: roundId.current, kind, items, sessionId: crypto.randomUUID(), startedAt: new Date() },
          results: [],
        });
      };
      try {
        setChoice(sc);
        setIncludeMastered(mastered);
        setStage({ kind: "loading" });
        if (kind === "today") return void (await start(await loadTodayRound(db, s, new Date(), sc.scope)));
        if (kind === "new") return void (await start(await loadNewRound(db, s, new Date(), sc.scope)));
        if (kind === "forgotten") return void (await start(shuffle(forgotten)));
        if (kind === "old") {
          // Chỉ bốc từ cũ chưa gặp trong lần mở app này, thứ tự xáo trộn (xem oldWordsMemory).
          const pool = await loadPracticePool(db, { scope: sc.scope, learnedOnly: true });
          return void (await start(pickOldWords(sc.scope, pool, size).items));
        }
        // free: lượt đầu xáo cả phạm vi; các lượt sau đi tiếp phần còn lại.
        let queue = prev?.round?.kind === "free" ? pendingFree : [];
        if (queue.length === 0) {
          queue = shuffle(await loadPracticePool(db, { scope: sc.scope, includeMastered: mastered }));
        }
        setFreeQueue(queue.slice(size));
        await start(queue.slice(0, size));
      } catch (e) {
        setStage({ kind: "error", message: String(e) });
      }
    },
    [db, showSummary],
  );

  // Mở tab: vào thẳng "Ôn hôm nay" (toàn bộ vốn từ).
  useEffect(() => {
    let cancelled = false;
    loadSettings(db)
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        void choose("today", s, null, ALL_SCOPE, false);
      })
      .catch((e: unknown) => !cancelled && setStage({ kind: "error", message: String(e) }));
    return () => {
      cancelled = true;
    };
  }, [db, choose]);

  async function answer(rating: Grade) {
    if (stage.kind !== "playing" || !settings || busy.current) return;
    busy.current = true;
    const { round, results } = stage;
    const item = round.items[results.length];
    try {
      if (GRADED[round.kind]) await submitReview(db, item, rating, rating !== Rating.Again);
    } catch (e) {
      // Chưa lưu được: ở lại thẻ này để thử lại.
      setError(`Lỗi khi lưu: ${String(e)}`);
      busy.current = false;
      return;
    }
    // Đã lưu xong. Từ đây lỗi (vd. khi tải màn tổng kết) không được cho chấm lại thẻ này.
    const next = [...results, { item, rating }];
    setError(null);
    try {
      if (next.length < round.items.length) setStage({ kind: "playing", round, results: next });
      else {
        void reportRoundToHub(db, hub, round, next.length, GRADED[round.kind], choice);
        await showSummary(round, next, settings, choice.scope);
      }
    } catch (e) {
      setStage({ kind: "error", message: String(e) });
    } finally {
      busy.current = false;
    }
  }

  if (stage.kind === "error") return <p className="error">Lỗi khi tải phiên ôn: {stage.message}</p>;
  if (stage.kind === "loading" || !settings) return <p className="muted">Đang tải phiên ôn…</p>;

  if (stage.kind === "options") {
    return (
      <ReviewOptions
        db={db}
        settings={settings}
        initial={choice}
        initialIncludeMastered={includeMastered}
        onStart={(kind, sc, mastered) => void choose(kind, settings, null, sc, mastered)}
        onCancel={() => void choose("today", settings, null, ALL_SCOPE, false)}
      />
    );
  }

  if (stage.kind === "summary") {
    const prev = { round: stage.round, results: stage.results };
    return (
      <RoundSummary
        round={stage.round}
        results={stage.results}
        overview={stage.overview}
        oldLeft={stage.oldLeft}
        settings={settings}
        scopeLabel={choice.label}
        freeLeft={stage.round?.kind === "free" ? freeQueue.length : 0}
        onChoose={(kind) => void choose(kind, settings, prev, choice, includeMastered, freeQueue)}
        onOptions={() => setStage({ kind: "options" })}
      />
    );
  }

  const { round, results } = stage;
  const graded = GRADED[round.kind];
  const current = round.items[results.length];
  const status = STATUS_BADGE[wordStatus(current.card)];
  return (
    <section className="review stack">
      <div className="row round-head">
        <span className="round-title">
          {ROUND_TITLE[round.kind]} <span className="muted small">· {choice.label}</span>
        </span>
        <span className="row">
          <span className={`badge ${status.className}`}>{status.text}</span>
          {!graded && <span className="badge">Luyện · không đổi lịch</span>}
        </span>
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

/**
 * Báo Hub khi xong 1 lượt (chạy nền; lỗi không ảnh hưởng màn ôn):
 * - learning.session.completed cho mọi lượt (helper tự bỏ lượt < 1 phút).
 * - vocabulary.learned cho lượt có chấm lịch: các từ lần đầu đạt Vững (mỗi từ báo 1 lần).
 */
async function reportRoundToHub(
  db: Db,
  hub: HubSender | null,
  round: Round,
  itemsReviewed: number,
  graded: boolean,
  choice: ScopeChoice,
): Promise<void> {
  const endedAt = new Date();
  try {
    await reportSessionCompleted(db, { sessionId: round.sessionId, startedAt: round.startedAt, endedAt, itemsReviewed });
    if (graded) {
      await reportNewlyMastered(db, {
        sessionId: round.sessionId,
        wordIds: round.items.map((i) => i.wordId),
        occurredAt: endedAt,
        deck: choice.scope.kind === "topics" ? choice.label : undefined,
      });
    }
    await hub?.kick();
  } catch {
    // Outbox là phụ: không chặn việc học nếu ghi sự kiện lỗi.
  }
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
  // Khóa: thẻ chỉ được chấm 1 lần (kể cả khi đang bay ra mà bấm thêm phím số).
  const answered = useRef(false);
  const flyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (flyTimer.current !== null) window.clearTimeout(flyTimer.current);
    },
    [],
  );

  /** Gửi kết quả; khóa phải được giữ trước khi gọi. */
  const send = useCallback(
    (rating: Grade) => {
      void onAnswer(rating).finally(() => {
        // Lỗi khi lưu: mở khóa để thử lại trên cùng thẻ.
        answered.current = false;
        setLeaving(null);
        setDragX(0);
      });
    },
    [onAnswer],
  );

  const submit = useCallback(
    (rating: Grade) => {
      if (answered.current) return;
      answered.current = true;
      send(rating);
    },
    [send],
  );

  /** Cho thẻ bay sang trái/phải rồi chấm (trái = Quên, phải = Nhớ). Khóa ngay từ lúc bắt đầu bay. */
  const swipe = useCallback(
    (direction: "left" | "right") => {
      if (answered.current) return;
      answered.current = true;
      setLeaving(direction);
      flyTimer.current = window.setTimeout(() => {
        flyTimer.current = null;
        send(direction === "right" ? Rating.Good : Rating.Again);
      }, FLY_MS);
    },
    [send],
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

type ScopeKind = ReviewScope["kind"];

interface OptionsProps {
  db: Db;
  settings: Settings;
  initial: ScopeChoice;
  initialIncludeMastered: boolean;
  onStart: (kind: RoundKind, choice: ScopeChoice, includeMastered: boolean) => void;
  onCancel: () => void;
}

/** Tùy chọn ôn: chọn phạm vi (tất cả / theo chủ đề / chưa có chủ đề), rồi Ôn theo lịch hoặc Luyện tự do. */
function ReviewOptions({ db, settings, initial, initialIncludeMastered, onStart, onCancel }: OptionsProps) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [kind, setKind] = useState<ScopeKind>(initial.scope.kind);
  const [topicIds, setTopicIds] = useState<Set<number>>(
    new Set(initial.scope.kind === "topics" ? initial.scope.topicIds : []),
  );
  const [includeMastered, setIncludeMastered] = useState(initialIncludeMastered);
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

  const start = (round: RoundKind) => onStart(round, { scope, label: label() }, includeMastered);
  const noTopicPicked = kind === "topics" && topicIds.size === 0;
  const todayCount = overview ? overview.dueNow + overview.newTodayLeft : 0;
  const total = overview ? overview.newLeft + overview.learned : 0;
  const freeCount = overview ? (includeMastered ? total : total - overview.mastered) : 0;

  return (
    <section className="stack review-setup card-enter">
      <div className="row">
        <h1>Tùy chọn ôn</h1>
        <button className="push-right" onClick={onCancel}>
          ← Về Ôn hôm nay
        </button>
      </div>

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
        {overview && !noTopicPicked && (
          <p className="muted small">
            {total} từ: 🆕 {overview.newLeft} mới · 📖 {overview.learned - overview.mastered} đang học · ✅ {overview.mastered}{" "}
            vững
          </p>
        )}
      </div>

      <div className="card stack">
        {noTopicPicked ? (
          <p className="muted small">Chọn ít nhất 1 chủ đề.</p>
        ) : overview === null ? (
          <p className="muted small">Đang đếm…</p>
        ) : total === 0 ? (
          <p className="muted small">Phạm vi này chưa có từ nào có nghĩa để ôn.</p>
        ) : (
          <div className="setup-actions">
            <button className="setup-action primary" onClick={() => start("today")} disabled={todayCount === 0}>
              <strong>▶️ Ôn theo lịch</strong>
              <span>
                {todayCount > 0 ? `${todayCount} từ đến hạn / từ mới hôm nay` : "Phạm vi này hôm nay đã ôn xong"} · tính vào lịch
              </span>
            </button>
            <div className="stack">
              <button className="setup-action" onClick={() => start("free")} disabled={freeCount === 0}>
                <strong>🏋️ Luyện tự do</strong>
                <span>
                  Đi hết {freeCount} từ, mỗi lượt {settings.sessionSize} · không đổi lịch
                </span>
              </button>
              <label className="row small">
                <input
                  type="checkbox"
                  checked={includeMastered}
                  onChange={(e) => setIncludeMastered(e.target.checked)}
                />
                Gồm cả từ ✅ Vững ({overview.mastered})
              </label>
            </div>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </section>
  );
}

interface SummaryProps {
  round: Round | null;
  results: Result[];
  overview: ReviewOverview;
  /** Từ cũ trong phạm vi chưa gặp ở "Ôn từ vựng cũ" (lần mở app này). */
  oldLeft: number;
  settings: Settings;
  /** Nhãn phạm vi đang ôn (vd. "Chủ đề: Động từ"). */
  scopeLabel: string;
  /** Số từ còn lại trong "Luyện tự do". */
  freeLeft: number;
  onChoose: (kind: RoundKind) => void;
  onOptions: () => void;
}

function formatDay(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString("vi-VN", { weekday: "long", day: "numeric", month: "numeric" });
}

function RoundSummary({
  round,
  results,
  overview,
  oldLeft,
  settings,
  scopeLabel,
  freeLeft,
  onChoose,
  onOptions,
}: SummaryProps) {
  const forgotten = results.filter((r) => r.rating === Rating.Again).map((r) => r.item);
  const remembered = results.length - forgotten.length;
  // Linh vật khen/động viên dạng thông báo; đóng được, tự ẩn sau vài giây.
  const [showMascot, setShowMascot] = useState(results.length > 0);
  const [copyMessage, setCopyMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const todayLeft = overview.dueNow + overview.newTodayLeft;
  const newBatch = Math.min(settings.sessionSize, overview.newLeft);

  async function copyPrompt() {
    try {
      await writeText(buildMistakesPrompt(forgotten, settings.level));
      setCopyMessage({ kind: "ok", text: "Đã copy. Dán vào ChatGPT để đọc giải thích." });
    } catch (e) {
      setCopyMessage({ kind: "error", text: `Không copy được: ${String(e)}` });
    }
  }

  return (
    <section className="stack session-end card-enter">
      {results.length > 0 && <Confetti />}
      {showMascot && (
        <MascotToast
          mascot={settings.mascot}
          remembered={remembered}
          total={results.length}
          onClose={() => setShowMascot(false)}
        />
      )}
      <div className="row">
        <h1>Ôn tập</h1>
        <span className="badge scope-badge">{scopeLabel}</span>
        <button className="push-right" onClick={onOptions}>
          ⚙️ Tùy chọn
        </button>
      </div>

      {results.length > 0 && (
        <>
          <p className="session-title">Xong lượt! 🎉</p>
          <div className="stat-tiles">
            <StatTile label="Thẻ" value={results.length} />
            <StatTile label="Nhớ" value={remembered} tone="good" />
            <StatTile label="Quên" value={forgotten.length} tone="bad" />
            <StatTile label="Tỉ lệ nhớ" value={`${Math.round((remembered / results.length) * 100)}%`} />
          </div>
        </>
      )}

      {todayLeft === 0 && (
        <div className="all-done card stack">
          <p className="session-title">✅ Hôm nay xong rồi!</p>
          <p className="muted small">
            {overview.nextDue
              ? `Đợt ôn tiếp theo: ${formatDay(overview.nextDue.date)} — ${overview.nextDue.count} từ đến hạn.`
              : "Chưa có lịch ôn nào. Học thêm từ mới để bắt đầu."}
          </p>
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
          {round?.kind === "free" && freeLeft > 0 && (
            <button className="primary" onClick={() => onChoose("free")}>
              🏋️ Luyện tiếp (còn {freeLeft} từ)
            </button>
          )}
          {todayLeft > 0 && (
            <button className={forgotten.length === 0 ? "primary" : ""} onClick={() => onChoose("today")}>
              ▶️ Ôn tiếp hôm nay ({todayLeft} từ)
            </button>
          )}
          {overview.newLeft > 0 && (
            <button onClick={() => onChoose("new")}>✨ Học thêm {newBatch} từ mới (còn {overview.newLeft})</button>
          )}
          {overview.learned > 0 && (
            <button onClick={() => onChoose("old")}>
              📚 Ôn từ vựng cũ{" "}
              {oldLeft > 0 ? `(còn ${oldLeft} từ chưa ôn)` : "(đã ôn hết — bắt đầu vòng mới)"}
            </button>
          )}
        </div>
        <p className="muted small">
          "Ôn hôm nay" và "Học thêm từ mới" tính vào lịch. Ôn lại từ quên / từ vựng cũ / luyện tự do chỉ để luyện, không đổi lịch.
        </p>
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
