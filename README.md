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

- **Draw** — tap a node to start. Each further node extends the chain. Tap the node you're on to finish; if you haven't drawn a segment yet, that cancels. Tap the first node once two or more segments exist to close the loop.
- **Fill** — pick a swatch, tap a pocket. Tapping it again with the same color clears it.
- **Undo** pops the last line. **Share** puts the drawing in the URL and copies the link. Everything autosaves locally.

## Layout

- `src/planar.js` — segments in, enclosed faces out. Pure geometry, no DOM.
- `src/app.js` — state, input, rendering, persistence.

Lines are the only source of truth; pockets are recomputed from them on every change. That's also the seam for animation later: move endpoints, re-derive.
