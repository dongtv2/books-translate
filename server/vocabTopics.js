// The fixed set of vocabulary topics, by what a word or phrase is ABOUT —
// so the vocabulary can be filtered and reviewed by meaning. Before this,
// topics were free text: section headings from imports and ad-hoc AI labels
// (290 different values for 873 words). The AI now picks from this list
// (llm/schema.js, llm/compactPipeline.js) and classifyTopics() files the rest.
import { db } from './db.js';
import { getSettings } from './settingsStore.js';

export const VOCAB_TOPICS = [
  'Cảm xúc & cảm giác',
  'Tâm lý & nhận thức',
  'Hành vi & thói quen',
  'Gắn bó & quan hệ',
  'Gia đình & nuôi dạy con',
  'Trẻ em & sự phát triển',
  'Giáo dục & học tập',
  'Xã hội & văn hoá',
  'Giao tiếp & ngôn ngữ',
  'Tính cách & thái độ',
  'Cơ thể, não bộ & sức khoẻ',
  'Lập luận & diễn đạt',
  'Tính chất & mức độ',
  'Đời sống & hành động thường ngày',
  'Khác',
];

export const TOPIC_GUIDE = `Chọn đúng MỘT chủ đề theo NGHĨA của từ (nó nói về điều gì), không theo chương sách hay loại từ:
- Cảm xúc & cảm giác: buồn, giận, lo âu, cảm giác cơ thể, tâm trạng
- Tâm lý & nhận thức: suy nghĩ, nhận thức, tiềm thức, bản năng, cơ chế tâm lý
- Hành vi & thói quen: cách cư xử, phản ứng, hành vi lặp lại
- Gắn bó & quan hệ: gắn bó, thân thiết, tình bạn, sự gần gũi, mối quan hệ
- Gia đình & nuôi dạy con: cha mẹ, con cái, nuôi dưỡng ("nurture"), truyền lại qua thế hệ, kỷ luật
- Trẻ em & sự phát triển: tuổi thơ, trưởng thành, giai đoạn phát triển
- Giáo dục & học tập: trường học, thầy cô, học, dạy
- Xã hội & văn hoá: xã hội, văn hoá, truyền thông, kinh tế, đồng trang lứa
- Giao tiếp & ngôn ngữ: nói, lắng nghe, diễn đạt, tranh luận
- Tính cách & thái độ: phẩm chất, quan điểm, thái độ với người khác
- Cơ thể, não bộ & sức khoẻ: não, thần kinh, bệnh, y tế, sinh học
- Lập luận & diễn đạt: từ nối, từ trừu tượng, khái niệm học thuật, cách nhấn mạnh (vd. "a function of", "compelling", "phenomenon", "revealing")
- Tính chất & mức độ: tính từ/trạng từ mô tả tính chất, mức độ, hướng, tần suất của sự vật (vd. "ubiquitous", "ominous", "corrosive", "vertically", "systemic")
- Đời sống & hành động thường ngày: động tác, sự việc, đồ vật, tình huống hằng ngày
- Khác: chỉ khi thật sự không hợp mục nào`;

// "Khác" is left out when classifying, so the model has to commit to the
// nearest real topic instead of using it as a default.
const CLASSIFY_TOPICS = VOCAB_TOPICS.filter((t) => t !== 'Khác');

export function isValidTopic(topic) {
  return VOCAB_TOPICS.includes(topic);
}

// Files every word whose topic is not one of VOCAB_TOPICS, in batches, using
// the configured OpenAI-style provider with the topics as an enum (so the
// answer is always a valid topic). Returns { classified, remaining }.
// One run at a time: a second caller (an import finishing while someone
// presses "Phân loại bằng AI") waits for the run already going.
let running = null;
export function classifyTopics(options) {
  running ??= runClassify(options).finally(() => { running = null; });
  return running;
}

async function runClassify({ batchSize = 30, onProgress } = {}) {
  const { chatCompletion } = await import('./llm/openAICompatAdapter.js');
  const settings = getSettings();
  const provider = settings.provider;
  if (!['openai', 'nvidia', 'ollama', 'lmstudio', 'metta'].includes(provider)) {
    throw new Error('Phân loại chủ đề cần nhà cung cấp AI kiểu OpenAI (Metta-AI-Server, LM Studio, Ollama, OpenAI, NVIDIA).');
  }
  const placeholders = VOCAB_TOPICS.map(() => '?').join(',');
  const todo = db.prepare(`SELECT id, term, word_type, meaning_vi FROM vocabulary WHERE topic NOT IN (${placeholders}) ORDER BY id`).all(...VOCAB_TOPICS);
  const update = db.prepare('UPDATE vocabulary SET topic = ? WHERE id = ?');
  let classified = 0;

  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'integer' }, topic: { type: 'string', enum: CLASSIFY_TOPICS } }, required: ['id', 'topic'] },
        },
      },
      required: ['items'],
    };
    let items = [];
    for (let attempt = 0; attempt < 2 && !items.length; attempt += 1) {
      try {
        const res = await chatCompletion({
          config: settings[provider],
          providerKey: provider,
          body: {
            temperature: 0,
            max_tokens: 2000,
            messages: [
              { role: 'system', content: `Bạn phân loại từ vựng tiếng Anh theo chủ đề nội dung.\n${TOPIC_GUIDE}\nKhông dùng "Khác": luôn chọn chủ đề gần nhất.\nGọi tool classify_topics một lần với đủ mọi id được gửi.` },
              { role: 'user', content: batch.map((w) => `${w.id} | ${w.term} | ${w.word_type} | ${w.meaning_vi}`).join('\n') },
            ],
            tools: [{ type: 'function', function: { name: 'classify_topics', description: 'Topic for each word id.', parameters: schema } }],
            tool_choice: provider === 'lmstudio' ? 'required' : { type: 'function', function: { name: 'classify_topics' } },
          },
        });
        items = JSON.parse(res.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments || '{}').items || [];
      } catch {
        items = [];
      }
    }
    const ids = new Set(batch.map((w) => w.id));
    db.transaction(() => {
      for (const it of items) {
        if (ids.has(it.id) && isValidTopic(it.topic)) { update.run(it.topic, it.id); classified += 1; }
      }
    })();
    onProgress?.({ done: Math.min(i + batchSize, todo.length), total: todo.length });
  }
  const remaining = db.prepare(`SELECT COUNT(*) AS c FROM vocabulary WHERE topic NOT IN (${placeholders})`).get(...VOCAB_TOPICS).c;
  return { classified, remaining };
}
