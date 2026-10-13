// Translation-only models (NVIDIA Riva Translate 4B Instruct, Riva NMT…):
// they return a plain translation and nothing else — no JSON, no tool
// calls, no notes. Shared by the hybrid pipeline (as its translator) and
// the compact pipeline (a Metta-AI-Server running such a model).
export const isMtOnly = (model) => /riva-translate|(^|\/)nmt\b/i.test(model || '');

// The prompt the Riva Translate model card asks for: an expert-translator
// system message and a "translation of the sentence" question.
export function mtMessages(text) {
  return [
    { role: 'system', content: 'You are an expert at translating text from English to Vietnamese.' },
    { role: 'user', content: `What is the Vietnamese translation of the sentence: ${text}?` },
  ];
}

// The reply, without the quotes these models like to add.
export const mtReply = (res) => String(res.choices?.[0]?.message?.content || '').trim().replace(/^["“]|["”]$/g, '').trim();
