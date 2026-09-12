// Twelve pitch-class levels in, dancing instructions out. Pure, so the part
// that decides what counts as a note can be tested without a microphone.
//
// listen.js gives a level per pitch class, not a list of notes, so "a note" here
// means "a pitch class loud enough to count". That's deliberately coarse: the
// point isn't transcription, it's that the drawing twitches when the music does.

// Above this a class is sounding, below it isn't. Two thresholds rather than
// one so a class hovering at the line doesn't chatter on and off every frame.
export const ON = 0.55;
export const OFF = 0.4;

// Which classes are sounding now, given which were sounding before. Sticky
// between OFF and ON, which is what stops the flicker.
export function sounding(levels, before = []) {
  const was = new Set(before);
  const now = [];
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] >= ON || (was.has(i) && levels[i] >= OFF)) now.push(i);
  }
  return now;
}

// Classes that weren't sounding a moment ago and are now — the note starts.
export function started(now, before) {
  const was = new Set(before);
  return now.filter((pc) => !was.has(pc));
}

// Nodes in reading order, so a pitch class always lands on the same node for a
// given drawing and the mapping doesn't shuffle when the set is rebuilt.
export function inReadingOrder(nodes) {
  return [...nodes].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

// Which node a pitch class owns. Wrapping by the node count rather than
// spreading twelve classes across the whole drawing keeps neighbouring
// semitones on neighbouring nodes, so a trill between two pitches reads as two
// nodes flicking at each other rather than as movement at opposite corners.
export function nodeFor(pc, ordered) {
  return ordered.length ? ordered[pc % ordered.length] : null;
}

// Which way a class steps. Fixed per class, so a note always throws its node the
// same way and a repeated figure looks like a repeated figure.
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
export const stepFor = (pc) => DIRS[pc % DIRS.length];

// The whole of "note → node": every sounding class displaces the node it owns.
// Returns a Map of "x,y" -> [x, y] ready for moveNodes, skipping any step that
// would leave the sheet or land on a node that isn't moving. Two classes can
// own the same node when there are fewer than twelve; first one wins, which is
// stable because `sounding` returns them in pitch order.
export function notesToMoves(classes, ordered, cols, rows) {
  const occupied = new Set(ordered.map((n) => n.join(',')));
  const moves = new Map();
  const landing = new Set();

  for (const pc of classes) {
    const from = nodeFor(pc, ordered);
    if (!from) continue;
    const key = from.join(',');
    if (moves.has(key)) continue;                       // its node is already out

    const [dx, dy] = stepFor(pc);
    const to = [from[0] + dx, from[1] + dy];
    if (to[0] < 0 || to[1] < 0 || to[0] >= cols || to[1] >= rows) continue;

    const there = to.join(',');
    if (landing.has(there)) continue;                   // two notes, one square
    if (occupied.has(there) && !moves.has(there)) continue;   // would weld

    moves.set(key, to);
    landing.add(there);
  }
  return moves;
}

// --- intensity -------------------------------------------------------------
//
// Where the track is, not which notes are in it. listen.js hands back a level
// per pitch class, so the mean across all twelve is a serviceable stand-in for
// how much is going on — a build fills the spectrum, a breakdown empties it.
//
// This deliberately doesn't reach into listen.js for its spectral flux: that
// file is a verbatim copy of sefirograph's and is kept that way, so anything
// this app wants that it doesn't already return gets derived out here instead.

export const energy = (levels) => (levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : 0);

// A drop is energy jumping well clear of where it has been sitting. Two moving
// averages, one slow enough to remember the build and one fast enough to catch
// the hit, and the gap between them is the hit.
//
// It fires on the RISE and not again until the gap has closed. A time hold on
// its own is not enough: the gap stays open for as long as the track stays
// loud, so a hold alone re-fires every time it expires — sixteen bars of a
// chorus read as a drop every 1.2 seconds. The hold is still here, but only to
// stop a gap hovering on the threshold from chattering.
export const DROP = { slow: 0.02, fast: 0.4, margin: 0.18, holdMs: 1200 };

export function trackEnergy(st, levels, now, cfg = DROP) {
  const e = energy(levels);
  const slow = st.slow == null ? e : st.slow + (e - st.slow) * cfg.slow;
  const fast = st.fast == null ? e : st.fast + (e - st.fast) * cfg.fast;
  const hot = st.slow != null && fast - slow > cfg.margin;
  const dropped = hot && !st.hot && now - (st.firedAt ?? -Infinity) > cfg.holdMs;
  return { slow, fast, hot, firedAt: dropped ? now : st.firedAt, dropped };
}
