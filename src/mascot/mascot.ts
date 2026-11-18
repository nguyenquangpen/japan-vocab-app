/** Linh vật hiện trong thông báo cuối lượt ôn. */
export const MASCOTS = [
  { id: "cat", name: "Mèo Tama", emoji: "🐱" },
  { id: "shiba", name: "Chó Shiba", emoji: "🐶" },
  { id: "fox", name: "Cáo Kitsune", emoji: "🦊" },
  { id: "panda", name: "Gấu trúc Pan", emoji: "🐼" },
  { id: "frog", name: "Ếch Kero", emoji: "🐸" },
] as const;

export type MascotId = (typeof MASCOTS)[number]["id"];
export type Mascot = (typeof MASCOTS)[number];

export const DEFAULT_MASCOT: MascotId = "cat";

export function isMascotId(value: unknown): value is MascotId {
  return MASCOTS.some((m) => m.id === value);
}

export function getMascot(id: MascotId): Mascot {
  return MASCOTS.find((m) => m.id === id) ?? MASCOTS[0];
}

export interface MascotMessage {
  perfect: boolean;
  title: string;
  text: string;
}

const PERFECT: readonly Omit<MascotMessage, "perfect">[] = [
  { title: "Hoàn hảo!", text: "Nhớ hết sạch không sót thẻ nào. Giỏi quá!" },
  { title: "Tuyệt đối!", text: "100% luôn! Trí nhớ siêu đỉnh đó nha." },
  { title: "Xuất sắc!", text: "Không quên chữ nào. Cứ giữ phong độ này nhé!" },
  { title: "すごい！", text: "Lượt ôn trọn vẹn. Tự thưởng cho mình một tràng vỗ tay nào!" },
];

const GOOD: readonly Omit<MascotMessage, "perfect">[] = [
  { title: "Làm tốt lắm!", text: "Nhớ được phần lớn rồi, mấy từ còn lại sẽ quen thôi." },
  { title: "Gần như trọn vẹn!", text: "Chỉ sót vài thẻ, lần sau chắc chắn thuộc hết." },
  { title: "Tiến bộ rõ!", text: "Kết quả rất ổn. Ôn đều đặn là thành thạo ngay." },
];

const KEEP_GOING: readonly Omit<MascotMessage, "perfect">[] = [
  { title: "Cố lên nào!", text: "Quên là bước đầu của nhớ lâu. Mình ôn lại sau nhé!" },
  { title: "Không sao đâu!", text: "Từ khó cần thêm vài lần gặp. Kiên trì là sẽ thuộc." },
  { title: "Từ từ mà chắc!", text: "Mỗi lượt ôn đều giúp trí nhớ bền hơn. Tiếp tục nha!" },
];

/** Chọn lời nhắn theo tỉ lệ nhớ: trọn vẹn / từ 70% / dưới 70%. */
export function pickMascotMessage(remembered: number, total: number, rng: () => number = Math.random): MascotMessage {
  const perfect = total > 0 && remembered === total;
  const pool = perfect ? PERFECT : total > 0 && remembered / total >= 0.7 ? GOOD : KEEP_GOING;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return { perfect, ...pool[index] };
}
