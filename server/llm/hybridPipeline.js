// The hybrid pipeline: a dedicated machine-translation model translates,
// a chat model annotates.
//
// Translation-only models such as NVIDIA Riva Translate 4B Instruct (or
// Riva NMT over gRPC) translate well and cheaply but return nothing but
// the translation: no vocabulary, no bold, no notes, and they cannot be
// told the book's agreed terms. So:
//   1. the MT model translates the paragraph (and its citation);
//   2. the chosen chat model gets that translation as a base and returns
//      the app's usual structured result (llm/schema.js), keeping the base
//      wording and changing it only to use the agreed terms, to fix a clear
//      mistranslation or a dropped sentence, and to bold the noted terms.
// Fallbacks, each reported in `warnings`: if MT fails the annotator
// translates on its own (the single-model path); if the annotator fails
// the MT translation is saved without notes; if the annotator's text has
// lost a good part of the base, the base text is kept.
import { getSettings } from '../settingsStore.js';
import { translateParagraphWith } from './index.js';
import { chatCompletion } from './openAICompatAdapter.js';
import * as rivaAdapter from './rivaAdapter.js';
import { isMtOnly, mtMessages, mtReply } from './mtModels.js';

const plain = (s) => String(s || '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();

// The translation by the MT model. NVIDIA Build models are called the way
// the Riva Translate model card asks (an expert-translator system message,
// a "translation of the sentence" question); the reply is the translation.
export async function machineTranslate(text, settings = getSettings()) {
  const { translator, translatorModel } = settings.pipeline;
  const source = plain(text);
  if (!source) return '';
  if (translator === 'riva') {
    return (await rivaAdapter.translateParagraph({ text: source, config: settings.riva })).vietnamese_md.trim();
  }
  // NVIDIA Build (cloud, needs a key) or the Metta-AI-Server (self-hosted
  // NIM): same chat API, the translation model named in the pipeline.
  const config = settings[translator];
  if (translator === 'nvidia' && !config?.apiKey) throw new Error('Thiếu API key NVIDIA Build cho máy dịch — vào Cài đặt → AI dịch.');
  if (!config?.baseUrl) throw new Error(`Chưa cấu hình địa chỉ cho máy dịch (${translator}).`);
  const res = await chatCompletion({
    config: { ...config, model: translatorModel },
    providerKey: translator,
    body: {
      model: translatorModel,
      temperature: 0,
      max_tokens: Math.min(4096, Math.ceil(source.length * 1.2) + 256),
      messages: mtMessages(source),
    },
  });
  const out = mtReply(res);
  if (!out) throw new Error(`Máy dịch ${translatorModel} trả về bản dịch rỗng.`);
  return out;
}

const HYBRID_RULES = (base, baseCitation) => `QUY TRÌNH KẾT HỢP — BẢN DỊCH NỀN
Một máy dịch chuyên dụng đã dịch đoạn văn; bản dịch nằm trong <base_translation>. Với "vietnamese_md":
- DÙNG bản dịch nền làm cơ sở, giữ nguyên câu chữ và văn phong của nó.
- CHỈ sửa khi: (a) phải dùng đúng cách dịch trong BẢNG THUẬT NGỮ ĐÃ THỐNG NHẤT (nếu có); (b) bản dịch nền sai nghĩa rõ ràng, bỏ sót ý hoặc câu so với bản gốc; (c) để bôi đậm **...** đúng các mục new_words/phrases/citations.
- Không viết lại cho "hay hơn", không thêm, không bớt ý.
Các trường còn lại (english_md, phrases, new_words, already_known, citations, remarks_note) làm như bình thường.

<base_translation>
${base}
</base_translation>${baseCitation ? `

<base_citation_translation>
${baseCitation}
</base_citation_translation>
(Dùng làm cơ sở cho "citation_vi_md" theo cùng nguyên tắc.)` : ''}`;

// One paragraph through the hybrid pipeline. Returns the structured result
// plus `_pipeline` ({ translator, annotator, ms, warnings, base }).
export async function translateParagraphHybrid({ text, citation = '', existingTerms = [], reexplainAll = false, systemPrompt }) {
  const settings = getSettings();
  const { translator, translatorModel, annotator } = settings.pipeline;
  if (['nvidia', 'metta'].includes(annotator) && isMtOnly(settings[annotator]?.model)) {
    throw new Error(`Model ghi chú (${annotator}) đang là model chỉ dịch (${settings[annotator].model}). Chọn một model chat cho nhà cung cấp này, hoặc một nhà cung cấp ghi chú khác.`);
  }
  const warnings = [];
  const t0 = Date.now();
  const meta = { translator: translator === 'riva' ? 'riva-nmt' : translatorModel, annotator: `${annotator}:${settings[annotator]?.model || ''}` };

  let base = '';
  let baseCitation = '';
  try {
    base = await machineTranslate(text, settings);
    if (citation?.trim()) baseCitation = await machineTranslate(citation, settings).catch(() => '');
  } catch (err) {
    warnings.push(`Máy dịch lỗi (${err.message}); model ghi chú tự dịch đoạn này.`);
  }
  const mtMs = Date.now() - t0;

  let result;
  try {
    result = await translateParagraphWith(annotator, {
      text, citation, existingTerms, reexplainAll,
      systemPrompt: base ? `${systemPrompt}\n\n${HYBRID_RULES(base, baseCitation)}` : systemPrompt,
    });
  } catch (err) {
    if (!base) throw err; // nothing to save at all
    warnings.push(`Model ghi chú lỗi (${err.message}); đã lưu bản dịch máy, chưa có ghi chú từ vựng.`);
    result = { english_md: text, vietnamese_md: base, citation_vi_md: baseCitation, phrases: [], new_words: [], already_known: [], citations: [], remarks_note: '' };
  }

  // The annotator must not lose the translation: a result much shorter than
  // the base means sentences were dropped — keep the base text then (its
  // bold is gone, so the English loses the bold too, keeping them in step).
  if (base && result.vietnamese_md && plain(result.vietnamese_md).length < plain(base).length * 0.75) {
    warnings.push('Bản của model ghi chú ngắn hơn hẳn bản dịch máy; đã giữ bản dịch máy (không bôi đậm).');
    result = { ...result, vietnamese_md: base, english_md: text.replace(/\*\*/g, '') };
  }
  if (base && !result.vietnamese_md?.trim()) result = { ...result, vietnamese_md: base };
  if (baseCitation && !result.citation_vi_md?.trim()) result = { ...result, citation_vi_md: baseCitation };

  return { ...result, _pipeline: { ...meta, mtMs, ms: Date.now() - t0, warnings, base } };
}
