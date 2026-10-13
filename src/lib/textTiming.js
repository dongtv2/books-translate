// Estimates which sentence/word is being spoken at a given moment of TTS
// playback, since Kokoro doesn't expose real per-word timestamps — this is
// a proportional-offset approximation (char position in the plain text ≈
// char position in the audio timeline), good enough for a "follow along"
// highlight without needing phoneme-level alignment data from the engine.
// It naturally stays in sync with whatever voice/speed was used, because it
// reads progress off the real <audio> element's own currentTime/duration —
// a paragraph synthesized faster just has a shorter duration to divide by.

import { plainText } from './inlineMarkdown.js';

// Strips the app's tiny markdown subset down to the exact plain text that
// should be sent to TTS and used for offset math. It uses the same parser as
// the renderers, so character positions line up with what is on screen.
export function stripMarkdown(text) {
  return plainText(text);
}

// Splits plain text into sentences, each carrying its own word list, all as
// character ranges into that same plain text.
export function segmentText(plainText) {
  if (!plainText) return [];
  const sentenceRe = /[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g;
  const sentences = [];
  let m;
  while ((m = sentenceRe.exec(plainText))) {
    const start = m.index;
    const raw = m[0];
    const end = start + raw.length;
    const words = [];
    const wordRe = /\S+/g;
    let wm;
    while ((wm = wordRe.exec(raw))) {
      words.push({ start: start + wm.index, end: start + wm.index + wm[0].length });
    }
    if (words.length > 0) sentences.push({ start, end, words });
  }
  return sentences;
}

// Maps a character offset (into the plain text) to a { sentenceIndex,
// wordIndexInSentence } pair.
export function findActiveIndices(sentences, charOffset) {
  for (let si = 0; si < sentences.length; si++) {
    const s = sentences[si];
    if (charOffset < s.end || si === sentences.length - 1) {
      let wordIndexInSentence = s.words.length - 1;
      for (let wi = 0; wi < s.words.length; wi++) {
        if (charOffset < s.words[wi].end) { wordIndexInSentence = wi; break; }
      }
      return { sentenceIndex: si, wordIndexInSentence };
    }
  }
  return { sentenceIndex: -1, wordIndexInSentence: -1 };
}
