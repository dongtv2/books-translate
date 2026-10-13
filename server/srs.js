// SM-2 based spaced repetition, using the familiar 4-button Anki-style
// grading (Again / Hard / Good / Easy) instead of SuperMemo's raw 0-5 scale.
export const GRADES = ['again', 'hard', 'good', 'easy'];

const QUALITY = { again: 0, hard: 3, good: 4, easy: 5 };

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Derives the coarse "status" label shown elsewhere in the app from the SRS
// state, so the two stay in sync instead of drifting apart.
function statusForInterval(intervalDays, repetitions) {
  if (repetitions === 0) return 'Cần ôn gấp';
  if (intervalDays >= 21) return 'Thành thạo';
  return 'Đang học';
}

// card: { ease_factor, interval_days, repetitions }
// grade: 'again' | 'hard' | 'good' | 'easy'
// Returns the next state, ready to persist.
export function schedule(card, grade) {
  const quality = QUALITY[grade];
  if (quality === undefined) throw new Error(`Trạng thái đánh giá không hợp lệ: ${grade}`);

  let { ease_factor: ease, interval_days: interval, repetitions } = card;

  if (grade === 'again') {
    repetitions = 0;
    interval = 1;
    ease = Math.max(1.3, ease - 0.2);
  } else {
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 6;
    else interval = Math.round(interval * ease);

    if (grade === 'hard') interval = Math.max(1, Math.round(interval * 0.8));
    if (grade === 'easy') interval = Math.round(interval * 1.3);

    repetitions += 1;
    ease = Math.max(1.3, ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
  }

  return {
    ease_factor: Number(ease.toFixed(2)),
    interval_days: interval,
    repetitions,
    due_date: addDays(todayISO(), interval),
    last_reviewed_at: new Date().toISOString(),
    status: statusForInterval(interval, repetitions),
  };
}
