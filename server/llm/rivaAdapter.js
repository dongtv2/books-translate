import { translate } from '../riva/rivaProcess.js';

// NVIDIA Riva NMT is pure machine translation — no instruction-following,
// no tool calling, no structured output. It can only fill vietnamese_md;
// every other field this app normally extracts (phrases, new_words,
// citations, remarks_note) stays empty because the model has no way to
// produce them. english_md is passed through unchanged since nothing can
// bold terms in it without an LLM doing that analysis.
export async function translateParagraph({ text, config }) {
  if (!config.apiKey) throw new Error('Thiếu API key cho NVIDIA Riva NMT — vào Cài đặt để nhập.');
  if (!config.functionId) throw new Error('Thiếu Function ID cho NVIDIA Riva NMT — vào Cài đặt để nhập.');

  const translation = await translate({
    text,
    sourceLang: 'en',
    targetLang: 'vi',
    apiKey: config.apiKey,
    functionId: config.functionId,
    server: config.server || 'grpc.nvcf.nvidia.com:443',
  });

  return {
    english_md: text,
    vietnamese_md: translation,
    phrases: [],
    new_words: [],
    already_known: [],
    citations: [],
    remarks_note: '',
  };
}
