# Books Translate

**Vừa đọc sách tiếng Anh, vừa học tiếng Anh.** Books Translate là webapp miễn phí, mã nguồn mở, dành cho những ai muốn đọc sách tiếng Anh mà không phải dừng lại tra từ liên tục: mỗi đoạn văn hiện song song bản gốc và bản dịch tiếng Việt, kèm ghi chú cụm từ; từ mới được gom vào kho từ vựng riêng để ôn lại theo phương pháp lặp lại ngắt quãng (spaced repetition), như Anki.

Dự án được làm ra để chia sẻ một công cụ hữu ích cho cộng đồng người đọc và người học tiếng Anh. Toàn bộ mã nguồn được viết cùng [Claude Code](https://claude.com/claude-code) — trợ lý lập trình AI của Anthropic.

**Bạn có thể:**

- Nhập sách (file Word .docx hoặc dán văn bản) và đọc theo cấu trúc Sách → Phần → Chương → Mục → Đoạn văn.
- Đọc song song Anh–Việt, nghe đọc to phần tiếng Anh, đánh dấu và ghi chú từng đoạn.
- Dịch đoạn văn bằng AI (Claude, Gemini, OpenAI, NVIDIA, Ollama… — bạn tự cấu hình khoá của mình).
- Lưu từ mới vào kho từ vựng, phân theo chủ đề và thể loại sách, rồi ôn tập mỗi ngày.
- Dịch theo nhóm: phân quyền Quản trị / Biên tập / Học viên / Khách, thảo luận cách dịch, thống nhất thuật ngữ.

Kỹ thuật: **Vite + React** (frontend), **Express + SQLite** (backend), chạy được ngay trên máy cá nhân.

## Tính năng

- **Thư viện** (`/`): danh sách sách, import từ file `.docx` (đọc đúng bảng English/Vietnamese/Phrase & Remark cùng Heading 1/2/3 → Part/Chapter/Mục, giữ nguyên bản dịch và ghi chú người đã làm), import từ text dán tay, hoặc tạo sách trống rồi dịch dần.
- **Trang sách** (`/books/:id`): metadata đầy đủ (tác giả, NXB, ISBN, đánh giá...), mục lục theo Phần/Chương kèm % tiến độ dịch, panel "Đoạn đã đánh dấu" tổng hợp mọi đoạn được flag/bookmark/highlight trong sách.
- **Trang chương** (`/chapters/:id`): sidebar bên trái hiển thị mục lục Part/Chapter/Mục của cả sách, bảng dịch từng đoạn có thể dịch bằng AI (từng đoạn hoặc "Dịch tất cả đoạn còn thiếu" — chạy tuần tự ở phía trình duyệt kèm **thanh tiến trình** hiển thị số đoạn đã xong, thời gian đã trôi qua, ước tính thời gian còn lại, số từ mới thêm được, và nút Huỷ giữa chừng), sửa tay mọi trường, và đánh dấu 🚩 cần xem lại / 🔖 bookmark / 🖍️ highlight cho từng đoạn. Độ rộng nội dung và cỡ chữ tuỳ chỉnh được trong Cài đặt.
- **Kho từ vựng** (`/vocabulary`): tìm/lọc theo trạng thái, chủ đề, loại từ; sửa trực tiếp; xuất TSV.
- **Ôn tập** (`/review`): **spaced repetition đầy đủ** (thuật toán SM-2) — hàng đợi từ đến hạn ôn mỗi ngày, flashcard 4 mức đánh giá (Quên/Khó/Tốt/Dễ) tự tính lại khoảng lặp, có nút 🔊 nghe phát âm từ/câu ví dụ ngay trên thẻ. Bảng điều khiển đầu trang hiện số từ đến hạn, đã ôn hôm nay, **chuỗi ngày ôn liên tiếp** (streak) và số từ Cần ôn gấp/Thành thạo. Cả 2 tab "Ôn tập (SRS)" và "Thực hành tự do" đều lọc được theo **nhóm (chủ đề) và loại từ**, không chỉ trạng thái, để chọn đúng phạm vi muốn luyện.
- **Cài đặt** (`/settings`): chọn nhà cung cấp AI dịch — **Claude (Anthropic), Gemini (Google), ChatGPT (OpenAI), Ollama, LM Studio** — cấu hình API key/Base URL/model riêng cho từng nơi (model chọn từ danh sách, tự lấy trực tiếp từ nhà cung cấp khi có thể), có nút "Test kết nối"; phần tuỳ chỉnh giao diện đọc/dịch (độ rộng nội dung, cỡ chữ); và giọng đọc/tốc độ mặc định cho Kokoro TTS.
- **Đọc đoạn văn bằng giọng nói**: mỗi đoạn ở trang Chương có nút 🔊 Đọc — đọc to phần tiếng Anh bằng **Kokoro TTS** chạy hoàn toàn cục bộ (không gửi văn bản ra ngoài), có cache theo nội dung nên đọc lại tức thì, chỉ đọc mới khi lần đầu (~1-3s).

Toàn bộ dữ liệu (sách, chương, đoạn văn, từ vựng, cài đặt) nằm trong file SQLite `server/data/books.db`.

- **Thảo luận & thuật ngữ** (`/discussions`): bôi chọn một từ/cụm từ trong cột tiếng Anh (hoặc bản dịch) ở trang Chương → nút **Thảo luận** mở panel bên phải. Mỗi thuật ngữ trong một đoạn là một luồng: bình luận, **đề xuất cách dịch** và **bình chọn** (▲), rồi **Chốt** — cách dịch được chốt lưu vào **bảng thuật ngữ** của sách (hoặc dùng chung mọi sách), theo chủ đề, và tuỳ chọn thêm vào kho từ vựng. Có thể **Mở lại** để bàn tiếp. Chọn được cả **câu/đoạn trích** (tới ~600 ký tự); chỗ đang thảo luận được **đánh dấu ngay trong văn bản** (nét đứt vàng = đang bàn, chấm xanh = đã chốt; bật/tắt trong Hiển thị), bấm vào để mở. App lưu **vị trí chính xác** của phần chọn: mở một thảo luận (kể cả từ trang `/discussions`) sẽ cuộn tới và tô sáng từ cùng câu ngữ cảnh, vẫn tìm lại được nếu đoạn văn bị sửa. Khi đang mở một thảo luận, bôi chọn chữ bất kỳ → **Trích vào thảo luận**. Chốt một câu mặc định không đưa vào bảng thuật ngữ. Bảng thuật ngữ được gửi kèm như quy định bắt buộc mỗi khi dịch AI hoặc hỏi trợ lý về đoạn có thuật ngữ đó. Trang `/discussions` lọc theo sách, trạng thái, "Có hoạt động mới", "Phần được giao cho tôi"; tab Thuật ngữ đã chốt sửa/xoá/xuất TSV.
- **Nhóm dịch** (tab trên trang sách): phân công người/nhóm làm **Dịch** hoặc **Duyệt** theo sách, chương, mục (và từng đoạn từ panel thảo luận). Người **Duyệt** được chốt thuật ngữ trong phần của mình dù không phải Biên tập. Quyền: `discuss.join` (Học viên+), `glossary.manage`, `team.manage` (Biên tập+).

- **Quy trình dịch dạng đồ thị** (Cài đặt → AI dịch → Quy trình dịch: *Tự kiểm tra & sửa*): thay vì lưu ngay bản nháp đầu tiên, mỗi đoạn chạy qua một đồ thị `load → route → (single | chunked) → verify ⇄ repair → persist`. `route` chia đoạn dài thành nhiều phần dịch song song khi dùng model nhỏ; `verify` kiểm tra không tốn AI (sót câu, sai thuật ngữ đã chốt, sót tiếng Anh, chưa dịch trích dẫn, bôi đậm lệch); `repair` chỉ nhờ AI sửa đúng lỗi tìm thấy (sửa văn bản và trích dẫn chạy song song), giữ bản điểm tốt nhất; lỗi còn lại thì đoạn được đánh dấu 🚩. Mỗi lượt chạy được ghi lại (`workflow_runs`, `workflow_steps`; xem qua `GET /api/paragraphs/:id/workflows/:runId`).

## Cài đặt

```bash
npm install
cp .env.example .env   # tuỳ chọn — cấu hình riêng của máy, không bao giờ commit
```

Repo không kèm cơ sở dữ liệu, khoá API hay cấu hình AI nào: lần chạy đầu tạo một DB trống ở `server/data/`. Cấu hình nhà cung cấp AI trong **Cài đặt → AI** (khoá được mã hoá trong SQLite) hoặc qua `.env`.

**Đăng nhập lần đầu:** `admin@localhost` / `admin` — app bắt đổi mật khẩu ngay (tối thiểu 10 ký tự) trước khi dùng được gì khác. Tài khoản này chỉ được tạo khi DB chưa có người dùng nào; đặt `DEFAULT_ADMIN=0` để dùng mã thiết lập một lần thay thế (nên làm khi triển khai ra Internet).

## Chạy dev (frontend + backend cùng lúc)

```bash
npm run dev
```

- Frontend: http://localhost:5173 (Vite proxy `/api` → backend)
- Backend API: http://localhost:3001

## Build production

```bash
npm run build   # build frontend vào dist/
npm start       # chạy Express, tự phục vụ dist/ + API trên cùng 1 cổng (mặc định 3001)
```

## Kiến trúc

```
server/
  index.js            Express app, mount routes
  db.js               Khởi tạo SQLite + migration cột mới (ensureColumn)
  settingsStore.js     Đọc/ghi cấu hình nhà cung cấp AI (bảng settings)
  srs.js               Thuật toán SM-2 (spaced repetition)
  normalize.js         Chuẩn hoá + stemming nhẹ để chống trùng từ vựng
  wordTypes.js          9 loại từ + bảng ánh xạ viết tắt
  paragraphTranslation.js  Dịch 1 đoạn qua LLM + lưu + cập nhật kho từ vựng
  llm/
    index.js           Dispatcher chọn adapter theo settings.provider
    prompt.js           System prompt + user message dùng chung mọi adapter
    schema.js           JSON schema kết quả dịch dùng chung mọi adapter
    anthropicAdapter.js  Claude (tool use)
    geminiAdapter.js     Gemini (function calling, REST)
    openAICompatAdapter.js  OpenAI / Ollama / LM Studio (cùng chuẩn /chat/completions)
  importers/
    docxImporter.js     mammoth + cheerio đọc cấu trúc Part/Chapter/Mục từ .docx
    remarksParser.js     Tách cột Remark thành Phrases & Verbs / Vocabulary / Remarks
    textImporter.js      Heuristic tách Part/Chapter/Mục từ text dán tay
    persistBook.js        Ghi cây book/part/chapter/section/paragraph vào SQLite
  tts/
    kokoro_server.py    Tiến trình Python thường trực, load model Kokoro 1 lần rồi phục vụ nhiều yêu cầu qua stdin/stdout (JSON)
    kokoroProcess.js     Quản lý spawn/giao tiếp với tiến trình Python trên
    voices.js            Danh sách giọng đọc tiếng Anh được chọn lọc
  workflow/
    engine.js          Engine đồ thị: node, cạnh có điều kiện, chạy song song, giới hạn + fallback, tạm dừng/tiếp tục, ghi bước
    store.js           Bảng workflow_runs / workflow_steps
    checks.js          Kiểm tra bản dịch không cần AI (dùng cho verify và cho A/B)
    graphs/translateParagraph.js  Đồ thị dịch một đoạn
    compare.js         So sánh A/B pipeline tuyến tính và đồ thị (chạy trên bản sao DB, không lưu)
    test/*.test.mjs    Kiểm thử engine và checks (node server/workflow/test/…)
  discussions.js       Bảng thảo luận thuật ngữ, bảng thuật ngữ đã chốt (glossary), phân công; glossaryFor() đưa thuật ngữ vào prompt
  routes/
    discussions.js, glossary.js, assignments.js,
    books.js, chapters.js, sections.js, paragraphs.js, import.js, vocabulary.js, settings.js, tts.js
src/
  api.js               Fetch wrapper gọi backend
  lib/markdownLite.jsx   Render an toàn **bold**/*italic*/bullet list
  components/           Nav, BookSidebar, ParagraphCard, SectionBlock, ParagraphRemarks, StatusBadge...
  pages/                 LibraryPage, ImportPage, BookPage, ChapterPage, VocabularyPage, ReviewPage, SettingsPage
```

### Dịch kết hợp (máy dịch + model ghi chú)

Cài đặt → AI dịch → **Cách dịch: Kết hợp**. Một model chỉ-dịch (NVIDIA Riva Translate 4B Instruct trên NVIDIA Build hoặc Metta-AI-Server, hay Riva NMT qua gRPC) dịch đoạn văn; model chat được chọn làm "model ghi chú" nhận bản dịch đó trong `<base_translation>`, giữ câu chữ, chỉ sửa theo thuật ngữ đã thống nhất / lỗi nghĩa, rồi bôi đậm và ghi chú từ vựng (`server/llm/hybridPipeline.js`). Lỗi một bước thì tự lùi về bước kia và báo trên thẻ đoạn văn. Nút "Chạy thử quy trình" gọi `POST /api/settings/test-pipeline`. Test: `npm run test:hybrid` (server giả lập, DB tạm).

Danh sách model của Metta-AI-Server lấy trực tiếp từ `/models`; lần lấy thành công gần nhất được ghi nhớ (`metta.knownModels`) và hiện khi máy GPU offline.

### Cột Phrase & Remarks — 3 nhóm

- **Phrases & Verbs**: cụm/collocation ngắn, chỉ gợi ý nghĩa nhanh để đọc hiểu, KHÔNG lưu vào kho từ vựng.
- **Vocabulary**: từ/cụm đáng học (có IPA + loại từ trong 9 loại chuẩn), được lưu vào kho từ vựng để ôn tập lâu dài.
- **Remarks**: nhận xét/phân tích tự do về đoạn văn (không phải từ vựng).

### Spaced repetition

Mỗi từ trong kho có `ease_factor`, `interval_days`, `repetitions`, `due_date` (thuật toán SM-2 chuẩn, chấm theo 4 mức Again/Hard/Good/Easy kiểu Anki). Từ mới luôn có `due_date` = hôm nay nên xuất hiện ngay trong hàng đợi ôn tập. Trường `status` (Thành thạo/Đang học/Cần ôn gấp) được tự tính lại sau mỗi lần chấm để tương thích với giao diện Kho từ vựng cũ. Mỗi lần chấm còn được ghi vào bảng `review_log` (không ảnh hưởng lịch SM-2) chỉ để tính "đã ôn hôm nay" và streak — `vocabulary.due_date`/`last_reviewed_at` chỉ giữ trạng thái mới nhất, không đủ để dựng lại lịch sử.

### Kokoro TTS (đọc đoạn văn)

Dùng gói Python [`kokoro-onnx`](https://github.com/thewh1teagle/kokoro-onnx) chạy model `kokoro-v1.0.onnx` cục bộ — không phụ thuộc npm package nào (kokoro-js không tương thích trực tiếp với cặp file `.onnx` + `voices-*.bin` này). Khai báo venv và model trong `.env`: `KOKORO_PYTHON` / `KOKORO_MODEL_PATH` / `KOKORO_VOICES_PATH`; thiếu thì nút đọc báo "chưa cấu hình" (server không dừng). Tiến trình Python chỉ được spawn (và load model, mất vài giây) ở lần đọc đầu tiên, các lần sau dùng lại tiến trình đã "ấm" nên chỉ mất khoảng 1-2 giây; audio còn được cache theo hash nội dung tại `server/data/tts-cache/`.

## Tài khoản, vai trò và SSO

- **Lần chạy đầu**: khi chưa có tài khoản nào, server tạo quản trị mặc định `admin@localhost` / `admin` (bắt đổi mật khẩu khi đăng nhập). Với `DEFAULT_ADMIN=0`, server in *mã thiết lập* ra log và ghi vào `server/data/setup-token.txt`; mở app, nhập mã đó để tạo tài khoản **Quản trị** đầu tiên.
- **Dữ liệu**: sách, bản dịch, ghi chú và kho từ vựng dùng chung. Lịch ôn SRS, streak và đánh dấu đoạn (cần xem lại / bookmark / highlight) là của riêng từng người.
- **Vai trò** (gán cho người dùng, hoặc cho nhóm): Quản trị (mọi quyền, người dùng/nhóm/SSO, cài đặt AI) · Biên tập (nhập/sửa sách, dịch AI, sửa từ vựng, prompt) · Học viên (đọc, nghe, đánh dấu, ôn tập) · Khách (chỉ đọc). Bảng quyền đầy đủ: Cài đặt → Người dùng & nhóm → Vai trò, hoặc `server/auth/permissions.js`. Máy chủ kiểm tra quyền ở từng API; API chưa khai báo quyền bị chặn.
- **Quản lý**: Cài đặt → Người dùng & nhóm. Thêm người dùng tạo mật khẩu tạm hiện một lần; người dùng phải đổi khi đăng nhập lần đầu.
- **SSO (Keycloak hoặc nhà cung cấp OIDC khác, PKCE)**: ở chế độ chờ. Cài đặt → Người dùng & nhóm → SSO có Redirect URI và các bước tạo client trong Keycloak; điền Issuer (`https://<máy-chủ-sso>/realms/<realm>`), Client ID/secret, ánh xạ role (`books-admin`, `books-editor`, `books-learner`, `books-guest`), bấm Kiểm tra kết nối rồi bật. Tài khoản cùng email được tự liên kết; người dùng mới có thể được tự tạo với vai trò mặc định.
- **Bảo mật**: phiên lưu phía server (cookie HttpOnly, SameSite=Lax, Secure khi chạy https), mật khẩu băm scrypt, chống CSRF bằng header riêng, khoá tạm sau 8 lần đăng nhập sai trong 15 phút, luôn giữ ít nhất một Quản trị đang hoạt động.

## Lưu ý POC

- API key các nhà cung cấp AI lưu trong SQLite (chỉ vai trò Quản trị xem/sửa được) — giữ file `server/data/books.db` ở nơi an toàn.
- Ollama/LM Studio cần model đã tải/nạp hỗ trợ tool calling (vd. llama3.1, qwen2.5) để nhận đúng JSON có cấu trúc.
- Văn bản rất dài nên chia nhỏ trước khi dịch; "Dịch tất cả đoạn còn thiếu" chạy tuần tự từng đoạn trong một chương để tránh timeout.
- Nút 🔊 Đọc chỉ đọc phần tiếng Anh — Kokoro không hỗ trợ phát âm tiếng Việt.

## Giấy phép

[MIT](LICENSE). Giấy phép áp dụng cho mã nguồn; nội dung sách bạn nhập vào app thuộc bản quyền của tác giả/nhà xuất bản.
