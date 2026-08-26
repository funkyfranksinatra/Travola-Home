# Design

## The frame

Top tabs, not a side rail — the same 56px bar, brand lockup and uppercase tab
treatment as Travola-OS. A manager moving between the floor manager and the
Console should not have to relearn where anything is; the muscle memory is the
point.

Seven tabs: **Overview · Analysis · Predictions · Logins · Plan & billing ·
Data · Settings.**

Every tab opens the same way: a lit card carrying the section name, the subject,
one line of orientation, and whatever belongs on the right. Consistency there is
what makes seven pages read as one product rather than seven screens.

## Two colour layers

The palette is the floor app's, but chart marks and page chrome have different
jobs and get different treatments.

### Chrome — unchanged from Travola-OS

| Token | Value | Role |
|---|---|---|
| `--color-bg` | `#121214` | canvas |
| `--color-panel` | `#161619` | top bar |
| `--color-panel-card` | `#1e1e22` | cards |
| `--color-panel-up` | `#27272c` | raised / hover |
| `--color-ink-50` | `#e4e4e7` | primary text |
| `--color-ink-400` | `#a1a1aa` | secondary text |
| `--color-ai` | `#818cf8` | accent |

### Data marks — validated separately

A chart mark has to stay distinguishable from its neighbours on a dark surface,
including for colour-blind readers. The chrome indigo `#818cf8` sits **above**
the dark-mode lightness band for a mark (OKLCH L 0.68 against a 0.48–0.67 band),
and the softened state colours fail CVD separation against each other — green
and amber come out at ΔE 5.9 under protanopia, well below the 8.0 target.

So the series colours are stepped versions of the **same hues**, chosen by
search and checked with a validator rather than by eye:

| Slot | Value | Hue |
|---|---|---|
| `--color-viz-1` | `#757bff` | indigo — always the primary series |
| `--color-viz-2` | `#d97800` | amber |
| `--color-viz-3` | `#00af73` | green |
| `--color-viz-4` | `#ca59e4` | magenta |

Validation against the `#1e1e22` card surface:

```
Lightness band       PASS  all 4 inside OKLCH L 0.48–0.67
Chroma floor         PASS  all 4 ≥ 0.10
CVD separation       PASS  worst adjacent #00af73↔#d97800 ΔE 10.1 (deutan)
Normal-vision floor  PASS  worst adjacent ΔE 23.7
Contrast vs surface  PASS  all 4 ≥ 3:1
```

The heatmap uses a **sequential** ramp — one hue, dark to light, monotonic in
lightness. Never a rainbow, because the quantity it encodes is magnitude:

`#24275a → #373b83 → #4b50b0 → #6168d9 → #7881ff`

### Status colours are reserved

`--color-state-avail` (green) and `--color-state-seated` (red) mean **direction**
— a rise or a fall — and are never used as a series colour. They always appear
with an arrow glyph and a number, so direction is never carried by hue alone.

Which direction is *good* is per-metric: turn time rising is bad, covers rising
is good, average party size is neither. A dashboard that paints every rise green
teaches people to stop reading it.

## Rules every chart follows

- **One axis, always.** Two measures of different scale get two charts, never two
  y-scales. Predicted vs actual covers share an axis because they are the same
  measure in the same unit.
- **Fewer than four points is not a trend.** Two months of revenue joined by a
  sloping line reads as a collapse when the slope is entirely an artefact of the
  second month being three days old. Below four points the chart renders as bars.
- **A month in progress is dashed** and labelled, and is never compared against a
  finished one.
- **A metric with no data renders greyed**, naming the source it is waiting on.
  Never a zero.
- **Every plot has a hover layer.** A chart on a screen that does not respond to
  the pointer reads as a picture of a chart.
- Marks are thin: 2px lines, 4px rounded bar ends, ≥8px endpoint markers, a 2px
  surface ring where marks overlap. Grid and axes are recessive.
- Text wears text tokens, never the series colour. A coloured swatch beside a
  label carries identity.

## The floor plan

The Console's most important picture, and not for decoration: an owner opening a
management page recognises their own dining room instantly, and recognising it is
what makes the numbers beside it feel like they are about *their* restaurant.

Drawn from the `Table` rows using the same geometry helpers as the POS
(`lib/floor-geometry.ts`), so a table is the same size, shape and rotation in all
three products. The room is scaled from the bounding box of the tables
themselves — there is no stored canvas size — and table numbers are
counter-rotated so a turned communal table still reads the right way up.

Areas are colour-coded (dining, bar, patio, lounge) and the legend names them.

A restaurant that has not built a floor plan yet gets a clearly-labelled
**example room** rather than an empty box, so the panel still shows what it is
for, with a prompt to build the real one in the floor manager.

The panel's proportions are clamped between 1.8 and 2.8. That bound is the
panel's, not the room's: a near-square dining room given its own proportions
inside a wide card became 800px tall and pushed everything else below the fold,
while letting the card's own 3:1 shape win left the drawing marooned between two
bands of empty floor.

## Layout decisions worth keeping

- **Nothing leaves a ragged half-row.** The two metric groups big enough to fill
  a row (Volume, Money) get full tiles; the four smaller ones become compact
  panels four across. A four-column grid holding two metrics leaves a gap on
  every section, which is what makes a long page read as disjointed.
- **Panels hug their content** (`items-start`). A stretched grid gives a
  two-metric panel the height of a six-metric one and it reads as an empty box.
- **One arrow, one number.** An arrow chip beside a figure that already carries a
  sign says the same thing twice.
