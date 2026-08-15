# Pocket Filler

A touch-first drawing toy. Tap nodes on a 1 cm dot grid to chain straight lines together at any angle the grid allows; wherever three or more lines enclose a region, that pocket becomes tappable and can be filled with color.

Static page, no dependencies, no build step — open `index.html` or serve the folder.

```bash
python3 -m http.server 8000
```

Tests for the geometry (the part worth testing):

```bash
node --test test/planar.test.js
```

## Controls

The mode button cycles **Draw → Fill → Move**.

- **Draw** — tap a node to start. Each further node extends the chain. Tap the node you're on to finish; if you haven't drawn a segment yet, that cancels. Tap the first node once two or more segments exist to close the loop.
- **Fill** — pick a swatch, tap a pocket. Tapping it again with the same color clears it.
- **Move** — drag any node; every line meeting it follows, snapping node to node. Fills stay with their pocket.
- **♪ Dance** — nudges random nodes one position in a random direction, a few times a second. The slider sets how many move at once. Each tick is offset from the resting drawing rather than the previous tick, so the shape wobbles in place instead of wandering off, and switching it off restores the original exactly. Canvas edits are ignored while it runs; the other buttons stop it first.
- **Undo** steps back through draws, fills, moves and clears — a whole drag counts as one. **Share** puts the drawing in the URL and copies the link. Everything autosaves locally.

## Driving it from the console

`moveNode` is what the drag calls, and it's the seam animation will use:

```js
pf.moveNode([3, 5], [4, 6]);   // move a node and everything welded to it
pf.redraw();
```

Nodes are identified by position, so all line ends sharing a grid point move together. Fills are keyed by the lines bounding a pocket, so a color follows its pocket through a move as long as the topology holds.

## Layout

- `src/planar.js` — segments in, enclosed faces out. Pure geometry, no DOM.
- `src/app.js` — state, input, rendering, persistence.

Lines are the only source of truth; pockets are recomputed from them on every change. That's also the seam for animation later: move endpoints, re-derive.
