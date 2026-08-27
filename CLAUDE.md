# Pocket Filler — context for a new agent

Read this before changing anything. It records *why* the code is shaped the way
it is; several obvious-looking "improvements" are traps, and they're named below.

## Original intent

In their words at the start (trimmed only of the opening "let's create"):

> A mobile-friendly canvas webapp that lets the user select nodes on a regular
> dot grid (fixed zoom for now, dots 1 cm apart) and draw lines between them.
> The idea is for the user to be able to draw lines in any angle allowed by the
> grid, and then for the pockets created by three or more of those lines
> intersecting to be colorable.

Framing that still governs decisions:

- **Experimental.** The final shape of the app is explicitly unknown. Prefer
  changes that are cheap to reverse over changes that are complete.
- **Touch-first.** Phone is the primary device, not a desktop with a mouse.
- **Animation is the destination.** Stated up front: eventually animate "by
  programmatically adjusting the origin and destination nodes of lines so they
  change the shapes they make." This is why lines are the only stored state and
  pockets are always derived.
- **Fast-loading and servable from GitHub Pages**, because the working loop is:
  edit here or in the Claude app → commit → push → the live page updates.
- **Multi-node shapes** were flagged as a possible future direction.

The originally specified controls were self-contradictory and were resolved
before any code was written: "tap the first node to cancel" made closing a loop
impossible, since closing *is* tapping the first node. The rule became "tap the
node you're standing on to end" (which cancels when nothing has been drawn yet)
and "tap the first node, once two segments exist, to close". Cancelling a
part-drawn chain is Undo's job. Worth knowing before you re-litigate it.

A canvas library was considered and rejected: Canvas2D covers dots, lines,
polygons and hit-testing, and no library does planar face detection — the actual
hard part — so a library would have been weight without leverage.

## What it is now

Static page, zero dependencies, no build step. Live at
https://jetk.github.io/pocket-filler/ from `main` at repo root.

Mode button cycles **Draw → Fill → Move**. Two-level bar: mode and colors on
top, everything that acts on the drawing below. Two separate dance toggles —
**♪ Point** (violet, nudges nodes) and **◆ Shape** (teal, drifts filled pockets)
— plus a **∷ Dots** grid toggle. One shared pill carries both dance sliders:
how much moves at once (per dance, each remembering its own number) and the
tempo in BPM (shared, since only one dance runs at a time). See README.md for
the user-facing controls.

```
index.html      shell, all CSS, toolbar markup
src/app.js      state, input, rendering, persistence, toolbar, dance driver
src/planar.js   segments -> enclosed faces. Pure, no DOM. The core.
src/shapes.js   which nodes a pocket owns; moving a set of them at once. Pure.
src/codec.js    drawing <-> URL fragment
src/dance.js    choreography (which nodes step, which shapes drift). Pure.
test/*.test.js  node --test, no framework, no fixtures
```

Pure modules are pure so they can be tested in node without a DOM. Keep them
that way; `app.js` is the only file that touches the document.

## Data model

```js
state = {
  lines: [[ax, ay, bx, by], ...],  // grid units; array index IS the line id
  fills: { [faceKey]: colorIndex },
  palette: ['#rrggbb', ...6],      // colorIndex indexes this
  mode, color, chain, dots
}
```

`lines` is the single source of truth. Faces are recomputed from it on every
change via `computeFaces()` — never stored, never incrementally patched. That
call is deliberately the same one an animation frame will make.

### Invariants — breaking these breaks saved drawings

1. **Line array order is permanent.** The index is the line id, and face keys
   are built from the ids bounding a pocket. Deleting or reordering renumbers
   later lines and silently repaints or orphans every fill. This is why a line
   whose endpoints meet is *kept*, not deleted, in `moveNode`.
2. **Nodes are identified by position, not by id.** Every line end on a grid
   point is the same node; that is what makes dragging move a whole junction.
   Consequence: two nodes brought onto the same point weld permanently and
   cannot be separated. `dance.js` refuses such moves for exactly this reason.
3. **Coordinates stay non-negative integers below 64.** `codec.js` encodes each
   as one character. `encode()` throws rather than emit something it can't
   round-trip. Fractional coordinates require widening coords to two chars.
4. **Face keys must stay derivable from line ids**, or fills stop surviving
   moves and animation.
5. **A fill is an index, not a color.** `palette` therefore travels with the
   drawing — saved locally *and* carried in the share link — or a shared
   drawing arrives in whatever colors the recipient happens to have. `dots`
   goes the other way: a view preference, local only. The palette is a fourth,
   optional section on the fragment, appended only when it differs from the
   stock one, so links written before it existed still decode and links on the
   default colors are no longer than they were.

## Traps

- **No `confirm()`, `alert()`, or any modal.** Embedded webviews — including the
  Claude desktop app's browser pane — suppress or hang on them. Clear silently
  did nothing until it became two-tap arming. Use the toast or in-button state.
  The one OS-level surface in the app is `<input type="color">` behind
  `editColor()`, chosen because it is free, native and familiar on a phone. It
  is the same family of risk: if it turns out to be suppressed in a webview,
  that single call site is what an in-page picker would replace.
- **A gesture with no mark on screen doesn't exist.** Editing a swatch is a
  second tap on the selected one, which is tidy and was undiscoverable: the
  first person to use it asked where the palette was. The selected swatch now
  wears a pencil, tinted by the swatch's own brightness so it stays legible on
  any color. `showPicker()` was measured working both top-level and inside a
  sandboxed iframe, so the webview worry was not the problem here — the missing
  affordance was.
- **Anything painted from state must be repainted after `load()`.** The toolbar
  is built at module scope, so a palette arriving from a link or from disk
  reached the fills but not the swatches until `paintSwatches()` moved below
  `load()`. Same for `paintDotsBtn()`.
- **`computeFaces` is O(n²) in crossings.** A real 69-line drawing with 35
  pockets costs ~4 ms; a dense 150-line tangle with 1342 pockets costs ~174 ms.
  Fine for edits, a ceiling for per-frame animation.
- **A beat books the next beat.** The dance runs on a self-scheduling
  `setTimeout`, not `setInterval`, so a tick that overruns its beat delays the
  next one instead of stacking behind it — which matters because the tempo goes
  up to 240 BPM (250 ms) while `computeFaces` on a dense drawing can cost more
  than that. It also means a tempo change needs nothing reset; the next beat
  reads the slider itself.
- **A danced frame must never reach disk.** During a dance `state.lines` holds
  displaced positions the snap-back is about to discard; persisting them leaves
  disk disagreeing with the screen and hands the wobble back on the next load.
  This bit once, via the dots toggle calling `save()` mid-dance, so the rule now
  lives in `save()` itself: it writes `dance.resting` whenever a dance is
  running. Dance *ticks* still only mutate and redraw.
- **Stale fill keys are kept on purpose** in `state.fills`, so undo restores a
  pocket and its color together. They cost bytes and nothing else. Share filters
  them out.
- **Grid coordinates are absolute at fixed 1 cm zoom.** A drawing authored on a
  wide phone clips on a narrower screen. Known, unfixed — see below.
- **Browser-pane click injection is flaky** (30 s timeouts, occasional double
  delivery). Verify with dispatched pointer events via `javascript_tool`, not by
  clicking, and never test destructive actions against a live drawing.

## Working on it

```bash
node --test 'test/*.test.js'
```

```bash
python3 -m http.server 8000
```

48 tests, all in node with `assert` — no framework, no fixtures. The geometry,
codec, shape extraction and choreography are covered; rendering and input are
not. Non-trivial
logic should leave one runnable check behind.

Deploy is `git push` to `main`; Pages rebuilds in ~30 s. Commits are written in
normal prose (the caveman/ponytail session styles apply to chat, not to commits
or code).

## Console handle

`window.pf` exposes `state`, `moveNode(from, to)`, `moveNodes(deltas)`,
`shapes()`, `moveShape(key, delta)`, `redraw()`, `faces()`. `moveNode` is the
seam animation uses — the node drag is just repeated calls to it, and it is now
a one-entry call into `moveNodes`.

```js
pf.moveNode([3, 5], [4, 6]); pf.redraw();
pf.moveShape(pf.shapes()[0].key, [1, 0]); pf.redraw();
```

## Open threads

- **Move a whole shape.** Built, but not by the union-find route sketched here.
  Connected components answer "what is joined to what", which is not the same
  question as "what did the user mean by a shape" — and the caveat that shapes
  touching at one node merge into one component made it worse the denser the
  drawing got. A *filled* pocket is the user pointing at the region that means
  something, so `shapes()` is just the faces with a fill and needs no heuristic
  at all. Selection UX is therefore already solved: you colour it.

  `moveShape(key, delta)` translates the grid nodes that are both corners of the
  pocket and real line endpoints (`shapes.js`). Three rules make it refuse and
  change nothing: off the sheet, a step that re-cuts the pocket (which re-keys
  the face and would strand the fill), and a step that would land a node on one
  that isn't moving with it. That third one is invariant 2 biting — two shapes
  meeting corner to corner weld silently, since a shared corner cuts no edge and
  the topology check sees nothing wrong, and thereafter drag each other about.

  Not every corner can be carried: a boundary corner that is a crossing rather
  than a line end has no node to move, so a pocket bounded partly by a line
  running past it changes form as it travels. Moves are tethered, not detached —
  lines merely touching the shape follow by one end and stretch.
- **Smooth animation** needs fractional coordinates, which needs two-char coords
  in `codec.js` and a fractional `nearestNode`. Dance is deliberately jerky and
  grid-snapped until then.
- **Drawings clip on screens narrower than the one they were drawn on.** Fixing
  it means either scale-to-fit (breaks the fixed 1 cm rule) or pan.
- **The ✕ (Clear) button is unlabelled** and reads as "cancel", not "wipe
  everything". Bar has ~10 px slack at 375 px if it should say "Clear".
