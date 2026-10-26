# Thiết kế kỹ thuật – Japanese Vocab App (phiên bản đầu)

Tài liệu này là bản đã cắt gọn từ `docs/spec.md` cho phiên bản đầu. Mọi thứ không có ở đây thì chưa làm.

## 1. Các quyết định đã chốt

| Vấn đề | Quyết định |
|---|---|
| Người dùng | 1 người, không đăng nhập, không phân quyền |
| Nền tảng | App desktop (Tauri v2), không web, không mobile |
| Lưu trữ | 1 file SQLite trong thư mục dữ liệu của app. Chưa làm backup |
| AI | Không gọi API. Dùng luồng copy–paste với ChatGPT (mục 5) |
| Lịch ôn | FSRS (`ts-fsrs`), retention mục tiêu 0.9 |
| Kỹ năng theo dõi | `meaning` (nghĩa) và `reading` (cách đọc). Mỗi từ × kỹ năng = 1 thẻ |
| Chủ đề | Dạng tag, quan hệ nhiều–nhiều |
| Mạng | Không có bất kỳ kết nối mạng nào |

## 2. Mô hình dữ liệu (SQLite)

```sql
CREATE TABLE words (
  id            INTEGER PRIMARY KEY,
  term          TEXT NOT NULL,          -- 食べる
  reading       TEXT,                   -- たべる (kana)
  meanings_vi   TEXT,                   -- JSON array: ["ăn"]
  part_of_speech TEXT,
  usage_note    TEXT,
  confusables   TEXT,                   -- JSON array: [{"term": "...", "note": "..."}]
  user_note     TEXT,
  enriched      INTEGER NOT NULL DEFAULT 0, -- đã có dữ liệu AI chưa
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (term, reading)
);

CREATE TABLE examples (
  id        INTEGER PRIMARY KEY,
  word_id   INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  ja        TEXT NOT NULL,
  reading   TEXT,
  vi        TEXT
);

CREATE TABLE topics (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE word_topics (
  word_id  INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (word_id, topic_id)
);

-- 1 thẻ = 1 từ × 1 kỹ năng. Các cột trạng thái lấy theo kiểu Card của ts-fsrs.
CREATE TABLE cards (
  id             INTEGER PRIMARY KEY,
  word_id        INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  skill          TEXT NOT NULL CHECK (skill IN ('meaning', 'reading')),
  due            TEXT NOT NULL,
  stability      REAL NOT NULL,
  difficulty     REAL NOT NULL,
  elapsed_days   INTEGER NOT NULL,
  scheduled_days INTEGER NOT NULL,
  reps           INTEGER NOT NULL,
  lapses         INTEGER NOT NULL,
  state          INTEGER NOT NULL,
  last_review    TEXT,
  UNIQUE (word_id, skill)
);

CREATE TABLE review_logs (
  id          INTEGER PRIMARY KEY,
  card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rating      INTEGER NOT NULL,   -- Rating của ts-fsrs
  answer      TEXT,               -- câu người dùng gõ (với reading)
  correct     INTEGER NOT NULL,
  reviewed_at TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- settings mặc định: new_per_day=10, max_reviews_per_session=100, level=N5
```

Ghi chú:
- Khi tạo từ mới, tự tạo 2 thẻ (`meaning`, `reading`) bằng `createEmptyCard()`.
- Từ chỉ viết kana (ありがとう) vẫn có thẻ `reading`, nhưng màn ôn kỹ năng này hiển thị nghĩa và yêu cầu gõ từ (vì không có kanji để đọc). Nếu thấy rối thì bỏ thẻ `reading` cho từ toàn kana.
- Migration: dùng cơ chế migration của plugin sql, đánh số phiên bản.

## 3. Nhập từ

- **Từng từ:** ô nhập `term`, Enter là lưu. Các trường khác (reading, nghĩa, ghi chú, chủ đề) tùy chọn, có thể điền sau.
- **Hàng loạt:** dán văn bản, mỗi dòng một từ. Cho phép dạng `term`, `term reading`, hoặc `term | reading | nghĩa`. Chọn chủ đề áp cho cả lô.
- **Trùng từ:** chuẩn hóa `term` (trim, NFKC) trước khi kiểm tra. Nếu đã có, báo và bỏ qua (hàng loạt) hoặc mở từ cũ (từng từ).
- Từ mới vào có `enriched = 0`, hiện trong danh sách "Chờ bổ sung".

## 4. Ôn tập

### Luồng phiên học
1. Mở app → vào thẳng màn ôn nếu có thẻ đến hạn.
2. Thẻ đến hạn sắp theo `due` tăng dần, tối đa `max_reviews_per_session`.
3. Sau đó là thẻ mới, tối đa `new_per_day` **từ** mới mỗi ngày (mỗi từ 2 thẻ).
4. Hết phiên: hiện thống kê ngắn + nút "Copy prompt giải thích lỗi sai" (mục 5.3).

### Cách chấm theo kỹ năng
- **meaning:** hiện `term` (+ reading nếu là thẻ đã học ở kỹ năng reading) → bấm/Space để lật → tự chấm. Giao diện mặc định 2 nút **Quên (1) / Nhớ (2)** ánh xạ sang `Again` / `Good`. Có thể bật 4 nút đầy đủ trong settings.
- **reading:** hiện `term` → gõ cách đọc. Gõ romaji tự đổi sang hiragana bằng `wanakana` (bind vào ô nhập). So sánh sau khi chuẩn hóa: chuyển katakana → hiragana, bỏ khoảng trắng. Đúng → `Good`, sai → `Again`, hiện đáp án đúng.
- Toàn bộ thao tác ôn làm được bằng bàn phím.

### Quiz tự chọn theo chủ đề
- Chọn 1 hoặc nhiều chủ đề → trắc nghiệm nghĩa, 4 đáp án, đáp án nhiễu lấy ngẫu nhiên từ kho của chính tôi (ưu tiên cùng chủ đề).
- **Quiz tự chọn không cập nhật lịch FSRS**, chỉ ghi kết quả để xem lại. Lịch ôn chỉ do màn ôn chính quyết định.

### "Đã nhớ vững"
Một từ được đánh dấu vững khi cả 2 thẻ có `stability >= 21` (ngày). Dùng để hiển thị và lọc, không ảnh hưởng lịch.

## 5. Luồng AI copy–paste

### 5.1. Bổ sung thông tin từ
1. Màn "Chờ bổ sung" → chọn các từ (mặc định tất cả, tối đa ~30 từ/lô) → nút **Copy prompt**.
2. App sinh prompt (mẫu ở 5.4) chứa danh sách từ, trình độ `level`, và yêu cầu chỉ trả về JSON.
3. Tôi dán vào ChatGPT, copy kết quả, dán lại vào ô **Dán kết quả**.
4. App:
   - Bỏ phần ```json fence nếu có, `JSON.parse`, kiểm tra bằng schema `zod` (5.5).
   - Ghép theo `term` với các từ trong lô. Từ không khớp → báo, bỏ qua.
   - Hiện **bản xem trước** từng từ. Trường nào tôi đã tự nhập thì giữ nguyên, AI chỉ điền trường trống (hiển thị gợi ý của AI bên cạnh để tôi chọn ghi đè nếu muốn).
   - Bấm **Lưu** → cập nhật DB, đặt `enriched = 1`.
5. Lỗi parse/schema → hiện lỗi dễ hiểu, không lưu gì.

### 5.2. Hiển thị
Mọi chuỗi từ AI hiển thị dạng text thuần. Không render markdown/HTML.

### 5.3. Giải thích lỗi sai cuối phiên
Nút copy prompt gồm các từ trả lời sai trong phiên (term, reading đúng, nghĩa đúng, câu tôi đã gõ) và yêu cầu giải thích + phân biệt từ dễ nhầm. **Không cần dán kết quả lại vào app**, tôi đọc trực tiếp trên ChatGPT.

### 5.4. Mẫu prompt bổ sung từ

```
Bạn là giáo viên tiếng Nhật cho người Việt, trình độ học viên: {level}.
Với mỗi từ dưới đây, trả về thông tin theo đúng định dạng JSON ở cuối.
Yêu cầu:
- reading: chỉ dùng hiragana (katakana nếu là từ ngoại lai).
- meanings_vi: 1–3 nghĩa tiếng Việt ngắn gọn, nghĩa phổ biến nhất đứng đầu.
- examples: 2 câu ví dụ ngắn, ngữ pháp không vượt quá trình độ {level}.
- usage_note: 1–2 câu về cách dùng, sắc thái.
- confusables: tối đa 2 từ dễ nhầm, kèm 1 câu phân biệt. Không có thì để [].
Chỉ trả về JSON, không giải thích thêm, không dùng markdown.

Danh sách từ:
{mỗi dòng một term}

Định dạng:
{"words":[{"term":"","reading":"","meanings_vi":[""],"part_of_speech":"","examples":[{"ja":"","reading":"","vi":""}],"usage_note":"","confusables":[{"term":"","note":""}]}]}
```

### 5.5. Schema kiểm tra (zod, mô tả)
- `words`: mảng, 1–50 phần tử.
- `term`: chuỗi 1–30 ký tự.
- `reading`: chuỗi chỉ gồm hiragana/katakana/ー, tối đa 50 ký tự.
- `meanings_vi`: mảng 1–5 chuỗi, mỗi chuỗi tối đa 100 ký tự.
- `examples`: mảng 0–3 phần tử, `ja`/`vi` tối đa 200 ký tự.
- `usage_note`: tối đa 500 ký tự. `confusables`: mảng 0–3.
- Trường thừa: bỏ qua. Vượt giới hạn: báo lỗi.

## 6. Chủ đề

- Tạo, đổi tên, xóa chủ đề (xóa chủ đề không xóa từ).
- Gắn/gỡ một từ vào nhiều chủ đề. Gắn hàng loạt từ danh sách đang lọc.
- Danh sách từ: tìm theo term/reading/nghĩa, lọc theo chủ đề, trạng thái (chờ bổ sung / đang học / vững).

## 7. Giao diện (tối giản)

Thanh điều hướng 4 mục: **Ôn tập** · **Thêm từ** · **Kho từ** · **Cài đặt**.
- Ôn tập: màn mặc định khi mở app.
- Thêm từ: nhập từng từ, nhập hàng loạt, khu "Chờ bổ sung" với luồng copy–paste.
- Kho từ: danh sách, tìm/lọc, sửa từ, quản lý chủ đề, quiz theo chủ đề.
- Cài đặt: level, new_per_day, max_reviews_per_session, kiểu nút chấm (2 hoặc 4).

Font hiển thị tiếng Nhật rõ ràng (ví dụ Noto Sans JP hoặc font hệ thống), cỡ chữ term lớn ở màn ôn.

## 8. An toàn

- Tauri capabilities: chỉ cấp `sql` (cho DB của app) và `clipboard-manager` (ghi clipboard khi copy prompt). Không shell, không http, không fs ngoài thư mục app.
- CSP: `default-src 'self'`, không cho script ngoài, không `unsafe-eval`.
- Không mở cổng, không server local, không request mạng.
- Nội dung dán vào: chỉ qua `zod`, chỉ hiển thị text thuần.
- SQL luôn tham số hóa.

## 9. Lộ trình

1. **Khung dự án:** Tauri v2 + React + TS + Vite, plugin sql, migration tạo bảng, cấu hình capabilities + CSP. Màn hình rỗng với 4 tab.
2. **Nhập từ + Kho từ:** thêm từng từ, hàng loạt, chống trùng, danh sách, sửa, xóa.
3. **Luồng copy–paste bổ sung từ:** sinh prompt, dán, kiểm tra schema, xem trước, lưu.
4. **Ôn tập FSRS:** tạo thẻ, màn ôn meaning + reading, ghi review_logs, giới hạn mỗi ngày.
5. **Chủ đề + quiz theo chủ đề.**
6. **Prompt giải thích lỗi sai cuối phiên + màn Cài đặt.**

## 10. Chưa làm (để sau)

Backup, đồng bộ, mobile, kỹ năng viết, câu điền từ vào ngữ cảnh, quiz do AI sinh, gọi API AI tự động, furigana, pitch accent, thống kê nâng cao.
