# Pocket Filler

A touch-first drawing toy. Tap nodes on a 1 cm dot grid to chain straight lines together at any angle the grid allows; wherever three or more lines enclose a region, that pocket becomes tappable and can be filled with color.

Static page, no dependencies, no build step — open `index.html` or serve the folder.

```bash
python3 -m http.server 8000
```

Tests for the geometry (the part worth testing):

```bash
node --test test/*.test.js
```

## Controls

The bar has two levels: what you're drawing with on top — the mode button and the colors — and everything that acts on the drawing below.

The mode button cycles **Draw → Paint → Move**.

- **Draw** — tap a node to start. Each further node extends the chain. Tap the node you're on to finish; if you haven't drawn a segment yet, that cancels. Tap the first node once two or more segments exist to close the loop.
- **Paint** — puts the selected color on whatever you tap: a node with lines on it, then a line, then a pocket, then a bare grid point with nothing on it at all. Tapping the same thing in the same color takes the color off again. A bare dot comes last on purpose: the tap radius covers about two thirds of every cell and pockets are full of dots, so letting any dot win would leave almost nowhere to tap that fills a pocket. The cost is that a bare dot inside a pocket can't be painted while the pocket is there.
- **Ink** — the first dab in the row is the sheet's own line color rather than one of the six, and it's what's selected at startup. Lines you draw are born in the selected color, so with ink selected a drawing comes out exactly as it always did; pick a color first and the lines come out in it. Painting a line or node ink is how you take the color back off.
- **✎ Palette** — the pencil beside the swatches opens a panel with all six colors at once. Each cell is the browser's own color input, so changing one is a single tap into a picker you already know. **Reset** puts the stock six back. Your palette is saved locally and rides along in shared links, since fills store an index into it and a drawing sent without its palette would arrive in somebody else's colors. Links on the stock colors carry no palette and stay exactly as short as before.
- **Move** — drag any node; every line meeting it follows, snapping node to node. Fills stay with their pocket.

Both dances leave the drawing exactly as they found it. Canvas edits are ignored while either runs, the other buttons stop them first, and only one can run at a time.

- **♪ Point dance** (violet) — nudges random *nodes* one position in a random direction, pulling the lines out of shape as it goes. Every tick is measured from the resting drawing rather than the previous one, which is what stops a random walk carrying the drawing away.
- **◆ Shape dance** (teal) — drifts whole *filled pockets* instead, so each shape keeps its form and the lines merely attached to it stretch. Needs at least one filled pocket, and says so if there isn't one.
- **∷ Dots** shows and hides the dot grid. The grid still snaps when hidden — it's only the dots that go. Saved locally, and deliberately left out of shared links so a link never imposes your grid on someone else.
- **Undo** steps back through draws, fills, moves and clears — a whole drag counts as one. **Share** puts the drawing in the URL and copies the link. Everything autosaves locally.

Whichever dance is running shows one pill above the bar, in that dance's color. The left slider is how much moves at once — dancers for one, shapes for the other, each remembering its own number. Slide it to zero and the drawing holds still, which is the easy way to tap the ones you want. The right slider is **♩ tempo**, in beats per minute: one beat, one step, 30 to 240. It's shared, since only one dance runs at a time, and saved locally like the dots rather than travelling in a link. The slider covers 210 BPM in about 50px, so it lands on roughly every third value; **−** and **+** beside the number reach the ones in between. Each beat books the next one instead of running on a fixed interval, so a slow frame delays the following beat rather than stacking up behind it, and a tempo change simply lands on the next beat.

**♫ Dance to music** (experimental). Captures a tab's audio on desktop Chrome or Edge, or the microphone anywhere else, and lets the music drive the beats instead of the clock. Two readings, switchable in the pill so they can be compared against the same track: **Notes** gives every pitch class a node of its own, which it holds out of place for as long as that note sounds — a trill between two pitches reads as two nodes flicking at each other. **Beats** just fires one ordinary beat whenever a new note starts, keeping the current feel with the metronome taken off. The tempo controls hide while listening, because the music is the clock.

**Pick your own dancers.** While a dance is running, tap a node to choose it, or a filled pocket in the shape dance. Easiest with the count at zero, so nothing is moving under your finger while you pick. Chosen ones are ringed in the dance's color and are the only ones that move; the count slider dims, because it has nothing left to decide. Tap again to drop one. Switching the dance off and on again forgets the lot and hands it back to the slider.

The shape dance can't re-derive from rest each tick the way the point dance does. Doing so would mean re-applying every shape's offset every time, so a tick would cost what the *drawing* costs rather than what's moving, and the slider would buy nothing — measured, that's 95 ms a tick at 32 filled pockets against a 350 ms budget, versus 8 ms when only two shapes move. So each shape carries an offset that never leaves a fixed leash: it stays near home by construction rather than by being rebuilt, and stopping restores the resting drawing outright.

## Driving it from the console

`moveNode` is what the drag calls, and it's the seam animation will use:

```js
pf.moveNode([3, 5], [4, 6]);   // move a node and everything welded to it
pf.redraw();
```

Nodes are identified by position, so all line ends sharing a grid point move together. A painted node is keyed the same way, so `moveNodes` carries its color along with it — otherwise the paint would stay behind on an empty grid point. Fills are keyed by the lines bounding a pocket, so a color follows its pocket through a move as long as the topology holds.

Whole shapes move too. A shape is a pocket you have colored — the color is the selection, so there's nothing to infer:

```js
pf.shapes();                                 // [{ key, color, nodes }] per filled pocket
pf.moveShape(pf.shapes()[0].key, [1, 0]);    // one grid step right
pf.redraw();
```

The move is tethered rather than detached: the shape keeps its own form, and any line that merely touches it follows by one end and stretches. `moveShape` returns `false` and changes nothing if the step would take a node off the sheet, cut the pocket against another line, or land a node on top of one that isn't moving with it.

That last rule is what keeps two shapes from sticking together. Nodes are identified by position, which is what makes a drag snap node to node — but it means a shape coming to rest corner-on-corner with another welds the two silently. A shared corner cuts no edge, so the topology check sees nothing wrong, and from then on each shape drags the other about and past its leash. Shapes stop short of each other instead.

Not every corner of a pocket can be carried. A boundary corner that is a crossing rather than a line end has no node to move, on the grid or off it; it slides as its two lines move. A shape bounded partly by a line running past it will change form as it goes.

## Layout

- `src/planar.js` — segments in, enclosed faces out. Pure geometry, no DOM.
- `src/shapes.js` — which nodes a pocket owns, and moving a set of them at once. Pure.
- `src/codec.js` — drawing to and from the URL fragment. Pure.
- `src/dance.js` — which nodes step where on a dance tick, and which shapes drift. Pure.
- `src/listen.js` — live audio to twelve pitch-class levels. Copied from [sefirograph](https://github.com/jetk/sefirograph); fix it there and copy it back rather than forking it.
- `src/notes.js` — pitch-class levels to which node moves. Pure.
- `src/app.js` — state, input, rendering, persistence, toolbar.

Lines are the only source of truth; pockets are recomputed from them on every change. That's also the seam for animation later: move endpoints, re-derive.

---

[CLAUDE.md](CLAUDE.md) carries the design rationale, invariants and open threads — read that before changing the code.
