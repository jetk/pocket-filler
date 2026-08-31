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
