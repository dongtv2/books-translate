const BASE = '/api';

// Sent with every request; the server refuses data-changing requests
// without it (CSRF protection, see server/auth/middleware.js).
const CSRF_HEADER = { 'X-Books-Translate': '1' };

// A 401 means the session ended (signed out elsewhere, expired, account
// disabled); AuthContext listens and shows the sign-in screen.
function signalUnauthorized(res, path) {
  if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('bt:unauthorized'));
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: options.body instanceof FormData ? CSRF_HEADER : { 'Content-Type': 'application/json', ...CSRF_HEADER },
  });
  signalUnauthorized(res, path);
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(body?.error || `Yêu cầu thất bại (${res.status})`);
    err.status = res.status;
    err.code = body?.code;
    err.data = body;
    throw err;
  }
  return body;
}

// For endpoints that return raw audio bytes instead of JSON.
async function requestBlob(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...CSRF_HEADER },
  });
  signalUnauthorized(res, path);
  if (!res.ok) {
    const isJson = res.headers.get('content-type')?.includes('application/json');
    const body = isJson ? await res.json().catch(() => null) : null;
    throw new Error(body?.error || `Yêu cầu thất bại (${res.status})`);
  }
  return res.blob();
}

// "?a=1&b=x" from an object, leaving out empty values.
function query(params = {}) {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null))).toString();
  return qs ? `?${qs}` : '';
}

export const api = {
  health: () => request('/health'),

  // Auth
  me: () => request('/auth/me'),
  setup: (payload) => request('/auth/setup', { method: 'POST', body: JSON.stringify(payload) }),
  login: (email, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword, newPassword) => request('/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),

  // The signed-in user's own workspace
  myHome: () => request('/me/home'),
  myReading: () => request('/me/reading'),
  saveReading: (chapterId, paragraphId = null) => request('/me/reading', { method: 'PUT', body: JSON.stringify({ chapterId, paragraphId }) }),
  myPreferences: () => request('/me/preferences'),
  savePreferences: (prefs) => request('/me/preferences', { method: 'PUT', body: JSON.stringify(prefs) }),

  // User management (admin)
  adminRoles: () => request('/admin/roles'),
  adminActivity: (params = {}) => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null && v !== false))).toString();
    return request(`/admin/activity${qs ? `?${qs}` : ''}`);
  },
  adminActivitySummary: (days = 30) => request(`/admin/activity/summary?days=${days}`),
  adminActivityHealth: () => request('/admin/activity/health'),
  adminDbStatus: () => request('/admin/database/status'),
  adminBackups: () => request('/admin/database/backups'),
  adminCreateBackup: (note = '') => request('/admin/database/backups', { method: 'POST', body: JSON.stringify({ note }) }),
  adminBackupUrl: (name) => `${BASE}/admin/database/backups/${encodeURIComponent(name)}/download`,
  adminIntegrity: () => request('/admin/database/integrity', { method: 'POST' }),
  adminMerges: () => request('/admin/database/merges'),
  adminUndoMerge: (id) => request(`/admin/database/merges/${id}/undo`, { method: 'POST' }),
  adminUsers: () => request('/admin/users'),
  adminCreateUser: (payload) => request('/admin/users', { method: 'POST', body: JSON.stringify(payload) }),
  adminUpdateUser: (id, patch) => request(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  adminResetPassword: (id) => request(`/admin/users/${id}/reset-password`, { method: 'POST' }),
  adminDeleteUser: (id) => request(`/admin/users/${id}`, { method: 'DELETE' }),
  adminGroups: () => request('/admin/groups'),
  adminCreateGroup: (payload) => request('/admin/groups', { method: 'POST', body: JSON.stringify(payload) }),
  adminUpdateGroup: (id, patch) => request(`/admin/groups/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  adminDeleteGroup: (id) => request(`/admin/groups/${id}`, { method: 'DELETE' }),
  adminSso: () => request('/admin/sso'),
  adminSaveSso: (patch) => request('/admin/sso', { method: 'PUT', body: JSON.stringify(patch) }),
  adminTestSso: (issuer) => request('/admin/sso/test', { method: 'POST', body: JSON.stringify({ issuer }) }),

  // Books
  listBooks: () => request('/books'),
  createBook: (payload) => request('/books', { method: 'POST', body: JSON.stringify(payload) }),
  suggestBookContext: (id) => request(`/books/${id}/suggest-context`, { method: 'POST' }),
  suggestBookGenre: (id) => request(`/books/${id}/suggest-genre`, { method: 'POST' }),
  getBook: (id) => request(`/books/${id}`),
  updateBook: (id, patch) => request(`/books/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteBook: (id) => request(`/books/${id}`, { method: 'DELETE' }),
  addPart: (bookId, title) => request(`/books/${bookId}/parts`, { method: 'POST', body: JSON.stringify({ title }) }),
  addChapter: (bookId, payload) => request(`/books/${bookId}/chapters`, { method: 'POST', body: JSON.stringify(payload) }),

  // Parts
  updatePart: (id, patch) => request(`/parts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePart: (id) => request(`/parts/${id}`, { method: 'DELETE' }),
  movePart: (id, direction) => request(`/parts/${id}/move`, { method: 'POST', body: JSON.stringify({ direction }) }),

  // Chapters
  getChapter: (id) => request(`/chapters/${id}`),
  updateChapter: (id, patch) => request(`/chapters/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteChapter: (id) => request(`/chapters/${id}`, { method: 'DELETE' }),
  moveChapter: (id, direction) => request(`/chapters/${id}/move`, { method: 'POST', body: JSON.stringify({ direction }) }),
  addSection: (chapterId, payload) => request(`/chapters/${chapterId}/sections`, { method: 'POST', body: JSON.stringify(payload) }),
  addParagraphsToChapter: (chapterId, text) => request(`/chapters/${chapterId}/paragraphs`, { method: 'POST', body: JSON.stringify({ text }) }),

  // Sections
  updateSection: (id, patch) => request(`/sections/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSection: (id) => request(`/sections/${id}`, { method: 'DELETE' }),
  moveSection: (id, direction) => request(`/sections/${id}/move`, { method: 'POST', body: JSON.stringify({ direction }) }),
  addParagraphs: (sectionId, text) => request(`/sections/${sectionId}/paragraphs`, { method: 'POST', body: JSON.stringify({ text }) }),

  // Paragraphs
  updateParagraph: (id, patch) => request(`/paragraphs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteParagraph: (id) => request(`/paragraphs/${id}`, { method: 'DELETE' }),
  // translation assistant (server/assistant.js)
  getAssistant: (id) => request(`/paragraphs/${id}/assistant`),
  askAssistant: (id, { message = '', skill = '' }) => request(`/paragraphs/${id}/assistant`, { method: 'POST', body: JSON.stringify({ message, skill }) }),
  createVocab: (entry) => request('/vocabulary', { method: 'POST', body: JSON.stringify(entry) }),
  suggestVocab: ({ term, paragraphId }) => request('/vocabulary/suggest', { method: 'POST', body: JSON.stringify({ term, paragraphId }) }),
  askField: (id, body) => request(`/paragraphs/${id}/assistant/field`, { method: 'POST', body: JSON.stringify(body) }),
  clearAssistant: (id) => request(`/paragraphs/${id}/assistant`, { method: 'DELETE' }),
  approveRevision: (id, messageId, { text, force = false } = {}) => request(`/paragraphs/${id}/assistant/${messageId}/approve`, { method: 'POST', body: JSON.stringify({ text, force }) }),
  rejectRevision: (id, messageId) => request(`/paragraphs/${id}/assistant/${messageId}/reject`, { method: 'POST' }),
  revertRevision: (id, messageId) => request(`/paragraphs/${id}/assistant/${messageId}/revert`, { method: 'POST' }),
  translateParagraph: (id, payload = {}) => request(`/paragraphs/${id}/translate`, { method: 'POST', body: JSON.stringify(payload) }),

  // Term discussions, the decided glossary and team assignments
  // (server/discussions.js)
  listThreads: (params = {}) => request(`/discussions${query(params)}`),
  threadSummary: () => request('/discussions/summary'),
  getThread: (id) => request(`/discussions/${id}`),
  createThread: (payload) => request('/discussions', { method: 'POST', body: JSON.stringify(payload) }),
  addThreadPost: (id, payload) => request(`/discussions/${id}/posts`, { method: 'POST', body: JSON.stringify(payload) }),
  updateThreadPost: (postId, patch) => request(`/discussions/posts/${postId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteThreadPost: (postId) => request(`/discussions/posts/${postId}`, { method: 'DELETE' }),
  voteProposal: (postId) => request(`/discussions/posts/${postId}/vote`, { method: 'POST' }),
  resolveThread: (id, payload) => request(`/discussions/${id}/resolve`, { method: 'POST', body: JSON.stringify(payload) }),
  reopenThread: (id) => request(`/discussions/${id}/reopen`, { method: 'POST' }),
  closeDiscussion: (id) => request(`/discussions/${id}/close`, { method: 'POST' }),
  reopenDiscussion: (id) => request(`/discussions/${id}/reopen-discussion`, { method: 'POST' }),
  deleteThread: (id) => request(`/discussions/${id}`, { method: 'DELETE' }),
  listGlossary: (params = {}) => request(`/glossary${query(params)}`),
  createGlossary: (entry) => request('/glossary', { method: 'POST', body: JSON.stringify(entry) }),
  updateGlossary: (id, patch) => request(`/glossary/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteGlossary: (id) => request(`/glossary/${id}`, { method: 'DELETE' }),
  listAssignments: (params) => request(`/assignments${query(params)}`),
  myAssignments: () => request('/assignments/mine'),
  assignablePeople: () => request('/assignments/people'),
  bookAccess: (bookId) => request(`/books/${bookId}/access`),
  // Cover image: `cover` from lib/coverImage.js prepareCover().
  uploadCover: (bookId, cover) => {
    const form = new FormData();
    form.append('color', cover.color);
    form.append('width', String(cover.width));
    form.append('height', String(cover.height));
    form.append('lg', cover.lg, `cover-lg.${cover.lg.type === 'image/webp' ? 'webp' : 'jpg'}`);
    form.append('sm', cover.sm, `cover-sm.${cover.sm.type === 'image/webp' ? 'webp' : 'jpg'}`);
    return request(`/books/${bookId}/cover`, { method: 'PUT', body: form });
  },
  deleteCover: (bookId) => request(`/books/${bookId}/cover`, { method: 'DELETE' }),
  coverUrl: (book, size) => `${BASE}/books/${book.id}/cover/${size}?v=${encodeURIComponent(book[`cover_${size}`] || '')}`,
  setBookAccess: (bookId, payload) => request(`/books/${bookId}/access`, { method: 'PUT', body: JSON.stringify(payload) }),
  adminUserWorkspace: (userId) => request(`/admin/activity/users/${userId}`),
  createAssignment: (payload) => request('/assignments', { method: 'POST', body: JSON.stringify(payload) }),
  deleteAssignment: (id) => request(`/assignments/${id}`, { method: 'DELETE' }),

  // Import
  importDocx: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/import/docx', { method: 'POST', body: form });
  },
  importText: (payload) => request('/import/text', { method: 'POST', body: JSON.stringify(payload) }),

  // Vocabulary
  listVocabulary: (params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null))
    ).toString();
    return request(`/vocabulary${qs ? `?${qs}` : ''}`);
  },
  vocabStats: () => request('/vocabulary/stats'),
  // Genres (thể loại) of books and words
  listGenres: () => request('/genres'),
  createGenre: (genre) => request('/genres', { method: 'POST', body: JSON.stringify(genre) }),
  updateGenre: (id, patch) => request(`/genres/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteGenre: (id) => request(`/genres/${id}`, { method: 'DELETE' }),
  setVocabGenre: (id, genreId, inGenre) => request(`/vocabulary/${id}/genres`, { method: 'PUT', body: JSON.stringify({ genreId, in: inGenre }) }),
  vocabTopics: () => request('/vocabulary/topics'),
  classifyVocabTopics: () => request('/vocabulary/classify-topics', { method: 'POST' }),
  reviewWords: ({ status = '', topic = '', wordType = '', chapterId = '', scope = '', limit = 20 } = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries({ status, topic, wordType, chapterId, scope, limit }).filter(([, v]) => v !== '' && v != null))
    ).toString();
    return request(`/vocabulary/review?${qs}`);
  },
  updateVocab: (id, patch) => request(`/vocabulary/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteVocab: (id) => request(`/vocabulary/${id}`, { method: 'DELETE' }),
  // Exchange, dedupe and links (server/vocabStore.js).
  exportVocab: (params = {}) => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null && v !== false))).toString();
    return requestBlob(`/vocabulary/export${qs ? `?${qs}` : ''}`);
  },
  importVocab: (payload) => request('/vocabulary/import', { method: 'POST', body: JSON.stringify(payload) }),
  vocabDuplicates: () => request('/vocabulary/duplicates'),
  dismissVocabDuplicates: (ids) => request('/vocabulary/duplicates/dismiss', { method: 'POST', body: JSON.stringify({ ids }) }),
  mergeVocab: (keepId, mergeIds) => request('/vocabulary/merge', { method: 'POST', body: JSON.stringify({ keepId, mergeIds }) }),
  vocabLinks: (id) => request(`/vocabulary/${id}/links`),
  // Own words, "my list" and proposals.
  setMyVocab: (id, note = '') => request(`/vocabulary/${id}/mine`, { method: 'PUT', body: JSON.stringify({ note }) }),
  removeMyVocab: (id) => request(`/vocabulary/${id}/mine`, { method: 'DELETE' }),
  proposeVocab: (id, note = '') => request(`/vocabulary/${id}/propose`, { method: 'POST', body: JSON.stringify({ note }) }),
  withdrawProposal: (id) => request(`/vocabulary/${id}/propose`, { method: 'DELETE' }),
  vocabProposals: () => request('/vocabulary/proposals'),
  // A shared word's meaning in one book.
  addSense: (id, payload) => request(`/vocabulary/${id}/senses`, { method: 'POST', body: JSON.stringify(payload) }),
  updateSense: (senseId, patch) => request(`/vocabulary/senses/${senseId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSense: (senseId) => request(`/vocabulary/senses/${senseId}`, { method: 'DELETE' }),
  approveProposal: (id, edits = {}) => request(`/vocabulary/proposals/${id}/approve`, { method: 'POST', body: JSON.stringify(edits) }),
  rejectProposal: (id, note = '') => request(`/vocabulary/proposals/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),
  dueVocab: ({ status = '', topic = '', wordType = '', chapterId = '', scope = '', limit = 20 } = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries({ status, topic, wordType, chapterId, scope, limit }).filter(([, v]) => v !== '' && v != null))
    ).toString();
    return request(`/vocabulary/due?${qs}`);
  },
  reviewVocab: (id, grade) => request(`/vocabulary/${id}/review`, { method: 'POST', body: JSON.stringify({ grade }) }),
  reviewStats: () => request('/vocabulary/review-stats'),

  // Settings
  getSettings: () => request('/settings'),
  updateSettings: (patch) => request('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  testSettings: (provider, config) => request('/settings/test', { method: 'POST', body: JSON.stringify({ provider, config }) }),
  testPipeline: () => request('/settings/test-pipeline', { method: 'POST' }),
  listModels: (provider, config) => request('/settings/models', { method: 'POST', body: JSON.stringify({ provider, config }) }),

  // Prompt library — multiple named system prompts, one per book "genre".
  listPrompts: () => request('/prompts'),
  createPrompt: (payload) => request('/prompts', { method: 'POST', body: JSON.stringify(payload) }),
  updatePrompt: (id, patch) => request(`/prompts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePrompt: (id) => request(`/prompts/${id}`, { method: 'DELETE' }),
  setDefaultPrompt: (id) => request(`/prompts/${id}/default`, { method: 'POST' }),

  // Book-wide marks (bookmark/flag/highlight)
  getBookMarks: (bookId) => request(`/books/${bookId}/marks`),

  // Text-to-speech (Kokoro TTS, local)
  listVoices: () => request('/tts/voices'),
  speak: ({ text, voice, speed }) => requestBlob('/tts/speak', { method: 'POST', body: JSON.stringify({ text, voice, speed }) }),
};

export const WORD_TYPES = [
  'Noun', 'Verb', 'Adjective', 'Adverb', 'Phrasal verb',
  'Idiom', 'Noun phrase', 'Adjective phrase', 'Collocation',
];

export const STATUSES = ['Thành thạo', 'Đang học', 'Cần ôn gấp'];

export const PROVIDERS = [
  { key: 'metta', label: 'Metta-AI-Server', kind: 'local', modelPlaceholder: 'meta/llama-3.1-8b-instruct', baseUrlPlaceholder: 'http://<địa-chỉ-máy-GPU>:8000/v1' },
  { key: 'anthropic', label: 'Claude (Anthropic)', kind: 'cloud', modelPlaceholder: 'claude-sonnet-5' },
  { key: 'gemini', label: 'Gemini (Google)', kind: 'cloud', modelPlaceholder: 'gemini-2.5-flash' },
  { key: 'openai', label: 'ChatGPT (OpenAI)', kind: 'cloud', modelPlaceholder: 'gpt-5' },
  { key: 'nvidia', label: 'NVIDIA Build', kind: 'cloud', modelPlaceholder: 'meta/llama-3.1-70b-instruct' },
  { key: 'riva', label: 'NVIDIA Riva NMT (chỉ dịch thuần)', kind: 'riva' },
  { key: 'ollama', label: 'Ollama', kind: 'local', modelPlaceholder: 'llama3.1', baseUrlPlaceholder: 'http://localhost:11434/v1' },
  { key: 'lmstudio', label: 'LM Studio', kind: 'local', modelPlaceholder: 'local-model', baseUrlPlaceholder: 'http://localhost:1234/v1' },
];

export const REVIEW_GRADES = [
  { key: 'again', label: 'Quên (Again)', color: 'rose' },
  { key: 'hard', label: 'Khó (Hard)', color: 'amber' },
  { key: 'good', label: 'Tốt (Good)', color: 'emerald' },
  { key: 'easy', label: 'Dễ (Easy)', color: 'teal' },
];

export const BOOK_META_FIELDS = [
  { key: 'title_en', label: 'Tên sách (tiếng Anh)', required: true },
  { key: 'title_vi', label: 'Tên sách (tiếng Việt)' },
  { key: 'author', label: 'Tác giả' },
  { key: 'publisher', label: 'Nhà xuất bản' },
  { key: 'publish_date', label: 'Ngày xuất bản' },
  { key: 'original_year', label: 'Năm xuất bản gốc' },
  { key: 'isbn10', label: 'ISBN-10 / ASIN' },
  { key: 'isbn13', label: 'ISBN-13' },
  { key: 'page_count', label: 'Số trang' },
  { key: 'format', label: 'Định dạng' },
  { key: 'language', label: 'Ngôn ngữ' },
  { key: 'rating', label: 'Đánh giá' },
  { key: 'amazon_url', label: 'Link Amazon' },
];

// What the book is about; shown as "Ngữ cảnh sách" and given to the AI so
// translations and word meanings use the field's terminology.
export const BOOK_CONTEXT_FIELDS = [
  { key: 'domain', label: 'Lĩnh vực', placeholder: 'vd. Tâm lý học, Nuôi dạy con' },
  { key: 'specialty', label: 'Chuyên môn', placeholder: 'vd. Tâm lý học phát triển; lý thuyết gắn bó' },
  { key: 'context_note', label: 'Ngữ cảnh', placeholder: 'Sách bàn về điều gì, viết cho ai — 1–2 câu cho người dịch', multiline: true },
];
