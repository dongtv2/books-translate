// Roles and permissions, by feature of the app.
//
// Roles are fixed in code (the features they unlock are code too); who has
// which role is data: assigned to a user directly, or to a group the user
// belongs to, or mapped from SSO roles. A user's permissions are the union
// of the permissions of all their roles.

export const PERMISSIONS = {
  'books.read': 'Đọc sách, nghe đọc đoạn văn',
  'vocab.read': 'Xem kho từ vựng',
  'vocab.own': 'Thêm từ riêng, lập danh sách “Từ của tôi”, đề xuất từ vào kho chung',
  'marks.own': 'Đánh dấu đoạn (cần xem lại, bookmark, highlight) của riêng mình',
  'review.own': 'Ôn tập từ vựng theo lịch của riêng mình',
  'books.edit': 'Nhập, sửa, sắp xếp, xoá sách, chương, mục, đoạn văn',
  'translate.run': 'Dịch đoạn văn bằng AI',
  'assistant.use': 'Hỏi đáp và phân tích bản dịch với trợ lý AI',
  'discuss.join': 'Thảo luận, đề xuất và bình chọn cách dịch từ/cụm từ',
  'vocab.edit': 'Sửa, xoá mục trong kho từ vựng',
  'prompts.manage': 'Quản lý thư viện prompt dịch',
  'glossary.manage': 'Chốt cách dịch, sửa bảng thuật ngữ đã thống nhất',
  'team.manage': 'Phân công người dịch, người duyệt theo sách/chương/mục/đoạn',
  'settings.ai': 'Cấu hình nhà cung cấp AI',
  'users.manage': 'Quản lý người dùng, nhóm, vai trò và SSO',
};

const GUEST = ['books.read', 'vocab.read'];
const LEARNER = [...GUEST, 'marks.own', 'review.own', 'vocab.own', 'assistant.use', 'discuss.join'];
const EDITOR = [...LEARNER, 'books.edit', 'translate.run', 'vocab.edit', 'prompts.manage', 'glossary.manage', 'team.manage'];
const ADMIN = Object.keys(PERMISSIONS);

export const ROLES = {
  admin: { label: 'Quản trị', description: 'Toàn quyền, gồm quản lý người dùng, nhóm, SSO và cài đặt AI.', permissions: ADMIN },
  editor: { label: 'Biên tập', description: 'Nhập và sửa sách, dịch bằng AI, chốt thuật ngữ, phân công nhóm, sửa kho từ vựng và prompt.', permissions: EDITOR },
  learner: { label: 'Học viên', description: 'Đọc, nghe, đánh dấu đoạn, thảo luận cách dịch, hỏi trợ lý AI và ôn tập từ vựng của riêng mình.', permissions: LEARNER },
  guest: { label: 'Khách', description: 'Chỉ đọc sách và xem kho từ vựng.', permissions: GUEST },
};

export const ROLE_KEYS = Object.keys(ROLES);

export function permissionsFor(roles) {
  const set = new Set();
  for (const r of roles) for (const p of ROLES[r]?.permissions || []) set.add(p);
  return [...set];
}

// Every API route and the permission it needs. Matched top to bottom; a
// route that is not listed is refused (see middleware.js), so a new endpoint
// has to be given a permission here before it can be used.
//   need: a permission, or an array meaning "any of these" (the route then
//         checks the finer rule itself), or null for "any signed-in user".
export const ROUTE_RULES = [
  // books, chapters, sections, parts, import
  ['GET', /^\/api\/books\/\d+\/marks$/, 'marks.own'],
  ['GET', /^\/api\/books(\/\d+)?$/, 'books.read'],
  // who may see a book: read by anyone who sees it, changed by admins or
  // the book's owner (checked in the route)
  ['GET', /^\/api\/books\/\d+\/access$/, 'books.read'],
  // cover image: seen by readers, changed by editors
  ['GET', /^\/api\/books\/\d+\/cover\/(lg|sm)$/, 'books.read'],
  ['*', /^\/api\/books\/\d+\/cover$/, 'books.edit'],
  ['PUT', /^\/api\/books\/\d+\/access$/, ['books.edit', 'users.manage']],
  ['GET', /^\/api\/chapters\/\d+$/, 'books.read'],
  ['POST', /^\/api\/books$/, 'books.edit'],
  ['PATCH', /^\/api\/books\/\d+$/, 'books.edit'],
  ['POST', /^\/api\/books\/\d+\/suggest-(context|genre)$/, 'books.edit'],
  ['DELETE', /^\/api\/books\/\d+$/, 'books.edit'],
  ['POST', /^\/api\/books\/\d+\/(parts|chapters)$/, 'books.edit'],
  ['*', /^\/api\/(parts|sections)\//, 'books.edit'],
  ['PATCH', /^\/api\/chapters\/\d+$/, 'books.edit'],
  ['DELETE', /^\/api\/chapters\/\d+$/, 'books.edit'],
  ['POST', /^\/api\/chapters\/\d+\/(move|paragraphs|sections)$/, 'books.edit'],
  ['POST', /^\/api\/import\//, 'books.edit'],
  // paragraphs: marks are per-user (marks.own), text needs books.edit —
  // decided inside the route by which fields are sent
  ['PATCH', /^\/api\/paragraphs\/\d+$/, ['marks.own', 'books.edit']],
  ['DELETE', /^\/api\/paragraphs\/\d+$/, 'books.edit'],
  ['POST', /^\/api\/paragraphs\/\d+\/translate$/, 'translate.run'],
  ['GET', /^\/api\/paragraphs\/\d+\/workflows(\/\d+)?$/, 'translate.run'],
  // translation assistant: each user's own chat about a paragraph; applying
  // a proposed translation changes the shared text, so it needs books.edit
  ['POST', /^\/api\/paragraphs\/\d+\/assistant\/\d+\/(approve|revert)$/, 'books.edit'],
  ['*', /^\/api\/paragraphs\/\d+\/assistant(\/\d+\/reject|\/field)?$/, 'assistant.use'],
  // read-aloud
  ['GET', /^\/api\/tts\/voices$/, 'books.read'],
  ['POST', /^\/api\/tts\/speak$/, 'books.read'],
  // vocabulary: shared entries, per-user review progress
  ['GET', /^\/api\/vocabulary\/(review|due|review-stats)$/, 'review.own'],
  ['GET', /^\/api\/vocabulary(\/stats|\/topics)?$/, 'vocab.read'],
  ['POST', /^\/api\/vocabulary\/\d+\/review$/, 'review.own'],
  // an entry's content: vocab.edit for shared words, vocab.own for one's own
  // (checked in the route by whose word it is)
  ['PATCH', /^\/api\/vocabulary\/\d+$/, ['review.own', 'vocab.edit', 'vocab.own']],
  ['DELETE', /^\/api\/vocabulary\/\d+$/, ['vocab.edit', 'vocab.own']],
  ['*', /^\/api\/vocabulary\/\d+\/(mine|propose)$/, 'vocab.own'],
  ['GET', /^\/api\/vocabulary\/proposals$/, 'vocab.edit'],
  // a shared word's meaning in one book
  ['POST', /^\/api\/vocabulary\/\d+\/senses$/, 'vocab.edit'],
  ['*', /^\/api\/vocabulary\/senses\/\d+$/, 'vocab.edit'],
  ['POST', /^\/api\/vocabulary\/proposals\/\d+\/(approve|reject)$/, 'vocab.edit'],
  ['POST', /^\/api\/vocabulary\/classify-topics$/, 'vocab.edit'],
  ['POST', /^\/api\/vocabulary(\/suggest)?$/, ['vocab.edit', 'vocab.own']],
  ['GET', /^\/api\/vocabulary\/(export|duplicates|\d+\/links)$/, 'vocab.read'],
  ['POST', /^\/api\/vocabulary\/(import|merge|duplicates\/dismiss)$/, 'vocab.edit'],
  // genres (thể loại) of books and words: read with the vocabulary, managed
  // by vocabulary editors; one word's genres are corrected the same way
  ['GET', /^\/api\/genres$/, 'vocab.read'],
  ['*', /^\/api\/genres(\/\d+)?$/, 'vocab.edit'],
  ['PUT', /^\/api\/vocabulary\/\d+\/genres$/, 'vocab.edit'],
  // term discussions: anyone who reads may follow them; taking part needs
  // discuss.join; deciding is checked in the route (glossary.manage, or a
  // reviewer assigned to that part of the book); deleting a post/thread too
  ['GET', /^\/api\/discussions(\/summary|\/\d+)?$/, 'books.read'],
  ['POST', /^\/api\/discussions\/\d+\/(resolve|reopen|close|reopen-discussion)$/, 'discuss.join'],
  ['*', /^\/api\/discussions(\/\d+(\/posts)?|\/posts\/\d+(\/vote)?)?$/, 'discuss.join'],
  // the decided glossary
  ['GET', /^\/api\/glossary$/, 'books.read'],
  ['*', /^\/api\/glossary(\/\d+)?$/, 'glossary.manage'],
  // team assignments
  ['GET', /^\/api\/assignments(\/mine)?$/, 'books.read'],
  ['*', /^\/api\/assignments(\/people|\/\d+)?$/, 'team.manage'],
  // prompts and AI settings
  ['GET', /^\/api\/prompts$/, ['books.edit', 'prompts.manage']],
  ['*', /^\/api\/prompts/, 'prompts.manage'],
  ['*', /^\/api\/settings/, 'settings.ai'],
  // the signed-in user's own workspace (reading position, preferences, home)
  ['*', /^\/api\/me\//, null],
  // user management
  ['*', /^\/api\/admin\//, 'users.manage'],
];

export function ruleFor(method, path) {
  for (const [m, re, need] of ROUTE_RULES) {
    if ((m === '*' || m === method) && re.test(path)) return { need };
  }
  return null;
}
