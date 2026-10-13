# Quản trị & giám sát — kế hoạch và sổ tay sự cố

Bốn phần, làm lần lượt. Mỗi phần chỉ bắt đầu khi phần trước đã qua đủ các cổng kiểm tra bên dưới.

| # | Phần | Trạng thái |
|---|------|-----------|
| 1 | Nhật ký hoạt động | **Xong** (2026-10-11) |
| 2 | Sao lưu & kiểm soát database | **Xong** (2026-10-11) |
| 3 | Người dùng & workspace (số liệu từng người, phạm vi sách) | **Xong** (2026-10-11) |
| 4 | Phân quyền kho từ vựng (kho riêng, nhiều nghĩa theo sách, đề xuất chờ duyệt) | **Xong** (2026-10-11) |

Thứ tự này có chủ ý: phần 2 (sao lưu) phải có trước các phần 3–4, vì 3–4 đổi cấu trúc dữ liệu.

## Quy trình chung cho mỗi phần

1. **Thiết kế cộng thêm, không phá:** chỉ thêm bảng hoặc cột mới. Không xoá hay đổi tên cột đang dùng (skill database-safe-schema-migration). Code cũ chạy được trên DB mới, nên quay lui code không cần quay lui DB.
2. **Có công tắc tắt:** mỗi tính năng có biến môi trường để tắt, không cần sửa code.
3. **Lỗi của tính năng mới không được làm hỏng chức năng cũ:** bắt lỗi tại chỗ, đếm lại và hiện cho admin xem.
4. **Cổng kiểm tra trước khi dùng thật:**
   - `npm run lint`: không có lỗi, không thêm cảnh báo mới.
   - `npm run build` chạy qua.
   - `npm test`: kiểm thử đơn vị, và kiểm thử HTTP trên một **bản sao** database (biến `BOOKS_DB_PATH`), không bao giờ chạy trên `server/data/`.
   - Đo hiệu năng: tính năng mới không được làm chậm request thấy rõ.
   - Xem giao diện thật trên trình duyệt (dùng bản sao DB): không có lỗi console.
5. **Sao lưu trước khi khởi động server bản mới trên dữ liệu thật:**
   `sqlite3 server/data/books.db ".backup server/data/books.db.bak-$(date +%s)"`
6. **Đánh giá sau 1–2 tuần dùng thật:** dung lượng tăng thêm, lỗi ghi nhận được, phản hồi người dùng. Sau đó mới sang phần tiếp theo.

---

## Phần 1 — Nhật ký hoạt động (đã xong)

**Làm được gì:** Vào Cài đặt → **Nhật ký hoạt động** (chỉ người có quyền `users.manage`) để xem:
- Bảng tổng hợp theo người dùng: hoạt động gần nhất, số lượt dịch AI, sửa đoạn, thao tác từ vựng, lượt ôn, số thao tác lỗi hoặc bị chặn. Có cảnh báo khi có đăng nhập thất bại.
- Nhật ký chi tiết, lọc được theo người, loại thao tác, chỉ lỗi, khoảng ngày.

**Cách hoạt động:**
- Thành phần chính: `server/activityLog.js` (middleware), `server/routes/activity.js` (API), `src/components/admin/ActivityLog.jsx` (giao diện).
- Ghi lại mọi request làm **thay đổi** dữ liệu, kể cả request bị từ chối (401/403), cùng các lần đăng nhập.
- Không ghi: các lần đọc, vị trí đọc, tuỳ chọn hiển thị, đọc to, từng lượt chấm điểm ôn tập (đã có trong `review_log`).
- **Không lưu nội dung gửi lên:** chỉ lưu tên các trường được gửi, vài số định danh (id), và email của lần thử đăng nhập. Mật khẩu, khoá API và nội dung sách không bao giờ vào nhật ký (đã có kiểm thử cho việc này).
- Ghi theo lô: gom lại rồi ghi mỗi giây hoặc mỗi 100 dòng, nằm ngoài đường xử lý request. Một dòng lỗi không làm mất cả lô.
- Đo được: khoảng 0,4–0,5 ms cho mỗi request sửa dữ liệu, tính cả phần ghi nhật ký.

**Cấu hình** (đặt trong `.env`):
- `ACTIVITY_LOG=0`: tắt nhật ký ngay lập tức, không cần sửa code.
- `ACTIVITY_RETENTION_DAYS=180`: số ngày giữ nhật ký (tối thiểu 7). Dữ liệu cũ hơn bị xoá lúc khởi động và mỗi 24 giờ.

**Kiểm thử:** `npm run test:activity` gồm 11 kiểm tra:
- Phân loại thao tác, bỏ qua request ồn, che bí mật.
- Ghi theo lô, xử lý dòng lỗi, xoá dữ liệu cũ, công tắc tắt.
- Chạy server thật trên bản sao DB: kiểm tra phân quyền và đo hiệu năng.

**Thay đổi database:** chỉ thêm bảng `activity_log`. Bảng được tạo tự động lần đầu server chạy bản mới. Không đổi bảng nào khác.

### Sổ tay sự cố — Phần 1

| Triệu chứng | Kiểm tra | Khắc phục |
|---|---|---|
| Trang nhật ký báo "N dòng không ghi được" | Xem `GET /api/admin/activity/health` (trường `lastError`) và log server có dòng `[activity]` | App vẫn chạy bình thường. Nếu lỗi do ổ đĩa đầy hoặc DB bị khoá: giải phóng dung lượng hoặc khởi động lại. Nếu lỗi lặp lại: tạm đặt `ACTIVITY_LOG=0` |
| API chậm sau khi cập nhật | So sánh với khi đặt `ACTIVITY_LOG=0` | Nếu chậm do nhật ký: giữ tắt, báo lại để tối ưu. Có thể giảm số ngày lưu để bảng nhỏ lại |
| Bảng `activity_log` quá lớn | `SELECT COUNT(*) FROM activity_log` | Giảm `ACTIVITY_RETENTION_DAYS` rồi khởi động lại; sau đó chạy `VACUUM` lúc ít người dùng |
| Trang Cài đặt → Nhật ký trắng hoặc lỗi | Console trình duyệt; `GET /api/admin/activity` | Chức năng khác không bị ảnh hưởng. Quay lui riêng phần giao diện (xem bên dưới) |
| Không thấy tab Nhật ký | Tài khoản có quyền `users.manage` không | Gán vai trò Quản trị |

**Quay lui hoàn toàn Phần 1** (không mất dữ liệu nào khác):
1. Nhanh nhất: đặt `ACTIVITY_LOG=0` rồi khởi động lại server.
2. Gỡ code: xoá dòng `activityMiddleware` và `app.use('/api/admin/activity', …)` trong `server/index.js`; bỏ tab `activity` trong `src/pages/SettingsPage.jsx`; rồi chạy `npm run build`.
3. Bảng `activity_log` có thể để nguyên (vô hại), hoặc xoá bằng `DROP TABLE activity_log`.

---

## Phần 2 — Sao lưu & kiểm soát database (đã xong)

**Làm được gì:** vào Cài đặt → **Dữ liệu & sao lưu** (cần quyền `users.manage`):
- Xem dung lượng database, bản sao lưu gần nhất, dung lượng ổ đĩa còn trống. Trang tự cảnh báo khi: quá 26 giờ chưa có bản sao lưu nào, lần sao lưu tự động gần nhất thất bại, hoặc ổ đĩa sắp đầy.
- Danh sách bản sao lưu: thời gian, loại, kích thước, nội dung (số đoạn / từ / người), trạng thái kiểm tra, nút **Tải về**. Có nút **Sao lưu ngay**, ghi chú tuỳ chọn.
- **Kiểm tra toàn vẹn** database đang chạy (`integrity_check` và `foreign_key_check`), kèm số dòng và dung lượng từng bảng.
- **Lịch sử gộp từ vựng**, có nút **Hoàn tác** cho các lần gộp từ nay về sau. Hoàn tác trả lại mục từ với đúng id cũ, tiến độ ôn, lịch sử ôn, liên kết thuật ngữ, và nội dung của mục được giữ.
  - Nếu sau khi gộp có người sửa mục được giữ hoặc ôn nó, phần mới đó được giữ nguyên và hệ thống báo lại.
  - Các lần gộp trước ngày 11/10 và gộp do chuẩn hoá khoá không hoàn tác được. Nếu cần, khôi phục từ bản sao lưu `books.db.bak-before-vocab-1791701150`.

**Cách hoạt động** (`server/backup.js`):
- Sao lưu bằng `VACUUM INTO`: một bản chụp nhất quán ngay cả khi app đang ghi, đã được nén. Đo được: 1,9 MB mất khoảng 7 ms.
- Mỗi bản được kiểm tra ngay sau khi tạo (`quick_check` và đếm số dòng) và có tệp `.json` đi kèm ghi sha256. Bản nào không qua kiểm tra bị xoá, không bao giờ được liệt kê như bản tốt.
- Ba loại bản sao lưu:
  - `auto`: lúc server khởi động nếu bản gần nhất đã quá 1 ngày, sau đó kiểm tra mỗi giờ.
  - `manual`: khi bấm nút hoặc chạy `npm run db:backup`.
  - `pre-migration`: do code tạo trước khi chuyển đổi dữ liệu. Chuyển đổi khoá từ vựng **sẽ không chạy** nếu không sao lưu được; app vẫn chạy với khoá cũ.
- Xoay vòng: giữ 7 bản tự động gần nhất, mỗi tuần 1 bản trong khoảng 5 tuần, 10 bản gần nhất của mỗi loại còn lại. Không bao giờ xoá bản tốt mới nhất.
- Không sao lưu khi ổ đĩa còn ít hơn max(200 MB, 3 × kích thước DB).
- Tải về chỉ chấp nhận tên có trong danh sách, nên không thể dùng `../` để lấy file khác. Mỗi lần tải về được ghi vào nhật ký hoạt động.

**Cấu hình** (`.env`):
- `BACKUP_AUTO=0`: tắt sao lưu tự động.
- `BACKUP_DIR=/đường/dẫn`: đổi thư mục chứa bản sao lưu; mặc định là `server/data/backups/`. **Nên đặt ở một ổ đĩa khác** hoặc một thư mục được đồng bộ ra ngoài máy, vì bản sao lưu nằm cùng ổ với database sẽ mất cùng lúc nếu ổ hỏng.

**Kiểm thử:** `npm run test:database` gồm 12 kiểm tra:
- Sao lưu đúng và đủ; chặn đường dẫn lạ; phát hiện file hỏng hoặc bị cắt cụt.
- Quy tắc xoay vòng; xử lý thư mục không ghi được; kiểm tra toàn vẹn.
- Hoàn tác gộp: trả lại chính xác, và giữ nội dung đã sửa sau khi gộp.
- Gọi API thật: phân quyền, tải về, ghi vào nhật ký.
- Lệnh khôi phục: từ chối khi server đang chạy, khôi phục đúng, sao lưu database hiện tại trước khi thay, từ chối bản sao lưu hỏng.

**Thay đổi database:**
- Thêm 3 cột `undo_json`, `undone_at`, `undone_by` vào `vocab_merge_log`. Các cột này đã được thêm vào DB thật ngày 11/10 khi chạy thử; vô hại với code cũ.
- Thư mục `server/data/backups/` được tạo khi server khởi động lần đầu với bản mới.

### Khôi phục (khi dữ liệu hỏng hoặc bị xoá nhầm)

```
# 1. Dừng server (Ctrl+C)
# 2. Xem danh sách bản sao lưu:
npm run db:restore
# 3. Khôi phục một bản (lệnh sẽ hỏi xác nhận: gõ KHOI PHUC):
npm run db:restore -- books-20261011-073438-213-auto.db
# 4. Khởi động lại: npm run dev
```

Lệnh khôi phục sẽ:
- Từ chối nếu server còn chạy.
- Kiểm tra bản sao lưu (`quick_check` và sha256).
- **Sao lưu database hiện tại** thành một bản `pre-migration` trước khi thay thế.
- Sau đó mới thay file, rồi kiểm tra lại.

Nếu khôi phục nhầm bản, chạy lại lệnh với bản `pre-migration` vừa được tạo.

### Sổ tay sự cố — Phần 2

| Triệu chứng | Kiểm tra | Khắc phục |
|---|---|---|
| Cảnh báo "Chưa có bản sao lưu nào trong hơn một ngày" | Server có chạy liên tục không; `BACKUP_AUTO`; log server có dòng `[backup]` | Bấm "Sao lưu ngay"; nếu báo lỗi, xem các dòng bên dưới |
| "Ổ đĩa còn … MB, cần ít nhất …" | Dung lượng trống của ổ chứa `BACKUP_DIR` | Giải phóng ổ đĩa, hoặc chuyển `BACKUP_DIR` sang ổ khác rồi khởi động lại |
| "Bản sao lưu vừa tạo không qua kiểm tra" | Bấm "Kiểm tra ngay" để kiểm tra database đang chạy | Nếu database đang chạy cũng báo lỗi: dừng ghi, tải về bản sao lưu Tốt gần nhất, rồi khôi phục |
| Kiểm tra toàn vẹn báo liên kết hỏng (foreign key) | Bảng nào bị lỗi | Thường do xoá trong lúc tắt khoá ngoại; sao lưu trước, rồi sửa có chủ đích hoặc khôi phục |
| Hoàn tác gộp báo "trùng khoá" / "mã đã dùng lại" | Đã có mục mới cùng khoá hoặc cùng id | Sửa hoặc gộp mục mới trước, rồi hoàn tác; hoặc thêm lại từ bằng tay |
| Server không khởi động sau khi khôi phục | Thông báo cuối của lệnh khôi phục | Khôi phục lại bản `pre-migration` mà lệnh vừa tạo |
| Thư mục sao lưu quá lớn | Thẻ "Số bản sao lưu" | Xoay vòng tự giới hạn khoảng 30 bản; có thể xoá bớt bản cũ bằng tay (xoá cả tệp `.json` đi kèm) |

**Quay lui Phần 2:**
- Tắt sao lưu tự động: `BACKUP_AUTO=0`.
- Gỡ code: bỏ dòng `startBackupSchedule()` và `app.use('/api/admin/database', …)` trong `server/index.js`; bỏ tab `data` trong `SettingsPage.jsx`; bỏ dòng gọi `backupBeforeMigration` trong `vocabStore.js`.
- Các cột mới và các bản sao lưu đã tạo có thể giữ nguyên.

## Phần 3 — Người dùng & workspace, phạm vi sách (đã xong)

**Làm được gì:**
- **Quyền xem sách:** trang sách → tab Thông tin sách → khung **Quyền xem**. Có hai chế độ:
  - *Công khai*: mặc định, giống như trước đây.
  - *Hạn chế*: chỉ chủ sách, những người dùng hoặc nhóm được chọn, và quản trị viên thấy sách.
  - Người được đổi quyền xem: quản trị viên, và chủ sách nếu có quyền Biên tập. Chủ sách không chuyển được sách cho người khác; chỉ quản trị viên làm được.
  - Thư viện hiện nhãn 🔒 *Hạn chế* cho sách đang ở chế độ này.
- **Chủ sách:** người tạo hoặc nhập sách từ nay là chủ sách. Cuốn sách đang có (#1) chưa có chủ; quản trị viên có thể gán chủ khi cần.
- **Workspace từng người:** Cài đặt → Nhật ký hoạt động → bấm tên một người dùng để xem:
  - Vai trò và nhóm.
  - Sách người đó thấy được, và thấy qua đường nào (công khai, chủ sách, được cấp, qua nhóm, quản trị).
  - Sách đang đọc; đánh dấu "không còn quyền xem" nếu sách đã bị hạn chế với họ.
  - Tiến độ ôn tập, số lần hỏi trợ lý AI, phân công, phiên đăng nhập.

**Cách hoạt động** (`server/bookAccess.js`):
- **Lớp 1, chốt chặn trung tâm** (middleware `guardBookContent` trên `/api`):
  - Mọi sách, phần, chương, mục, đoạn, thảo luận, bài viết, thuật ngữ hay phân công được nhắc đến đều bị chặn, dù nằm ở đường dẫn, query (`?bookId=…`) hay body (`{ paragraphId }`, `source_paragraph_id`…).
  - Phản hồi là **404 "Không tìm thấy"**, không phải 403, để không lộ việc sách tồn tại.
  - Route mới thêm sau này được bảo vệ tự động, miễn là dùng các tên tham số trên.
- **Lớp 2, các danh sách tổng hợp** lọc bằng `bookFilterSql`/`visibleBookIds`: thư viện, trang chủ (đang đọc, đánh dấu, việc cần dịch, số sách), thảo luận và số đếm, thuật ngữ, phân công của tôi, thống kê và nơi xuất hiện của từ vựng.
- **Kho từ vựng vẫn dùng chung.** Với từ lấy từ sách mà người dùng không được xem, tên sách/chương nguồn và câu ví dụ (vốn trích từ sách) bị ẩn. Việc ẩn này nằm ở một middleware của router từ vựng, nên mọi phản hồi của router đó đều được ẩn, không trông vào việc từng route nhớ gọi.
- Quản trị viên luôn thấy mọi sách. Chi phí thêm cho mỗi request khoảng vài ms.

**Cấu hình:** `BOOK_SCOPES=0` tắt toàn bộ cả hai lớp, mọi sách lại hiện cho mọi người như trước. Dữ liệu quyền vẫn giữ nguyên, bật lại là dùng tiếp.

**Kiểm thử:** `npm run test:access` gồm 11 kiểm tra:
- Gieo một sách hạn chế có **chuỗi đánh dấu** trong mọi trường (tiêu đề, chương, đoạn, bài thảo luận, thuật ngữ, ví dụ của từ).
- Người ngoài, kể cả có quyền Biên tập, bị từ chối ở **cả 39 request** nhắc tới sách, và không phản hồi nào chứa chuỗi đánh dấu.
- **18 danh sách** tổng hợp vẫn trả lời bình thường nhưng không chứa sách.
- **Kiểm tra ngược:** khi tắt phạm vi, 12/18 danh sách đó *có* lộ chuỗi đánh dấu. Điều này chứng minh phép dò đang nhìn đúng chỗ; 6 danh sách còn lại vốn không chứa nội dung của sách.
- Người được mời, thành viên nhóm, chủ sách và quản trị viên đọc và dùng sách bình thường.
- Chỉ quản trị viên và chủ sách đổi được quyền; chủ sách không chuyển được sách cho người khác.
- Biên tập viên tạo sách thì thành chủ sách.
- Trang workspace hiện đúng quyền; công tắc `BOOK_SCOPES=0` hoạt động.
- `npm run test:activity` có thêm kiểm tra: mọi thao tác được ghi nhật ký đều có nhãn tiếng Việt.

**Thay đổi database** (chỉ thêm vào; đã được tạo trên DB thật ngày 11/10 khi chạy thử, vô hại):
- Cột `books.visibility` (mặc định `'public'`) và `books.owner_id`.
- Bảng `book_access`.

**Giới hạn hiện tại** (để Phần 4 xử lý):
- Từ vựng vẫn là kho chung: người ngoài vẫn thấy *từ* và *nghĩa* của từ lấy từ sách hạn chế, chỉ không thấy nguồn và câu ví dụ.
- Phạm vi chỉ quyết định **xem**. Quyền **sửa** vẫn theo vai trò toàn cục (Biên tập), áp dụng trên những sách mà người đó thấy.

### Sổ tay sự cố — Phần 3

| Triệu chứng | Kiểm tra | Khắc phục |
|---|---|---|
| Ai đó báo "Không tìm thấy nội dung này" với sách lẽ ra họ được xem | Cài đặt → Nhật ký hoạt động → bấm tên họ → mục "Sách thấy được" | Thêm họ, hoặc nhóm của họ, vào Quyền xem của sách; hoặc chuyển sách về Công khai |
| Sách biến mất với mọi người trừ quản trị viên | Khung Quyền xem: Hạn chế mà danh sách trống | Thêm người/nhóm, hoặc chuyển về Công khai |
| Nghi ngờ lộ dữ liệu ở một route mới | Chạy `npm run test:access`; thêm route đó vào danh sách `NAMED` hoặc `LISTS` trong test | Nếu route nhận id qua tên tham số khác, thêm tên đó vào `FIELD_KINDS` trong `bookAccess.js`. Nếu là danh sách tổng hợp, lọc bằng `bookFilterSql` |
| Phạm vi sách gây lỗi hoặc chặn nhầm diện rộng | Log server; nhật ký hoạt động lọc "Chỉ lỗi / bị chặn" | Đặt `BOOK_SCOPES=0` rồi khởi động lại: mọi thứ về như trước, dữ liệu quyền vẫn giữ |
| Trang chậm khi có nhiều sách | Thời lượng trong nhật ký hoạt động | Danh sách sách thấy được tính một lần cho mỗi request; nếu có hàng trăm sách hạn chế thì cần thêm bộ nhớ đệm, báo lại để tối ưu |

**Quay lui Phần 3:**
- Nhanh nhất: đặt `BOOK_SCOPES=0`.
- Gỡ code: bỏ `guardBookContent` trong `server/index.js`. Các lời gọi `bookFilterSql` sẽ trả về `1` khi phạm vi tắt, nên có thể để nguyên.
- Cột và bảng mới có thể giữ.

## Phần 4 — Kho từ riêng, đề xuất, nghĩa theo sách (đã xong)

### 4a. Kho riêng và đề xuất

**Làm được gì:**
- **Từ riêng:** Học viên trở lên có quyền mới `vocab.own`.
  - Thêm từ của mình bằng nút **Thêm từ của tôi** ở trang Kho từ vựng, hoặc từ khung "Kho từ vựng của đoạn" trong trình đọc (AI điền sẵn IPA, nghĩa…).
  - Chỉ mình người đó thấy; vẫn ôn tập, sửa, xoá như bình thường.
  - Thêm một từ mà kho chung đã có thì không tạo bản sao; từ đó được gắn sao vào "Từ của tôi".
- **"Từ của tôi":** gồm từ riêng, cộng với những từ trong kho chung mà người đó gắn sao (⭐).
  - Mỗi từ có **ghi chú riêng** (trong khung chi tiết của từ), chỉ người đó thấy.
  - Trang Kho từ vựng và trang Ôn tập có thêm bộ lọc *Tất cả / Kho chung / Từ của tôi*.
- **Đề xuất:** từ riêng có nút ✈ *Đề xuất vào kho chung* (rút lại được khi còn đang chờ).
  - Biên tập viên thấy khung "N từ được đề xuất" ở trang Kho từ vựng: **Duyệt** (sửa được nghĩa trước khi duyệt) hoặc **Từ chối** kèm lý do; người đề xuất thấy lý do này.
  - Khi duyệt, từ chuyển sang kho chung **với cùng mã**, nên người đề xuất giữ nguyên tiến độ ôn. Nếu kho chung đã có từ đó thì gộp vào mục có sẵn, giữ nghĩa của kho chung.
- **Tự gộp bản riêng:** khi một từ vào kho chung (do dịch, nhập sách, chốt thuật ngữ, biên tập viên thêm, hay duyệt đề xuất), mọi bản riêng cùng từ đó của từng người được gộp vào. Tiến độ ôn của họ chuyển sang; nghĩa họ tự ghi được giữ thành ghi chú riêng ("Nghĩa tôi ghi: …"), không ghi đè nghĩa của kho chung.

**Cách hoạt động:**
- Cột `vocabulary.owner_id` (để trống = kho chung) và bảng `user_vocab` (danh sách và ghi chú của từng người).
- Khoá chống trùng thành **duy nhất theo phạm vi**, bằng hai partial index:
  - `idx_vocab_term_unique … WHERE owner_id IS NULL` cho kho chung;
  - `idx_vocab_private_term (owner_id, term_normalized)` cho từ riêng của từng người.
  - Các chỗ ghi vào kho chung dùng `ON CONFLICT(term_normalized) WHERE owner_id IS NULL`.
- Mọi danh sách từ trong router `vocabulary` đọc qua một subquery chỉ lấy *kho chung + từ của chính mình*. Các nơi khác dùng `visibleVocabSql`, hoặc chỉ đọc kho chung (dịch, trợ lý AI, gợi ý trùng).
- Luồng dịch **chỉ** đọc và ghi kho chung; từ riêng không ảnh hưởng tới AI.

**Cấu hình:** `VOCAB_PRIVATE=0` chặn việc tạo từ riêng mới và đề xuất mới. Từ riêng đã có vẫn nguyên, chủ của chúng vẫn thấy và ôn được.

**Kiểm thử:** `npm run test:vocab-scopes` gồm 11 kiểm tra:
- Từ riêng của A không lọt ra **14 danh sách** khi B xem, và B không xem/sửa/xoá/ôn/đề xuất được từ đó (luôn trả 404).
- Học viên không sửa được nội dung kho chung nhưng vẫn theo dõi tiến độ được.
- Từ đã có trong kho chung → báo trùng, gắn sao kèm ghi chú.
- Khách không thêm được từ.
- Duyệt giữ tiến độ của người đề xuất; từ chối hiện lý do.
- Bản riêng của hai người được gộp đúng khi từ vào kho chung.
- Luồng dịch gộp bản riêng.
- Công tắc `VOCAB_PRIVATE=0` hoạt động.

### 4b. Nghĩa theo sách

**Làm được gì:**
- Một từ trong kho chung có thể có **nghĩa riêng cho từng sách**, ví dụ "attachment" là *sự gắn bó* trong sách tâm lý, *tệp đính kèm* trong sổ tay email.
  - Trình đọc hiện nghĩa đúng của sách đang đọc, ghi chú "nghĩa trong sách này", và vẫn cho xem nghĩa chung.
  - Sửa nghĩa ngay trong trình đọc là sửa nghĩa của sách đó, không đụng tới nghĩa chung.
  - Trang Kho từ vựng → khung chi tiết của từ → **Nghĩa theo sách**: biên tập viên thêm, sửa, xoá.
- **Khi dịch:**
  - Một từ chỉ được coi là "đã biết" trong một sách nếu nghĩa của nó áp dụng được cho sách đó: cùng sách nguồn, cùng lĩnh vực (`books.domain`), hoặc đã có nghĩa riêng cho sách/lĩnh vực đó.
  - Ở sách thuộc lĩnh vực khác, AI được giải thích lại từ đó, và nghĩa mới được **lưu thành nghĩa riêng cho sách** thay vì bị bỏ đi như một từ trùng. Ghi chú Vocabulary của đoạn ghi rõ *(nghĩa trong sách này)*.
- **Thứ tự chọn nghĩa:** nghĩa riêng của sách → nghĩa chung (nếu cùng sách nguồn hoặc cùng lĩnh vực) → nghĩa riêng của một sách cùng lĩnh vực → nghĩa chung.

**Cách hoạt động** (`server/vocabSenses.js`):
- Bảng `vocab_senses` (mỗi từ có tối đa một nghĩa cho mỗi sách).
- `vocabulary.meaning_vi` **vẫn là nghĩa chung**, nên mọi chỗ cũ đọc cột này vẫn chạy. Không có chuyển đổi dữ liệu nào: chỉ thêm bảng mới.
- Nghĩa trùng với nghĩa chung thì không lưu.
- Khi gộp từ, nghĩa riêng theo sách được chuyển theo, và trả lại đúng chỗ khi hoàn tác.
- Nghĩa riêng của sách bị hạn chế (Phần 3) bị ẩn với người không được xem sách, kể cả khi xuất file. Chốt chặn của Phần 3 biết mỗi nghĩa riêng thuộc sách nào.
- File xuất/nhập lên **phiên bản 2**: mỗi từ kèm danh sách `senses`, ghép với sách theo tiêu đề tiếng Anh. File phiên bản 1 vẫn nhập được; sách không tìm thấy được liệt kê trong báo cáo nhập.

**Cấu hình:** `VOCAB_SENSES=0` quay về hành vi cũ (nghĩa chung ở mọi nơi, mọi từ đều "đã biết"). Các nghĩa riêng đã lưu được giữ nguyên.

**Kiểm thử:** `npm run test:vocab-senses` gồm 11 kiểm tra:
- **Chống hồi quy:** với sách hiện có, danh sách từ "đã biết" và nghĩa gửi cho AI **y hệt** trước đây.
- Cùng lĩnh vực thì là từ đã biết; khác lĩnh vực thì AI giải thích lại và nghĩa mới thành nghĩa riêng của sách, nghĩa chung không đổi.
- Thứ tự chọn nghĩa đúng.
- Gộp và hoàn tác chuyển nghĩa riêng đúng.
- Trình đọc hiện đúng nghĩa theo từng sách.
- API: biên tập viên thêm/sửa/xoá, học viên không được.
- Nghĩa riêng của sách bị hạn chế bị ẩn, và không sửa được nếu không thấy sách.
- Xuất/nhập giữ nghĩa riêng.
- Công tắc `VOCAB_SENSES=0` hoạt động.

**Thay đổi database** (tạo khi server khởi động lần đầu với bản mới, có **sao lưu `pre-migration` trước**):
- Thêm vào bảng `vocabulary` các cột `owner_id`, `proposal_status`, `proposal_note`, `proposed_at`, `reviewed_by`, `reviewed_at`.
- Bảng mới `user_vocab` và `vocab_senses`.
- Index `idx_vocab_term_unique` thành partial index; thêm `idx_vocab_private_term`.
- Bảng `vocab_merge_log` lưu thêm (trong `undo_json`) ghi chú và nghĩa riêng theo sách của mục bị gộp, để hoàn tác.

### Sổ tay sự cố — Phần 4

| Triệu chứng | Kiểm tra | Khắc phục |
|---|---|---|
| Học viên báo không thêm được từ | Vai trò có quyền `vocab.own` không (Học viên trở lên); `.env` có `VOCAB_PRIVATE=0` không | Gán vai trò Học viên; bỏ công tắc tắt |
| "… đã có trong kho chung" khi thêm từ riêng | Đúng thiết kế: không tạo bản sao | Từ đã được gắn sao vào "Từ của tôi"; ghi chú riêng ở khung chi tiết của từ |
| Lỗi `UNIQUE constraint failed` khi dịch hoặc nhập | Log server; xem `idx_vocab_term_unique` có `WHERE owner_id IS NULL` không | Chuyển đổi chưa chạy (sao lưu trước đó thất bại?). Xem log `[vocabulary]` / `[backup]`, giải phóng ổ đĩa rồi khởi động lại |
| Một từ hiện nghĩa lạ trong một sách | Khung chi tiết của từ → "Nghĩa theo sách" | Sửa hoặc xoá nghĩa của sách đó; hoặc điền lại `books.domain` của sách cho đúng lĩnh vực |
| AI cứ giải thích lại những từ đã có, ở một sách mới | Ô *Lĩnh vực* của sách (tab Thông tin sách) | Đặt cùng lĩnh vực với sách gốc nếu đúng là cùng lĩnh vực; hoặc tạm đặt `VOCAB_SENSES=0` |
| Duyệt nhầm một đề xuất | Cài đặt → Dữ liệu & sao lưu → Lịch sử gộp | Nếu là gộp vào mục có sẵn: **Hoàn tác**. Nếu từ được chuyển thẳng sang kho chung: sửa hoặc xoá mục trong Kho từ vựng |
| Gộp tự động bản riêng không mong muốn | Lịch sử gộp (lý do "absorb") | **Hoàn tác** lần gộp đó: từ riêng, tiến độ và ghi chú trở về như cũ |

**Quay lui Phần 4** (không mất dữ liệu):
- Tắt tính năng: `VOCAB_PRIVATE=0` và/hoặc `VOCAB_SENSES=0`.
- Quay về hoàn toàn: khôi phục bản sao lưu `pre-migration` có ghi chú "vocabulary scopes (private words)" bằng `npm run db:restore` (xem Phần 2). Lưu ý: mọi thay đổi sau thời điểm đó sẽ mất.

---

## Ảnh bìa sách (2026-10-11)

**Làm được gì:** trên trang sách, Biên tập viên trở lên có thể đặt ảnh bìa theo ba cách:
- bấm vào ảnh bìa để chọn ảnh;
- kéo thả một ảnh vào ảnh bìa;
- dán ảnh (Ctrl/⌘+V) khi đang chọn ảnh bìa.

Biểu tượng 🗑 bên dưới ảnh đưa sách về lại bìa chữ.

**Tối ưu ảnh** (`src/lib/coverImage.js`, xử lý ngay trên trình duyệt):
- Ảnh được tự xoay đúng chiều theo dữ liệu máy ảnh (EXIF), rồi thu nhỏ thành hai bản WebP: **600 px** cho trang sách (sắc nét trên màn hình 2x) và **200 px** cho các danh sách. Trình duyệt không xuất được WebP thì dùng JPEG.
- Thử với ảnh 3000×4500 px, 791 KB: còn **38 KB + 14 KB**.
- Màu chủ đạo của ảnh được dùng làm nền trong lúc ảnh đang tải.
- Ảnh quá nhỏ (dưới 120×160 px), quá ngang/quá dọc, hoặc HEIC/RAW mà trình duyệt không đọc được sẽ bị từ chối, kèm lời giải thích.

**Hiển thị** (`src/components/BookCover.jsx`):
- Dùng `srcset` + `sizes`, để trình duyệt tự chọn bản 200 hay 600 px theo kích thước hiển thị và độ phân giải màn hình.
- Khung luôn tỉ lệ 2:3, nên bố cục không nhảy khi ảnh tải xong.
- Ảnh ở danh sách tải chậm (`loading="lazy"`); ảnh trên trang sách tải ưu tiên (`fetchpriority="high"`).
- Ảnh hiện dần khi tải xong. Ảnh lỗi hoặc thiếu file thì tự quay về bìa chữ.

**Server** (`server/bookCovers.js`, route `PUT/DELETE /api/books/:id/cover`, `GET /api/books/:id/cover/lg|sm`):
- Kiểm tra **chữ ký nhị phân** của file (chỉ nhận WebP/JPEG/PNG; SVG và file giả mạo bị từ chối).
- Giới hạn 1,5 MB cho bản lớn, 400 KB cho bản nhỏ.
- Server tự đặt tên file: `book-<id>-<hash>-<lg|sm>.<ext>`. Tên đổi theo nội dung ảnh, nên ảnh được cache 1 năm (`immutable`) mà vẫn cập nhật ngay khi thay ảnh.
- Gửi kèm header `nosniff`.
- File cũ bị xoá khi thay ảnh hoặc xoá sách.
- Ảnh bìa theo quyền xem sách (Phần 3): sách bị hạn chế thì ảnh bìa cũng bị ẩn.

**Lưu trữ và sao lưu:**
- File ảnh nằm ở `server/data/covers/` (đổi được bằng `COVER_DIR`).
- Mỗi lần sao lưu (Phần 2) chép thêm các ảnh mới vào `backups/covers/`. Mỗi ảnh chỉ chép một lần, và cơ chế xoay vòng bản sao lưu không xoá các ảnh này.
- `npm run db:restore` trả lại những ảnh mà database được khôi phục có nhắc tới nhưng thư mục ảnh đang thiếu.

**Thay đổi database:** thêm các cột `books.cover_lg`, `cover_sm`, `cover_color`, `cover_w`, `cover_h`, `cover_updated_at`.

**Kiểm thử:** `npm run test:covers` gồm 9 kiểm tra:
- Nhận diện ảnh thật/giả.
- Tải lên, header cache.
- Thay ảnh thì xoá file cũ.
- Từ chối file giả, file thiếu, file quá lớn, màu không hợp lệ (không ghi gì xuống đĩa).
- Phân quyền và phạm vi sách.
- Xoá ảnh/xoá sách thì xoá file.
- Sao lưu chép ảnh; khôi phục trả lại ảnh.
- Thiếu file thì trả 404.

### Sổ tay sự cố — ảnh bìa

| Triệu chứng | Kiểm tra | Khắc phục |
|---|---|---|
| "Trình duyệt không đọc được ảnh này" | Ảnh HEIC (iPhone) hoặc RAW | Xuất ảnh sang JPEG/PNG (trên iPhone: Cài đặt → Camera → Định dạng → "Tương thích nhất") |
| "Ảnh quá ngang hoặc quá dọc" | Tỉ lệ ảnh | Cắt ảnh về khổ dọc, khoảng 2:3 |
| Bìa hiện bìa chữ dù đã có ảnh | `server/data/covers/` có đủ file tên như cột `cover_lg`/`cover_sm` không | Khôi phục từ `server/data/backups/covers/`, hoặc tải ảnh lên lại |
| Ảnh mờ ở khung lớn | Thuộc tính `sizes` trong `BookCover.jsx` có khớp với độ rộng thực tế không | Chỉnh `sizes`; bản lớn nhất là 600 px |
| Muốn tắt tính năng | — | Chưa có công tắc riêng: ảnh bìa là tuỳ chọn, sách không có ảnh dùng bìa chữ như trước. Có thể bỏ ảnh của từng sách bằng nút 🗑 |
