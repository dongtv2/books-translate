import { useCallback, useRef, useState } from 'react';
import { api } from '../api.js';

// Drives "translate N pending paragraphs" from the client, one at a time,
// so the UI can show real progress (count, elapsed time, ETA) instead of a
// single opaque blocking request. Each item still hits the existing
// per-paragraph translate endpoint — this hook is just the orchestration.
export function useSequentialTranslate() {
  const [progress, setProgress] = useState(null);
  const cancelRef = useRef(false);

  const run = useCallback(async (paragraphs, { reexplainAll = false, onParagraphDone } = {}) => {
    cancelRef.current = false;
    const total = paragraphs.length;
    const startedAt = Date.now();
    let done = 0;
    let failed = 0;
    let insertedWordCount = 0;

    setProgress({ total, done, failed, insertedWordCount, startedAt, currentPreview: '', finished: false, cancelled: false });

    for (const paragraph of paragraphs) {
      if (cancelRef.current) {
        setProgress((s) => ({ ...s, cancelled: true, finished: true, finishedAt: Date.now() }));
        return { total, done, failed, insertedWordCount, cancelled: true };
      }

      setProgress((s) => ({ ...s, currentPreview: paragraph.english_md.slice(0, 90) }));
      try {
        const result = await api.translateParagraph(paragraph.id, { reexplainAll });
        insertedWordCount += result.insertedWordCount;
        onParagraphDone?.(result.paragraph);
      } catch {
        failed += 1;
      }
      done += 1;
      setProgress((s) => ({ ...s, done, failed, insertedWordCount }));
    }

    setProgress((s) => ({ ...s, finished: true, finishedAt: Date.now(), currentPreview: '' }));
    return { total, done, failed, insertedWordCount, cancelled: false };
  }, []);

  const cancel = useCallback(() => { cancelRef.current = true; }, []);
  const reset = useCallback(() => setProgress(null), []);

  return { progress, run, cancel, reset };
}
