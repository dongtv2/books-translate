# Thiết kế: PostgreSQL + chuẩn mục lục (TOC) sách

Trạng thái: **đề xuất** (2026-10-12). Mục tiêu: 500 → 2.000+ sách, nhóm dịch
làm việc đồng thời, mọi sách có cùng một cấu trúc Mục lục → Chương → Mục → Đoạn.

## 1. Vì sao PostgreSQL, và cái giá

| | SQLite (hiện tại) | PostgreSQL |
|---|---|---|
| Ghi đồng thời | 1 writer, các lượt ghi xếp hàng | MVCC, nhiều người sửa cùng lúc |
| Tìm kiếm | `LIKE`, xếp hạng bằng JS | `tsvector` + `unaccent` (tiếng Việt không dấu), `pg_trgm` (gõ sai, gần đúng) |
| Backup | `VACUUM INTO` đồng bộ, chặn server | `pg_dump` / WAL archiving, point-in-time recovery |
| Vận hành | 1 file, 1 tiến trình | Thêm 1 dịch vụ (Homebrew/Docker hoặc managed) |

**Cái giá:** server có 467 lời gọi `db.prepare` và 39 `db.transaction` (better-sqlite3,
**đồng bộ**) trong 36 file. `pg` là **bất đồng bộ** nên mọi route/hàm truy cập DB phải
thành `async`, và transaction phải giữ một connection (`BEGIN … COMMIT`). Vì thế việc
chuyển đổi đi qua một lớp truy cập dữ liệu (§5, giai đoạn 1) chứ không sửa thẳng.

Đổi DB **cùng lúc** với đổi cấu trúc TOC: chỉ một lần migrate dữ liệu, không hai.

## 2. Chuẩn TOC (áp dụng cho mọi sách)

```
Sách (books)
├─ Phần đầu sách  (front matter)  Lời đề tặng, Lời tựa, Giới thiệu, Về tác giả…
├─ Thân sách      (body)
│   ├─ Phần  [level 1, tuỳ chọn]   PART ONE / PHẦN I
│   │   └─ Chương [level 2, bắt buộc]  Chương 3 — Kamma: the Real Inheritance
│   │       └─ Mục [level 3]           (heading trong chương)
│   │           └─ Tiểu mục [level 4]  (tối đa)
│   │               └─ Đoạn (block)
└─ Phần cuối sách (back matter)   Phụ lục, Bảng thuật ngữ, Lời cảm tạ, Chú thích…
```

Quy tắc:

1. **Mọi heading là một nút TOC, không bao giờ là một đoạn văn.** Đoạn (block) chỉ
   chứa nội dung. (Hiện tại *Art of Dying* có heading nằm trong đoạn đầu mỗi chương;
   *Hold On* thì Phần/Chương bị lệch — cả hai được chuẩn hoá khi migrate.)
2. **Đoạn thuộc về nút lá gần nhất**: chương, mục hoặc tiểu mục. Một chương có thể có
   đoạn mở đầu trước mục đầu tiên.
3. **Cha – con hợp lệ:** `part → chapter`, `chapter → section`, `section → subsection`.
   Front/back matter là nút cấp chương (`kind = 'front' | 'back'`), không có số.
4. **Song ngữ:** mỗi nút có `title_en` và `title_vi`; nhãn số (`Chương 3`, `PHẦN I`)
   được **sinh tự động**, không gõ tay vào tiêu đề.
5. **Đánh số** chỉ đếm chương thân sách; front/back matter không đánh số.
6. **Loại đoạn** (`block_type`): `paragraph`, `verse` (thơ/kệ, giữ xuống dòng),
   `quote`, `epigraph`, `list`, `note`, `glossary_entry`. Đọc, dịch AI và TTS xử lý
   theo loại (ví dụ `verse` không gộp dòng).
7. **Mã tham chiếu ổn định** cho mỗi đoạn: `<mã sách>-<số chương>-<số thứ tự>`
   (ví dụ `AOD-12-034`) + `seg_no` gốc của worksheet nhóm dịch nếu có.

Từ điển nhận diện front/back matter (EN/VI, không phân biệt hoa thường): Dedication /
Kính dâng, Preface / Lời tựa / Lời dẫn, Foreword / Lời nói đầu, Introduction / Giới
thiệu, About the Author, Acknowledgments / Lời cảm tạ, Appendix / Phụ lục, Glossary /
Bảng thuật ngữ, Notes / Chú thích, Bibliography / Tài liệu tham khảo, Index.

## 3. Lược đồ PostgreSQL (phần nội dung sách)

```sql
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- unaccent() is not IMMUTABLE, so a generated column needs this wrapper.
CREATE FUNCTION immutable_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT public.unaccent('public.unaccent', $1) $$;

CREATE TYPE toc_kind   AS ENUM ('front', 'part', 'chapter', 'section', 'subsection', 'back');
CREATE TYPE block_type AS ENUM ('paragraph', 'verse', 'quote', 'epigraph', 'list', 'note', 'glossary_entry');
CREATE TYPE block_status AS ENUM ('pending', 'draft', 'reviewed', 'final');

CREATE TABLE books (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          text UNIQUE,                 -- 'AOD', dùng cho mã tham chiếu đoạn
  title_en      text NOT NULL,
  title_vi      text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}', -- tác giả, NXB, ISBN, … (thay hàng loạt cột text)
  domain        text NOT NULL DEFAULT '',
  specialty     text NOT NULL DEFAULT '',
  context_note  text NOT NULL DEFAULT '',
  visibility    text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'restricted')),
  owner_id      bigint REFERENCES users(id) ON DELETE SET NULL,
  block_count   int NOT NULL DEFAULT 0,      -- giữ bằng trigger, cho trang thư viện
  final_count   int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Toàn bộ mục lục: một cây duy nhất thay cho parts / chapters / sections.
CREATE TABLE toc_nodes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id    bigint NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  parent_id  bigint REFERENCES toc_nodes(id) ON DELETE CASCADE,
  kind       toc_kind NOT NULL,
  position   int NOT NULL,                  -- thứ tự trong cùng cha
  number     int,                           -- số chương/phần, sinh tự động; NULL cho front/back
  title_en   text NOT NULL DEFAULT '',
  title_vi   text NOT NULL DEFAULT '',
  in_toc     boolean NOT NULL DEFAULT true, -- ẩn khỏi mục lục (vd. trang bản quyền)
  UNIQUE (parent_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ON toc_nodes (book_id, parent_id, position);
-- Cha – con hợp lệ (quy tắc 3) kiểm tra bằng trigger BEFORE INSERT/UPDATE.

CREATE TABLE blocks (                       -- thay cho paragraphs
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id       bigint NOT NULL REFERENCES books(id) ON DELETE CASCADE,  -- denormalized
  chapter_id    bigint NOT NULL REFERENCES toc_nodes(id),                -- nút cấp chương chứa nó
  node_id       bigint NOT NULL REFERENCES toc_nodes(id) ON DELETE CASCADE, -- nút lá trực tiếp
  position      int NOT NULL,
  ref           text NOT NULL,              -- 'AOD-12-034'
  seg_no        text,                       -- số SEG trong worksheet nhóm dịch
  block_type    block_type NOT NULL DEFAULT 'paragraph',
  source_md     text NOT NULL,              -- English
  target_md     text NOT NULL DEFAULT '',   -- Tiếng Việt (bản chính)
  phrases_md    text NOT NULL DEFAULT '',
  vocabulary_md text NOT NULL DEFAULT '',
  citation_en_md text NOT NULL DEFAULT '',
  citation_vi_md text NOT NULL DEFAULT '',
  notes_md      text NOT NULL DEFAULT '',
  status        block_status NOT NULL DEFAULT 'pending',
  version       int NOT NULL DEFAULT 1,     -- optimistic locking: UPDATE … WHERE version = $n
  search_en     tsvector GENERATED ALWAYS AS (to_tsvector('english', source_md)) STORED,
  search_vi     tsvector GENERATED ALWAYS AS (to_tsvector('simple', immutable_unaccent(target_md))) STORED,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_id, position) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (ref)
);
CREATE INDEX ON blocks (chapter_id, position);
CREATE INDEX ON blocks (book_id, status);
CREATE INDEX ON blocks USING gin (search_en);
CREATE INDEX ON blocks USING gin (search_vi);

-- Các bản dịch khác của một đoạn (bản đã xuất bản, draft, review, AI) — thay cho việc
-- nhét bản cũ vào ghi chú.
CREATE TABLE block_versions (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  block_id  bigint NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  label     text NOT NULL,                  -- 'published-2019', 'draft', 'review-1', 'ai:claude'
  target_md text NOT NULL,
  author_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Từ vựng xuất hiện ở đoạn nào: thay việc quét toàn bộ kho từ / toàn bộ đoạn văn.
CREATE TABLE term_occurrences (
  vocabulary_id bigint REFERENCES vocabulary(id) ON DELETE CASCADE,
  block_id      bigint REFERENCES blocks(id) ON DELETE CASCADE,
  book_id       bigint NOT NULL,
  chapter_id    bigint NOT NULL,
  PRIMARY KEY (vocabulary_id, block_id)
);
CREATE INDEX ON term_occurrences (chapter_id);
CREATE INDEX ON vocabulary USING gin (term gin_trgm_ops);
```

Các bảng đang trỏ tới `chapter_id` / `section_id` / `paragraph_id` (thảo luận thuật
ngữ, phân công, vị trí đọc, đánh dấu, lịch sử trợ lý, workflow) đổi sang
`node_id` (bất kỳ cấp TOC nào) và `block_id`. Phân công "cả chương" hay "một mục"
khi đó chỉ là `node_id` ở cấp tương ứng.

Truy vấn chính sau khi đổi:

| Màn hình | Hiện tại | Sau khi đổi |
|---|---|---|
| Thư viện | `COUNT` lồng qua 3 bảng cho mỗi sách | đọc `books.block_count / final_count` |
| Mục lục sách | 3 truy vấn + ghép trong JS | 1 truy vấn `toc_nodes WHERE book_id` + `GROUP BY node_id` trên `blocks` |
| Mở chương | quét toàn bộ kho từ vựng | `term_occurrences WHERE chapter_id = $1` |
| Xem một từ ở đâu | tải mọi đoạn của mọi sách | `term_occurrences WHERE vocabulary_id = $1` |
| Tìm kiếm | `LIKE '%q%'` | `search_en @@ websearch_to_tsquery(...)`, `search_vi` không dấu |

Không cần partition: 6 triệu đoạn vẫn là quy mô nhỏ với Postgres khi có index trên
`book_id` / `chapter_id`.

## 4. Nhập sách theo chuẩn: Book IR

Mọi importer (docx 3 cột, worksheet nhóm dịch, text dán, docx tiếng Anh thuần) đều
xuất ra **một định dạng trung gian** thay vì ghi thẳng vào DB:

```json
{
  "book": { "code": "AOD", "title_en": "The Art of Dying", "title_vi": "Nghệ thuật chết", "meta": {} },
  "nodes": [
    { "kind": "front",   "title_en": "Preface", "title_vi": "Lời tựa", "blocks": [ … ] },
    { "kind": "chapter", "title_en": "Kamma—the Real Inheritance", "title_vi": "Nghiệp – Sự thừa kế đích thực",
      "children": [ { "kind": "section", "title_en": "…", "blocks": [ … ] } ],
      "blocks": [ { "type": "paragraph", "seg": "1", "en": "…", "vi": "…", "versions": { "published-2019": "…" } } ] }
  ]
}
```

Luồng: **parse → chuẩn hoá → kiểm tra → xem trước → ghi**.

- **Chuẩn hoá:** đoạn đầu chương mà chỉ là tiêu đề (in đậm, ngắn, trùng tên file/chương)
  sẽ được bóc ra thành `title_en/title_vi`. Tiêu đề khớp từ điển §2 thì thành front/back.
  Heading Word: nếu `H1` chứa nhiều `H2` thì `H1` = Phần, `H2` = Chương; nếu không
  thì `H1` = Chương. Tiêu đề bị ngắt dòng ("Equanimity in the" + dòng sau) được nối lại.
- **Kiểm tra (validator):** sai cha – con, chương rỗng, đoạn EN rỗng, số đoạn EN/VI
  lệch trong một ô, trùng `seg`.
- **Xem trước:** màn hình cây TOC cho phép nâng/hạ cấp, đổi loại front/body/back, gộp/
  tách trước khi bấm Nhập. Cùng màn hình này dùng để chỉnh TOC sách đã có.

## 5. Lộ trình (mỗi giai đoạn có cổng kiểm tra và đường lùi)

| GĐ | Việc | Cổng kiểm tra | Lùi |
|---|---|---|---|
| 0 | Chuẩn TOC + Book IR + validator; importer xuất IR; chuẩn hoá 2 sách hiện có (vẫn SQLite) | Validator sạch trên cả 2 sách; mục lục hiển thị đúng | Bản backup trước khi chuẩn hoá |
| 1 | Lớp truy cập dữ liệu `server/data/*Repo.js`, **async**, mọi route đi qua đó (vẫn SQLite) | `npm test` + lint + build; so JSON của mọi API trước/sau | Git revert |
| 2 | Lược đồ Postgres §3 + script migrate SQLite → PG (TOC mới, `term_occurrences`, FTS) | Đếm dòng khớp; so JSON của mọi chương, mọi sách giữa 2 backend | DB SQLite vẫn nguyên |
| 3 | Chạy app trên PG (`DATABASE_URL`), SQLite giữ chỉ đọc 2 tuần | Test + thử tay các trang chính; backup `pg_dump` + khôi phục thử | Đổi lại biến môi trường |
| 4 | Màn hình chỉnh TOC + nhập hàng loạt | — | — |

Kỹ thuật cho giai đoạn 1–3: thư viện `postgres` (postgres.js) hoặc `pg` + query builder
nhẹ; transaction bằng `sql.begin(async (tx) => …)`; optimistic locking bằng cột
`version` để hai người sửa một đoạn không âm thầm ghi đè nhau; test chạy trên một
database PG tạm tạo/xoá mỗi lượt (thay cho bản sao file SQLite).

## 6. Trạng thái

### GĐ 0a — xong (2026-10-12)

- `server/toc.js`: chuẩn TOC trên SQLite (chỉ **thêm** cột): `chapters.kind / title_vi /
  title_original`, `parts.title_vi / title_original`, `sections.heading_vi /
  heading_original`, `paragraphs.block_type / seg_no`, bảng log `toc_changes`.
  Số chương / nhãn "Chương 3", "Phần 2" tính khi đọc, không lưu.
- API: `GET /api/books/:id`, `GET /api/chapters/:id` trả thêm `kind`, `number`, `label`,
  `title_vi`, `heading_vi`; `PATCH` chương/phần/mục nhận `title_vi`, `heading_vi`, `kind`
  (chương chỉ được gắn vào Phần của chính sách nó).
- Giao diện: mục lục chia Phần đầu sách / thân sách (đánh số) / Phần cuối sách, tiêu đề
  song ngữ ở trang sách, thanh bên và đầu trang chương; sửa loại chương trong menu ⋮.
- `npm run toc:normalize -- --book <id> [--spec <file>] [--apply]` và `--undo <run>`.
  Spec mục lục của *The Art of Dying*: `server/scripts/toc-specs/art-of-dying.json`.
- Đã áp dụng lên dữ liệu thật: sách #2 (26 → 35 chương: 7 đầu sách, 24 chương, 4 cuối
  sách; 16 đoạn chỉ chứa tiêu đề được chuyển thành tiêu đề), sách #1 (bỏ tiền tố
  "PART n :", "CHAPTER n:"; chương cuối giờ là Chương 8).
- Kiểm tra: `npm run test:toc` (10 kiểm tra, nằm trong `npm test`), lint, build, thử tay
  trang sách / trang chương trên bản sao dữ liệu.

**Khi có lỗi**

| Triệu chứng | Làm gì |
|---|---|
| Nhãn "Chương n" / nhóm đầu–cuối sách hiển thị sai | Đặt `TOC_STANDARD=0` rồi khởi động lại server: giao diện về như cũ, dữ liệu giữ nguyên |
| Một sách bị tách/gộp chương sai | `npm run toc:normalize -- --undo <run id>` (run id in ở cuối lượt áp dụng, hoặc `SELECT DISTINCT run_id FROM toc_changes WHERE book_id = ?`) — trả lại từng dòng như trước |
| Cần quay về hẳn | Mỗi lượt `--apply` có backup `books-…-pre-migration.db` (Quản trị → Dữ liệu); khôi phục bằng `npm run db:restore -- <file>` khi server dừng |
| Script dừng với "đang được tham chiếu" | Đoạn chỉ chứa tiêu đề có người đánh dấu/thảo luận: xử lý tay đoạn đó rồi chạy lại; lượt bị dừng không ghi gì |

Bổ sung 2026-10-12: tiêu đề song ngữ cho cả hai sách qua `--titles`
(`server/scripts/toc-titles/*.json`). Hold On: tiêu đề tiếng Anh IN HOA → Title Case, sửa lỗi
nhập (Attachments Compete, Family Ties, Flatlining), dịch mới toàn bộ tên Phần/chương/mục
theo thuật ngữ đã dùng trong bản dịch; Art of Dying: giữ lời dịch của nhóm, chỉ thống nhất
văn phong. Quy ước: tiếng Anh Title Case; tiếng Việt viết hoa chữ đầu và sau dấu hai chấm,
gạch nối có cách " – ", tên người đứng trước như mục lục bản gốc.

Bổ sung 2026-10-12 (2): `--outline <file>` dựng đủ mục lục gốc của sách
(`server/scripts/toc-outlines/*.json`): chương đã có khớp theo tên tiếng Anh và nhận đúng tên
in trong sách; chương chưa nhập được tạo trống. Chương chưa có đoạn nào chỉ biên tập viên thấy
(mục lục, thanh bên, chương trước/sau); số chương vẫn theo bản gốc. Hold On đã có đủ 6 phần,
21 chương, phần đầu/cuối sách (lượt `toc-1-20261012125101-93fe`). Mục lục dạng cây thụt lề
(Phần → Chương → Mục 3.1…), mục không tiêu đề là đoạn mở đầu chương, không vào mục lục.
Thanh bên kéo rộng được (224–560 px, nhớ theo trình duyệt).

Còn lại cho GĐ 0b: Book IR + validator, các importer xuất IR và tự tách tiêu đề; bảng
các bản dịch khác của đoạn (`paragraph_versions`) thay cho ghi chú "Bản dịch trước" của
*Art of Dying*; hiển thị theo `block_type` (thơ/kệ giữ xuống dòng, đề từ).
