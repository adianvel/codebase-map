# Diagram geometry

The coordinate rules for a report's SVG views. The template
(`docs/report-template.html`) owns the palette and the required regions; this
file owns only the numbers that place nodes, edges, and labels inside them.

`scripts/check-report.mjs` enforces what a coordinate can decide — content
inside the viewBox, labels inside their node's footprint, nodes that do not
overlap, and edges attached to footprints. The rest is taste and stays in the
prose.

## Canvas

A diagram is one `<svg class="diagram">` with an explicit viewBox and matching
`width` and `height` attributes, so one viewBox unit is one CSS pixel: the numbers
below are what the reader sees, and a map wider than the screen scrolls rather
than shrinking its type.

| Canvas | viewBox | Rows (`tileY`) | Columns (`cx`) |
| --- | --- | --- | --- |
| Single row | `0 0 (180·c + 60) 240` | `90` | `120 + 180k` |
| Two rows | `0 0 (180·c + 60) 400` | `90`, `250` | `120 + 180k` |

`c` is the number of columns in the widest row, so the canvas is as wide as the
map: four columns give `0 0 780 400`, five give `0 0 960 400`. A fixed 1040 with
three columns used is not a wider drawing, it is a smaller one — the leftover
grid scales the tiles down with nothing in them. A third row sits at
`tileY = 410` and makes the canvas 560 tall.

The viewBox is the contract of what is drawn: nothing may cross it, and nothing
may be saved from a too-small canvas by scrolling. Keep every element 20px
inside the viewBox on all four sides — including a boundary, whose bottom is
`max(tileY + 100) + 16` and so decides the canvas height before the nodes do.

## Node

A node is a tile with its label centred under it. Four elements, one anchor: the
column centre `cx` and the row top `tileY`.

```
tile               x = cx − 30, y = tileY, 60 × 60, rx 12
kind mark          (cx, tileY + 37)   15px mono
title baseline     (cx, tileY + 78)   13px
subtitle baseline  (cx, tileY + 96)   11px mono
footprint          cx − 66 .. cx + 66, tileY .. tileY + 100
```

The footprint is the node: everything — overlap, attachment, the viewBox margin —
is measured against it, not against the tile.

The tile carries the two-letter kind code the template's node markup defines.
Never a logo, and never a code the evidence does not back.

Labels are the discipline. An average glyph in the report's font stack advances
at about 0.54em, so a label fits inside the footprint when:

```
chars ≤ (132 − 16) / (0.54 × font-size)
```

At the template's sizes: 16 title characters (13px), 19 subtitle characters
(11px). `"Record request"` is 14 of the 16. When a name does not fit, shorten it
and move the detail to the evidence panel — never shrink the type, never widen one
node out of the grid.

## Spacing

| Between | Minimum |
| --- | --- |
| Column centres, same row | 180 |
| Row top to row top | 160 |
| Footprint to its boundary | 16 on every side |
| Boundary label to boundary edge | 16 left, 24 top |
| viewBox edge to any element | 20 |

Adjacent footprints leave a 48px gutter (`180 − 132`), and that gutter is where
the arrow lives.

A boundary (`<rect class="boundary">`) runs `min(cx) − 82` to `max(cx) + 82` and
`min(tileY) − 50` to `max(tileY + 100) + 16`, `rx="10"`. The extra 50 at the top is
the label band; its label sits 16 in and 24 down from the corner, so keep edges out
of that corner.

## Edges

Arrows connect footprints, never through a label.

- **Horizontal** (same row): `M x1 y H x2` at `y = tileY + 30`, the tile's
  mid-height, from `cx1 + 66` to `cx2 − 66`.
- **Vertical** (row to row): `M cx y1 V y2` on the column centre, from the upper
  `tileY + 100` — below its own labels — to the lower `tileY`.
- **Elbow**: run the horizontal leg in the clear band between rows
  (`upper.tileY + 120 .. lower.tileY − 10`) and the vertical leg in an x-corridor
  that passes through no footprint. Crossing another edge is normal; crossing a
  footprint is not.

One arrowhead marker per view, `refX="7"`, filled with the edge's own colour.
Leave 4–6px between a line end and a footprint; the arrowhead supplies the touch.

Edge labels carry the transport, not the noun the node already names — one short
lower-case word. The 48px gutter holds about 8 characters at 11px; anything longer
belongs in the caption. Horizontal labels sit above the line at `y − 12`, centred
on the gutter. Vertical labels sit to the right at `cx + 16`, mid-segment, and the
column must have no neighbour on that side.

```html
<path class="edge-focus" d="M186 120 H234" marker-end="url(#overview-arrow-focus)"/>
<text class="edge-label edge-label-focus" x="210" y="108" text-anchor="middle">http</text>
```

## Worked example

The template's sample overview, three columns so canvas 600×400, one boundary at
`x=218 y=40 w=344 h=326`:

```
nodes           A cx=120 tileY=90 · B cx=300 tileY=90 · C cx=300 tileY=250 · D cx=480 tileY=90
A footprint     54..186 wide, 90..190 tall
boundary inset  300 − 82 = 218 left, 480 + 82 = 562 right, 16 clear of every footprint
title budget    (132 − 16) / (0.54 × 13) = 16 chars
A → B           M186 120 H234 — the full 48px gutter at the tile's mid-height
B → C           M300 190 V250 — column centre, from below B's labels to C's tile top
```

Check a plan before building it: for every vertical and elbow segment, name the
footprints its x-corridor passes between `y1` and `y2`. The answer must be none.

## Verify

Run the module, then look at the rendered diagram — a clean report check is not
a clean picture. Open `architecture.html` (or screenshot it) and confirm the tiles
read as tiles, every label stays clear of the arrow that passes its column, groups
read as groups, and the highlighted route is the only thing in the accent colour.
Fix and re-look until it is.
