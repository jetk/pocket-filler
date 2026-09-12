// Tempo: what a beat is worth, when a layer fires, and how a tap sets both.
// Pure, so the awkward parts — a stray tap, a division that has to survive a
// tempo change, counting in from before zero — are testable without a timer.

export const MIN_BPM = 30;
export const MAX_BPM = 240;

export const beatMs = (bpm) => 60000 / bpm;
export const clampBpm = (v) => Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(v)));

// Divisions a layer can fire on, in beats. Powers of two because the music is:
// 1 is every beat, 4 is every bar, 16 is every four bars.
export const DIVS = [1, 2, 4, 8, 16];

// Does a layer on this division fire on this beat? Beats before zero are the
// count-in, and nothing fires during it — the whole point of a count-in is that
// the drawing is still while you find the downbeat.
export const fires = (beat, div) => beat >= 0 && beat % div === 0;

// How many times a division has fired by this beat, which is what a layer that
// advances by one each time (the colour cycle, the reveal) actually wants.
export const fireCount = (beat, div) => (beat < 0 ? 0 : Math.floor(beat / div) + 1);

// Tap tempo. Taps come in as timestamps; the gaps between them are the beat.
//
// The median gap rather than the mean: one late tap in four skews a mean enough
// to be audible, and the median simply ignores it. Gaps longer than maxGap end
// the run rather than averaging in the pause before you started tapping again,
// so you can tap, stop, and tap a different tempo without clearing anything.
export function tapTempo(times, maxGap = 2000) {
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > 0 && gap <= maxGap) gaps.push(gap);
    else gaps.length = 0;   // the run broke; what came before it isn't this tempo
  }
  if (!gaps.length) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return clampBpm(60000 / median);
}

// Halving and doubling land on the tempo you meant far more often than walking
// there one BPM at a time does, since a track is rarely a prime number of beats
// away from where you are. Refuses rather than clamps: silently turning a double
// into "now at 240" would look like the button did something it didn't.
export function scaleBpm(bpm, factor) {
  const next = bpm * factor;
  return next >= MIN_BPM && next <= MAX_BPM ? Math.round(next) : null;
}
