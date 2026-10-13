// The translation checks on hand-made examples (no model, no database).
//   node server/workflow/test/checks.test.mjs
import assert from 'node:assert/strict';
import { checkTranslation } from '../checks.js';

const types = (issues) => issues.map((i) => i.type).sort();
const p = {
  english_md: 'A child needs **attachment** to grow. Without it, the child turns to peers. Parents lose their natural authority. This is the core problem we face today.',
  citation_en_md: '',
};
const glossary = [{ term: 'attachment', meaning_vi: 'sự gắn bó' }, { term: 'peers', meaning_vi: 'bạn bè đồng trang lứa' }];

const good = {
  english_md: p.english_md,
  vietnamese_md: 'Một đứa trẻ cần **sự gắn bó** để lớn lên. Thiếu nó, đứa trẻ quay sang bạn bè đồng trang lứa. Cha mẹ mất đi quyền năng tự nhiên của mình. Đây là vấn đề cốt lõi chúng ta đang đối mặt ngày nay.',
};
assert.deepEqual(checkTranslation(good, p, glossary), []);

assert.deepEqual(types(checkTranslation({ ...good, vietnamese_md: '' }, p, glossary)), ['empty']);

const dropped = { ...good, vietnamese_md: 'Một đứa trẻ cần **sự gắn bó** để lớn lên, nếu không sẽ quay sang bạn bè đồng trang lứa.' };
assert.ok(types(checkTranslation(dropped, p, glossary)).includes('short'));
assert.ok(types(checkTranslation(dropped, p, glossary)).includes('sentences'));

const padded = { ...good, vietnamese_md: `${good.vietnamese_md} Chúng ta có thể xác định sáu cách gắn bó. Sáu cách này tăng dần từ đơn giản đến phức tạp. Trẻ hướng về bạn bè thường chỉ dùng những cách cơ bản nhất.` };
assert.ok(types(checkTranslation(padded, p, glossary)).includes('extra'));

const wrongTerm = { ...good, vietnamese_md: good.vietnamese_md.replace('sự gắn bó', 'sự gắn kết') };
assert.deepEqual(types(checkTranslation(wrongTerm, p, glossary)), ['glossary']);
// a leading "sự"/"việc" is not required
assert.deepEqual(checkTranslation({ ...good, vietnamese_md: good.vietnamese_md.replace('sự gắn bó', 'gắn bó') }, p, glossary), []);

const leftover = { ...good, vietnamese_md: good.vietnamese_md.replace('quyền năng tự nhiên', 'natural authority') };
assert.deepEqual(types(checkTranslation(leftover, p, glossary)), ['untranslated']);
// the English term in brackets after its translation is fine
assert.deepEqual(checkTranslation({ ...good, vietnamese_md: good.vietnamese_md.replace('**sự gắn bó**', '**sự gắn bó** (attachment)') }, p, glossary), []);

const unbold = { ...good, vietnamese_md: good.vietnamese_md.replace(/\*\*/g, '') };
assert.deepEqual(types(checkTranslation(unbold, p, glossary)), ['bold']);

const withCitation = { ...p, citation_en_md: 'Bowlby, J. (1969). Attachment and Loss.' };
assert.deepEqual(types(checkTranslation({ ...good, citation_vi_md: '' }, withCitation, glossary)), ['citation']);

console.log('checks: all passed');
