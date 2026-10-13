// Curated subset of Kokoro-82M v1.0's built-in English voices (the model
// ships ~54 voices across several languages; we only surface the ones
// relevant to reading English source paragraphs aloud).
export const KOKORO_VOICES = [
  { id: 'af_heart', label: 'Nữ, Anh-Mỹ — Heart (khuyến nghị)' },
  { id: 'af_bella', label: 'Nữ, Anh-Mỹ — Bella' },
  { id: 'af_nicole', label: 'Nữ, Anh-Mỹ — Nicole' },
  { id: 'af_sarah', label: 'Nữ, Anh-Mỹ — Sarah' },
  { id: 'af_sky', label: 'Nữ, Anh-Mỹ — Sky' },
  { id: 'am_adam', label: 'Nam, Anh-Mỹ — Adam' },
  { id: 'am_michael', label: 'Nam, Anh-Mỹ — Michael' },
  { id: 'am_fenrir', label: 'Nam, Anh-Mỹ — Fenrir' },
  { id: 'am_puck', label: 'Nam, Anh-Mỹ — Puck' },
  { id: 'bf_emma', label: 'Nữ, Anh-Anh — Emma' },
  { id: 'bf_isabella', label: 'Nữ, Anh-Anh — Isabella' },
  { id: 'bm_george', label: 'Nam, Anh-Anh — George' },
  { id: 'bm_lewis', label: 'Nam, Anh-Anh — Lewis' },
];

export const DEFAULT_VOICE = 'af_heart';

export function isKnownVoice(id) {
  return KOKORO_VOICES.some((v) => v.id === id);
}
