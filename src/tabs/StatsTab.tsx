import { useEffect, useState } from "react";
import type { Db } from "../db/db";
import { loadStats, type VocabStats } from "../stats/stats";

const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

export default function StatsTab({ db }: { db: Db }) {
  const [stats, setStats] = useState<VocabStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadStats(db)
      .then((s) => !cancelled && setStats(s))
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [db]);

  if (error) return <p className="error">Lỗi khi tải thống kê: {error}</p>;
  if (!stats) return <p className="muted">Đang tải…</p>;

  const reviews = stats.days.reduce((n, d) => n + d.total, 0);
  const correct = stats.days.reduce((n, d) => n + d.correct, 0);

  return (
    <section className="stack stats">
      <h1>Thống kê</h1>

      <div className="stat-tiles">
        <Tile label="Tổng số từ" value={stats.totalWords} />
        <Tile label="Đã nhớ vững" value={stats.mastered} tone="good" />
        <Tile label="Đang học" value={stats.learning} />
        <Tile label="Chờ bổ sung" value={stats.pending} />
        <Tile label="Thẻ đến hạn hôm nay" value={stats.dueToday} />
      </div>

      {stats.totalWords > 0 && <StatusBar stats={stats} />}
      {stats.notReady > 0 && (
        <p className="muted small">{stats.notReady} từ chưa đủ chữ Hán/kana và nghĩa nên chưa vào ôn.</p>
      )}

      <div className="card stack">
        <div className="row">
          <h2>Lượt ôn 7 ngày qua</h2>
          <span className="muted small push-right">
            {reviews} lượt · đúng {reviews === 0 ? 0 : Math.round((correct / reviews) * 100)}%
          </span>
        </div>
        <DayChart days={stats.days} />
      </div>

      <div className="stats-columns">
        <div className="card stack">
          <h2>Từ theo chủ đề</h2>
          <TopicBars topics={stats.topics} noTopic={stats.noTopic} />
        </div>
        <div className="card stack">
          <h2>Từ hay sai nhất</h2>
          {stats.hardest.length === 0 ? (
            <p className="muted small">Chưa có lượt ôn sai nào.</p>
          ) : (
            <table className="stats-table small">
              <thead>
                <tr>
                  <th>Từ</th>
                  <th>Sai</th>
                  <th>Lượt ôn</th>
                </tr>
              </thead>
              <tbody>
                {stats.hardest.map((h) => (
                  <tr key={h.wordId}>
                    <td>
                      <span className="jp">{h.term}</span>
                      {h.reading && <span className="jp muted"> {h.reading}</span>}
                    </td>
                    <td className="num bad-text">{h.wrong}</td>
                    <td className="num">{h.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: "good" }) {
  return (
    <div className={`stat-tile ${tone ?? ""}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/** Thanh tỉ lệ trạng thái, có chú thích kèm số (không chỉ dựa vào màu). */
function StatusBar({ stats }: { stats: VocabStats }) {
  const parts = [
    { key: "mastered", label: "Vững", value: stats.mastered },
    { key: "learning", label: "Đang học", value: stats.learning },
    { key: "pending", label: "Chờ bổ sung", value: stats.pending },
  ].filter((p) => p.value > 0);
  return (
    <div className="stack small">
      <div className="status-bar">
        {parts.map((p) => (
          <div
            key={p.key}
            className={`status-seg ${p.key}`}
            style={{ flexGrow: p.value }}
            title={`${p.label}: ${p.value} từ`}
          />
        ))}
      </div>
      <div className="row legend">
        {parts.map((p) => (
          <span key={p.key} className="row">
            <span className={`legend-dot ${p.key}`} />
            {p.label} {p.value} ({Math.round((p.value / stats.totalWords) * 100)}%)
          </span>
        ))}
      </div>
    </div>
  );
}

function DayChart({ days }: { days: VocabStats["days"] }) {
  const max = Math.max(1, ...days.map((d) => d.total));
  return (
    <div className="day-chart">
      {days.map((d) => {
        const date = new Date(`${d.date}T00:00:00`);
        const rate = d.total === 0 ? null : Math.round((d.correct / d.total) * 100);
        return (
          <div key={d.date} className="day-col" title={`${d.date}: ${d.total} lượt, đúng ${d.correct}`}>
            <span className="day-value">{d.total > 0 ? d.total : ""}</span>
            <div className="day-track">
              <div className="day-bar" style={{ height: `${(d.total / max) * 100}%` }} />
            </div>
            <span className="day-label">
              {WEEKDAYS[date.getDay()]} {date.getDate()}/{date.getMonth() + 1}
            </span>
            <span className="day-rate muted">{rate === null ? "–" : `${rate}%`}</span>
          </div>
        );
      })}
    </div>
  );
}

function TopicBars({ topics, noTopic }: { topics: VocabStats["topics"]; noTopic: number }) {
  const rows = [...topics.map((t) => ({ key: String(t.id), name: t.name, count: t.count })), {
    key: "none",
    name: "Không có chủ đề",
    count: noTopic,
  }];
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="topic-bars small">
      {rows.map((r) => (
        <div key={r.key} className="topic-bar-row" title={`${r.name}: ${r.count} từ`}>
          <span className={r.key === "none" ? "muted" : ""}>{r.name}</span>
          <div className="topic-track">
            <div className="topic-fill" style={{ width: `${(r.count / max) * 100}%` }} />
          </div>
          <span className="num">{r.count}</span>
        </div>
      ))}
    </div>
  );
}
