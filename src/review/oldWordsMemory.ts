import { shuffle, type ReviewItem, type ReviewScope, type Rng } from "./review";

/**
 * "Ôn từ vựng cũ" nhớ các từ đã gặp **trong lần mở app này**, riêng cho từng phạm vi ôn
 * (biến cấp module: giữ khi đổi tab, mất khi tắt app). Mỗi lượt chỉ bốc từ chưa gặp, thứ tự xáo trộn;
 * gặp hết thì sang vòng mới, và lượt đầu vòng mới tránh các từ của lượt ngay trước nếu còn đủ từ khác.
 */
interface Memory {
  seen: Set<number>;
  lastRound: Set<number>;
}

const memories = new Map<string, Memory>();

function scopeKey(scope: ReviewScope): string {
  return scope.kind === "topics" ? `topics:${[...new Set(scope.topicIds)].sort((a, b) => a - b).join(",")}` : scope.kind;
}

function memoryFor(scope: ReviewScope): Memory {
  const key = scopeKey(scope);
  let memory = memories.get(key);
  if (!memory) {
    memory = { seen: new Set(), lastRound: new Set() };
    memories.set(key, memory);
  }
  return memory;
}

export interface OldWordsPick {
  items: ReviewItem[];
  /** true nếu vừa gặp hết từ cũ nên bắt đầu lại vòng mới. */
  newCycle: boolean;
}

/** `pool` = các từ đã học trong `scope`. */
export function pickOldWords(scope: ReviewScope, pool: ReviewItem[], size: number, rng: Rng = Math.random): OldWordsPick {
  const memory = memoryFor(scope);
  let candidates = pool.filter((i) => !memory.seen.has(i.cardId));
  let newCycle = false;
  if (candidates.length === 0 && pool.length > 0) {
    memory.seen.clear();
    newCycle = true;
    // Đầu vòng mới: để các từ vừa ôn ở lượt trước xuống cuối.
    const fresh = shuffle(pool.filter((i) => !memory.lastRound.has(i.cardId)), rng);
    const recent = shuffle(pool.filter((i) => memory.lastRound.has(i.cardId)), rng);
    candidates = [...fresh, ...recent];
  } else {
    candidates = shuffle(candidates, rng);
  }
  const items = candidates.slice(0, Math.max(0, size));
  for (const i of items) memory.seen.add(i.cardId);
  memory.lastRound = new Set(items.map((i) => i.cardId));
  return { items, newCycle };
}

/** Số từ trong `pool` (từ đã học của `scope`) chưa gặp ở vòng hiện tại. */
export function countUnseenOldWords(scope: ReviewScope, pool: ReviewItem[]): number {
  const memory = memories.get(scopeKey(scope));
  return memory ? pool.filter((i) => !memory.seen.has(i.cardId)).length : pool.length;
}

/** Xóa bộ nhớ (dùng trong test). */
export function resetOldWordsMemory(): void {
  memories.clear();
}
