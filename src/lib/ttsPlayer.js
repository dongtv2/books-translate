// Module-level singleton so starting playback on one paragraph automatically
// stops whatever else was reading — matches how a normal "read aloud" button
// should behave across a page full of ParagraphCards.
let currentAudio = null;
let currentId = null;
const listeners = new Set();
const progressListeners = new Set();

function notify() {
  for (const cb of listeners) cb(currentId);
}

function notifyProgress(payload) {
  for (const cb of progressListeners) cb(payload);
}

export function subscribePlayingId(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Fires on every audio `timeupdate` with { id, currentTime, duration } while
// something is playing, and once with null when playback stops — lets a
// paragraph read along in sync with the actual audio being played (which
// already reflects whatever voice/speed it was synthesized with).
export function subscribeProgress(cb) {
  progressListeners.add(cb);
  return () => progressListeners.delete(cb);
}

export function getPlayingId() {
  return currentId;
}

export function stopPlayback() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
  }
  currentAudio = null;
  currentId = null;
  notify();
  notifyProgress(null);
}

export function playBlob(id, blob) {
  stopPlayback();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  currentId = id;
  notify();

  const cleanup = () => {
    URL.revokeObjectURL(url);
    if (currentAudio === audio) {
      currentAudio = null;
      currentId = null;
      notify();
      notifyProgress(null);
    }
  };
  audio.onended = cleanup;
  audio.onerror = cleanup;
  audio.ontimeupdate = () => {
    if (currentAudio === audio && audio.duration) {
      notifyProgress({ id, currentTime: audio.currentTime, duration: audio.duration });
    }
  };
  audio.play().catch(cleanup);
}
