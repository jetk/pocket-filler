// The looks: animation that changes how the drawing is *drawn* rather than what
// it is. None of these touch state.lines or nodeColors, which is what makes them
// safe to stack on top of a movement layer and safe to leave running — there is
// nothing to snap back, nothing that can reach disk, and no chance of welding
// two nodes together.
//
// It's also why they can be smooth while movement stays grid-snapped: a
// fractional position that is never stored never has to survive codec.js, so
// invariant 3 isn't in the way.
//
// Each takes "how long since this layer last fired" and returns a number the
// renderer applies. Pure, so the envelopes can be checked without a canvas.

// --- colour cycle ----------------------------------------------------------

// A fill stores an index into the palette, not a colour, so cycling is arithmetic
// on the index and costs nothing. Ink is left out: lines drawn in the sheet's own
// colour are the drawing's skeleton, and flashing them reads as a fault.
//
// `ripple` staggers the shift by the shape's position in reading order, so the
// colour change travels across the drawing instead of landing everywhere at once.
export function shiftColor(i, shift, size) {
  return i >= size ? i : (((i + shift) % size) + size) % size;
}

// --- pop -------------------------------------------------------------------

// Scale about the centroid, snapping out on the beat and easing back. Exponential
// decay rather than linear because the ear expects a transient: most of the
// movement in the first fraction of the beat, then a settle.
export function popScale(since, beat, amount, tau = 0.22) {
  if (since < 0) return 1;
  return 1 + amount * Math.exp(-since / (tau * beat));
}

export function scaleAbout(pts, k) {
  if (k === 1) return pts;
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= pts.length; cy /= pts.length;
  return pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
}

// --- strobe ----------------------------------------------------------------

// Knocks the fills out to paper for a sliver of the beat, leaving the lines, so
// the drawing reads as a wireframe of itself for an instant. Capped in absolute
// time as well as relative: at 60 BPM a quarter-beat flash is a quarter of a
// second, which is a blink rather than a strobe.
export function strobing(since, beat, fraction = 0.18, cap = 90) {
  return since >= 0 && since < Math.min(cap, beat * fraction);
}

// --- reveal ----------------------------------------------------------------

// Lines appear one per fire until the drawing is whole, so it draws itself over
// the intro. A fill waits for every line that bounds it, otherwise a pocket
// would colour itself in across a gap that isn't closed yet.
export const revealed = (fired, total) => Math.min(total, fired);

export function faceReady(face, shown) {
  return face.lines.every((id) => id < shown);
}
