# Tích hợp App học tiếng Nhật → Personal Productivity Hub

> **Dành cho:** Agent/dev đang làm việc trong codebase của **app học tiếng Nhật** (desktop, chạy cùng laptop với Hub).
> **Phiên bản hợp đồng:** v1 — 2026-11-07. Nguồn: Product Spec §12 của Hub.
> **Trạng thái phía Hub (cập nhật 2026-11-18):** endpoint nhận sự kiện **đã hoạt động** từ Hub 0.2.x, đúng hợp đồng v1 này. Vẫn nên kiểm thử bằng Hub giả lập (mục 9) cho các tình huống lỗi; khi Hub đang tắt, app phải tự giữ sự kiện và gửi lại sau — không mất dữ liệu.
>
> **Để kết nối thật, app cần 3 giá trị** (chủ sở hữu lấy trong Hub → trang **Tích hợp**):
> - `HUB_URL` = `http://127.0.0.1:4317`
> - `source.app_id` = `japanese-learning-app` (phải đúng chuỗi này — đã đăng ký trong Hub)
> - `HUB_API_KEY` = key tạo ở trang Tích hợp (dạng `pph_…`, chỉ hiển thị một lần)

---

## 1. Bối cảnh — app cần hiểu gì về Hub

Personal Productivity Hub là app desktop cá nhân (cùng một người dùng, cùng một laptop) quản lý mục tiêu, công việc, điểm thưởng XP và chuỗi ngày hoạt động. Hub muốn **tự động** ghi nhận việc học tiếng Nhật thay vì để người dùng nhập tay.

Phân vai:

| App tiếng Nhật | Hub |
|---|---|
| Ghi lại **sự kiện đã xảy ra** (học xong N từ, xong bài học, xong phiên học) và gửi cho Hub | Quyết định sự kiện nào được chấp nhận, ánh xạ vào Goal nào, cộng tiến độ/XP/Streak ra sao |
| Đảm bảo **không mất** sự kiện và **không gửi trùng** về mặt nghiệp vụ | Chống cộng trùng bằng `event_id` |
| Không biết gì về Goal, XP, Level của Hub | Không đọc/ghi dữ liệu của app tiếng Nhật |

**Nguyên tắc quan trọng nhất:** app chỉ gửi **sự thật đã xảy ra**. App **không** tính, gửi hay sửa XP, phần trăm tiến độ, Goal ID hay bất kỳ khái niệm nào của Hub.

---

## 2. Phạm vi công việc phía app

Cần xây (bằng stack/ngôn ngữ hiện có của app — hãy đọc codebase trước để chọn cách phù hợp):

1. **Phát sự kiện** tại đúng những chỗ trong app mà việc học thực sự hoàn tất (mục 5, 6).
2. **Outbox bền vững**: lưu sự kiện vào bộ nhớ lâu dài của app *trước* khi gửi; sống sót qua tắt app/crash/mất điện.
3. **Bộ gửi nền**: gửi lần lượt các sự kiện trong outbox tới Hub, retry có backoff, phân loại lỗi đúng cách (mục 7).
4. **Heartbeat**: báo cho Hub biết app vẫn đang được dùng (mục 6.4).
5. **Cấu hình**: địa chỉ Hub, API key, bật/tắt tích hợp (mục 8).
6. **Hiển thị trạng thái tối thiểu** (khuyến nghị): số sự kiện đang chờ gửi, lần gửi thành công gần nhất, lỗi cấu hình nếu có.

Ngoài phạm vi: mọi logic về Goal/XP/Streak; giao diện của Hub; đọc dữ liệu từ Hub.

---

## 3. Endpoint

```
POST http://127.0.0.1:4317/api/v1/integrations/events
Content-Type: application/json; charset=utf-8
Authorization: Bearer <HUB_API_KEY>
```

- Hub **chỉ** lắng nghe trên `127.0.0.1` (không qua mạng LAN/Internet). Không dùng `localhost` nếu runtime có thể phân giải ra IPv6 `::1` — dùng đúng `127.0.0.1`.
- Mỗi request gửi **một** sự kiện. Gửi tuần tự, không gửi song song.
- Timeout mỗi request: 10 giây.

---

## 4. Event Envelope (định dạng chung)

```json
{
  "event_id": "3f6c2a8e-6a2b-4d0e-9a51-2a0f1c9b7e11",
  "event_type": "vocabulary.learned",
  "schema_version": 1,
  "source": { "app_id": "japanese-learning-app", "app_version": "1.4.2" },
  "subject": { "type": "vocabulary_batch", "external_id": "batch-2026-11-07-0930" },
  "data": { "count": 20, "level": "N3" },
  "occurred_at": "2026-11-07T09:30:00+07:00",
  "recorded_at": "2026-11-07T09:30:02+07:00",
  "metadata": {}
}
```

| Field | Kiểu | Bắt buộc | Quy tắc |
|---|---|---|---|
| `event_id` | string UUID v4 | ✔ | Sinh **một lần** khi sự kiện được tạo, lưu cùng sự kiện trong outbox. **Không bao giờ sinh lại khi retry.** Đây là khóa chống trùng của Hub. |
| `event_type` | string | ✔ | Một trong các loại ở mục 6. |
| `schema_version` | integer | ✔ | Luôn `1` cho hợp đồng này. |
| `source.app_id` | string | ✔ | Cố định: `"japanese-learning-app"`. |
| `source.app_version` | string | ✔ | Version của app tiếng Nhật. |
| `subject.type` | string | ✔ | Theo từng loại sự kiện (mục 6). |
| `subject.external_id` | string | ✔ | ID ổn định **phía app** của đối tượng (bài học, phiên học, lô từ vựng). ≤ 200 ký tự. |
| `data` | object | ✔ | Theo từng loại sự kiện (mục 6). Không thêm trường ngoài đặc tả. |
| `occurred_at` | string ISO 8601 **có offset** | ✔ | Thời điểm việc học **thực sự xảy ra** (theo đồng hồ máy). Không được là thời điểm gửi. |
| `recorded_at` | string ISO 8601 có offset | ✔ | Thời điểm app ghi sự kiện vào outbox. Không đổi khi retry. |
| `metadata` | object | — | Tùy chọn, dùng để debug; Hub không dựa vào để xử lý nghiệp vụ. ≤ 2 KB. |

Kích thước toàn bộ body ≤ 64 KB. Encoding UTF-8 (tiếng Nhật trong `words`/`title` gửi nguyên văn).

> Vì sao phân biệt `occurred_at` và `recorded_at`: sự kiện có thể được gửi trễ nhiều ngày (Hub tắt, máy offline). Hub dùng `occurred_at` để tính đúng ngày học cho Streak, nên **phải** là thời điểm thật.

---

## 5. Khi nào phát sự kiện — quy tắc chung

- Chỉ phát khi việc học **đã hoàn tất** (người dùng xong bài, xong phiên, từ chuyển sang trạng thái "đã thuộc" theo định nghĩa của app). Không phát khi mở app, mở bài, hay xem lại không có kết quả.
- **Mỗi sự việc thật = đúng một sự kiện.** Nếu cùng một hành động có thể được xử lý lại (ví dụ đồng bộ lại, mở lại màn hình kết quả), phải đảm bảo không tạo sự kiện mới — dùng `subject.external_id` ổn định và kiểm tra outbox trước khi tạo.
- **Gom theo lô hợp lý** thay vì mỗi từ một sự kiện: ví dụ một sự kiện `vocabulary.learned` cho cả phiên/lô vừa học xong.
- Nếu app có database: ghi sự kiện vào outbox **trong cùng transaction** với việc lưu kết quả học. Nếu không có transaction, ghi outbox ngay sau khi lưu kết quả thành công và trước khi báo xong cho người dùng.
- **Không có sự kiện đảo ngược ở v1.** Nếu người dùng hoàn tác/xóa tiến độ trong app, **không** gửi gì cho Hub (Hub sẽ có cơ chế riêng nếu cần ở phiên bản sau).
- Ghi lại trong tài liệu của app (README hoặc comment) chính xác định nghĩa "đã thuộc", "xong bài", "xong phiên" mà app dùng — Hub sẽ cấu hình mapping dựa trên đó.

---

## 6. Các loại sự kiện

### 6.1 `vocabulary.learned` — học xong từ vựng mới

`subject`: `{ "type": "vocabulary_batch", "external_id": "<id lô/phiên ổn định>" }`

| `data` field | Kiểu | Bắt buộc | Quy tắc |
|---|---|---|---|
| `count` | integer | ✔ | Số từ **mới** đạt trạng thái "đã thuộc" trong lô này, 1–1000. Không đếm từ ôn lại đã thuộc từ trước. |
| `level` | string | — | `N5`, `N4`, `N3`, `N2`, `N1` hoặc bỏ trống nếu lô lẫn nhiều cấp. |
| `deck` | string | — | Tên bộ từ/chủ đề, ≤ 100 ký tự. |
| `words` | string[] | — | Tối đa 100 từ, mỗi từ ≤ 50 ký tự. Chỉ để hiển thị lịch sử; có thể bỏ. |

### 6.2 `lesson.completed` — hoàn thành một bài học

`subject`: `{ "type": "lesson", "external_id": "<lesson id của app>" }`

| `data` field | Kiểu | Bắt buộc | Quy tắc |
|---|---|---|---|
| `title` | string | ✔ | Tên bài, ≤ 200 ký tự. |
| `duration_minutes` | integer | — | 1–1440. |
| `score` | number | — | 0–100 nếu bài có chấm điểm. |
| `level` | string | — | `N5`…`N1`. |

Nếu người dùng học lại cùng một bài: là một lần hoàn thành mới → sự kiện mới với `event_id` mới; `subject.external_id` có thể giữ là lesson id (Hub phân biệt bằng `event_id` + `occurred_at`).

### 6.3 `learning.session.completed` — kết thúc một phiên học

`subject`: `{ "type": "session", "external_id": "<session id của app>" }`

| `data` field | Kiểu | Bắt buộc | Quy tắc |
|---|---|---|---|
| `duration_minutes` | integer | ✔ | Thời gian học thực tế, 1–1440. Không tính thời gian treo/không hoạt động nếu app biết. |
| `activity` | string | ✔ | `vocabulary` \| `kanji` \| `grammar` \| `listening` \| `reading` \| `mixed` \| `other`. |
| `started_at` | string ISO 8601 có offset | ✔ | |
| `ended_at` | string ISO 8601 có offset | ✔ | Bằng `occurred_at`. |
| `items_reviewed` | integer | — | Số thẻ/câu đã làm trong phiên, ≥ 0. |

Phiên < 1 phút: không gửi.

### 6.4 `external_app.heartbeat` — app vẫn đang được dùng

`subject`: `{ "type": "app", "external_id": "japanese-learning-app" }`

| `data` field | Kiểu | Bắt buộc | Quy tắc |
|---|---|---|---|
| `outbox_pending` | integer | ✔ | Số sự kiện đang chờ gửi (không tính heartbeat). |

Gửi khi app khởi động và tối đa **1 lần / 6 giờ** khi app đang mở. Heartbeat **không đi qua outbox**: gửi trực tiếp, thất bại thì bỏ qua (không retry, không lưu).

---

## 7. Phản hồi của Hub và cách app xử lý

| HTTP | Body (ví dụ) | Ý nghĩa | App phải làm |
|---|---|---|---|
| `202` | `{"success":true,"event_id":"…","status":"accepted"}` | Hub đã lưu sự kiện (xử lý nghiệp vụ có thể diễn ra sau) | Đánh dấu **delivered** |
| `200` | `{"success":true,"event_id":"…","status":"duplicate"}` | `event_id` đã nhận trước đó | Đánh dấu **delivered** (không phải lỗi) |
| `400` | `{"error":{"code":"VALIDATION","message":"…","details":{…}}}` | Sự kiện sai định dạng | Đánh dấu **failed** (không retry), ghi log `message` + `details`. Đây là lỗi của app cần sửa. |
| `401` / `403` | `{"error":{"code":"UNAUTHORIZED",…}}` | Sai/thiếu/đã thu hồi API key | **Dừng gửi**, giữ nguyên outbox, hiển thị "Cần cấu hình lại API key của Hub". Thử lại khi cấu hình thay đổi hoặc sau 1 giờ. |
| `404` | — | Hub chưa có endpoint (phiên bản Hub cũ) | Coi như Hub chưa sẵn sàng: giữ sự kiện, thử lại sau 1 giờ. |
| `409` | `{"error":{"code":"CONFLICT",…}}` | Cùng `event_id` nhưng nội dung khác | Đánh dấu **failed**, ghi log — dấu hiệu bug sinh `event_id`. |
| `413` | — | Body quá lớn | **failed**, ghi log. |
| `429`, `5xx` | — | Hub quá tải/lỗi tạm thời | Retry với backoff (dưới đây). |
| Không kết nối được / timeout | — | Hub đang tắt (rất bình thường) | Retry với backoff. **Không bao giờ** tự xóa sự kiện vì lý do này. |

**Backoff:** 30 giây × 2^(lần thử − 1), tối đa 1 giờ, cộng ngẫu nhiên ±20%.
- Lỗi kết nối/timeout/404: retry **không giới hạn số lần** (Hub có thể tắt nhiều ngày).
- `429`/`5xx`: tối đa 20 lần, sau đó **failed**.
- Sự kiện **failed** được giữ lại (không xóa) và có cách thử lại thủ công (nút hoặc lệnh).

**Thứ tự:** gửi theo `recorded_at` tăng dần. Một sự kiện đang chờ backoff vì lỗi kết nối thì dừng cả hàng đợi (Hub đang tắt — gửi tiếp cũng vô ích). Sự kiện **failed** không chặn hàng đợi.

**Khi nào kích hoạt bộ gửi:** khi app khởi động, ngay sau khi tạo sự kiện mới, và định kỳ theo lịch backoff. Bộ gửi không được làm chậm/khóa giao diện học.

**Dọn outbox:** sự kiện **delivered** có thể xóa sau 30 ngày.

---

## 8. Cấu hình

| Khóa | Mặc định | Ghi chú |
|---|---|---|
| `HUB_INTEGRATION_ENABLED` | `false` | Chỉ gửi khi `true` **và** có API key. Khi tắt, app **vẫn** ghi sự kiện vào outbox (để bật lên sau không mất lịch sử) — trừ khi người dùng chọn xóa. |
| `HUB_URL` | `http://127.0.0.1:4317` | Chỉ chấp nhận `http://127.0.0.1:<port>`. |
| `HUB_API_KEY` | (trống) | Người dùng lấy từ trang **Tích hợp** của Hub (đăng ký app `japanese-learning-app` → **Tạo key**) và dán vào app. Key có dạng `pph_` + 32 ký tự. Lưu bằng cơ chế lưu bí mật của app/OS nếu có; **không** đưa vào source code, log, hay thông báo lỗi. |

---

## 9. Kiểm thử

Viết một **Hub giả lập** nhỏ (trong thư mục test/dev của app, không cài gì ra ngoài máy) lắng nghe `127.0.0.1:<port tùy chọn>` và trả lời theo bảng mục 7, có thể cấu hình để: trả 202; trả 200 duplicate khi `event_id` lặp; trả 400/401/500 theo yêu cầu; tắt hẳn để mô phỏng Hub offline. Trỏ `HUB_URL` của app tới Hub giả lập khi test.

Ví dụ request hợp lệ (để đối chiếu):

```bash
curl -i -X POST http://127.0.0.1:4317/api/v1/integrations/events \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  --data-binary @event.json
```

### Tiêu chí nghiệm thu

1. Học xong một lô 20 từ mới → outbox có đúng 1 sự kiện `vocabulary.learned`, `data.count = 20`, `occurred_at` = thời điểm học xong.
2. Hub giả lập trả 202 → sự kiện chuyển **delivered**, không gửi lại.
3. Hub giả lập tắt → sự kiện ở lại outbox; bật lại → được gửi, `event_id`, `occurred_at`, `recorded_at` **giữ nguyên** so với lúc tạo.
4. Tắt app (kể cả kill process) khi còn sự kiện chờ → mở lại, sự kiện vẫn còn và được gửi.
5. Gửi cùng một sự kiện 2 lần (ví dụ mất phản hồi sau khi Hub đã nhận) → lần 2 Hub giả lập trả 200 duplicate → app coi là delivered, không báo lỗi.
6. Hub giả lập trả 400 → sự kiện **failed**, có log nêu lý do, các sự kiện sau vẫn được gửi.
7. Hub giả lập trả 401 → ngừng gửi, outbox giữ nguyên, app hiển thị cần cấu hình API key; sửa key → tiếp tục gửi.
8. Mở lại màn hình kết quả / đồng bộ lại cùng một phiên → **không** sinh sự kiện mới.
9. Hoàn tác tiến độ trong app → **không** gửi gì cho Hub.
10. Heartbeat gửi khi khởi động; Hub tắt → không lỗi, không lưu vào outbox.
11. Mọi body gửi đi khớp đặc tả mục 4 và 6 (kiểm bằng test tự động có schema).
12. API key không xuất hiện trong log hay file cấu hình được commit.

---

## 10. Không được làm

- Không gửi XP, phần trăm tiến độ, Goal ID, Task ID hay bất kỳ khái niệm nào của Hub.
- Không sinh lại `event_id` khi retry; không dùng ID tăng dần hay timestamp làm `event_id`.
- Không đặt `occurred_at` = thời điểm gửi.
- Không xóa sự kiện chưa delivered vì Hub không phản hồi.
- Không gọi bất kỳ endpoint nào khác của Hub, không đọc database của Hub.
- Không mở cổng mạng, không gửi dữ liệu ra ngoài `127.0.0.1`.
- Không cài phần mềm/dịch vụ hệ thống hay thay đổi cấu hình máy để phục vụ tích hợp.

---

## 11. Phía Hub đã có (để app biết sự kiện được dùng thế nào)

- Endpoint `POST /api/v1/integrations/events` và trang **Tích hợp** (tạo/thu hồi API key, lịch sử sự kiện với trạng thái PROCESSED / IGNORED / FAILED, thử lại).
- Ánh xạ sự kiện → Goal do chủ sở hữu cấu hình trong Hub, ví dụ "mỗi từ trong `vocabulary.learned.count` = 1 đóng góp cho Goal Học 1000 từ". Sự kiện chưa có quy tắc được lưu với trạng thái IGNORED (không lỗi) và có thể áp dụng lại sau.
- Sự kiện được xử lý **như một việc đã hoàn thành**: cộng tiến độ Goal, XP và tính ngày hoạt động (Streak) theo `occurred_at`.
- Cảnh báo khi app không gửi sự kiện hoạt động quá 3 ngày (heartbeat không tính là hoạt động).

Nếu phát hiện hợp đồng này thiếu thông tin cho một tình huống thực tế của app, **đừng tự mở rộng định dạng** — ghi lại câu hỏi để chủ sở hữu hai app thống nhất và nâng `schema_version`.
