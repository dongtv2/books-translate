import { useEffect, useState } from 'react';
import { Volume2, Square, LoaderCircle } from 'lucide-react';
import { api } from '../api.js';
import { playBlob, stopPlayback, subscribePlayingId, getPlayingId } from '../lib/ttsPlayer.js';
import { useLayoutSettings } from '../context/LayoutSettingsContext.jsx';

// Small reusable "hear this" button for a single word/phrase — same Kokoro
// TTS backend as the paragraph reader, just scoped to short vocabulary text.
export default function SpeakButton({ id, text, size = 16, className = '' }) {
  const { settings } = useLayoutSettings();
  const [loading, setLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(() => getPlayingId() === id);

  useEffect(() => subscribePlayingId((pid) => setIsPlaying(pid === id)), [id]);

  async function handleClick(e) {
    e.stopPropagation();
    if (isPlaying) { stopPlayback(); return; }
    if (!text?.trim()) return;
    setLoading(true);
    try {
      const blob = await api.speak({ text, voice: settings.ttsVoice, speed: settings.ttsSpeed });
      playBlob(id, blob);
    } catch {
      // Compact inline control — swallow errors rather than derailing the
      // surrounding flashcard/table; TTS is a nice-to-have here, not core.
    } finally {
      setLoading(false);
    }
  }

  const label = isPlaying ? 'Dừng' : 'Nghe phát âm';
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading || !text?.trim()}
      title={label}
      aria-label={label}
      className={`inline-grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-30 ${
        isPlaying ? 'bg-accent-soft text-accent' : 'text-mute hover:bg-sunken hover:text-accent'
      } ${className}`}
    >
      {loading ? <LoaderCircle size={size} className="animate-spin" /> : isPlaying ? <Square size={size - 3} /> : <Volume2 size={size} />}
    </button>
  );
}
