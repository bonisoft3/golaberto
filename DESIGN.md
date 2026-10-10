---
colors:
  primary: "#000000"
  secondary: "#4a4a1f"
  accent: "#784d1e"
  danger: "#b30000"
  attention: "#a34d00"
  neutral: "#3b3008"
  chart-bar: "#fff8dc"
  surface: "#e3efca"
  border: "#abb561"
  surface-muted: "#cee3a3"
  masthead: "#8f983b"
  masthead-ink: "#1f1f00"
  strip: "#abb561"
  strip-ink: "#333300"
  band: "#474d0f"
  band-ink: "#ffffff"
  side: "#b8c26e"
  table-head: "#00008b"
  table-head-ink: "#ffffff"
  chip: "#d6d6d6"
  chip-ink: "#000000"
  wordmark: "#ffffff"
  wordmark-edge: "#1c1c1c"
  wordmark-accent: "#f5c542"
  date-bar: "#ffcc00"
  zone-champion: "#22bb22"
  zone-qualify: "#55dd55"
  zone-playoff: "#99e699"
  zone-promotion: "#add8e6"
  zone-relegation: "#ffb6c1"
  zone-none: "#d3d3d3"
  form-win: "#1f8a1f"
  form-draw: "#e0b000"
  form-loss: "#c41a1a"
  form-rim: "#1c1c1c"
  shadow-ink-3: "hsl(60 40% 10% / 3%)"
  shadow-ink-4: "hsl(60 40% 10% / 4%)"
  shadow-ink-5: "hsl(60 40% 10% / 5%)"
  shadow-ink-6: "hsl(60 40% 10% / 6%)"
  shadow-ink-7: "hsl(60 40% 10% / 7%)"
  shadow-ink-8: "hsl(60 40% 10% / 8%)"
  shadow-ink-10: "hsl(60 40% 10% / 10%)"
dark:
  primary: "#e8efd6"
  secondary: "#c3cc9a"
  accent: "#e0b07a"
  danger: "#ff7a6b"
  attention: "#f0a860"
  neutral: "#141103"
  chart-bar: "#626343"
  surface: "#23260f"
  border: "#5c6230"
  surface-muted: "#2e3314"
  masthead: "#4a4f1d"
  masthead-ink: "#eef3db"
  strip: "#5c6230"
  strip-ink: "#eef3db"
  band: "#0f1103"
  band-ink: "#f5c542"
  side: "#33371b"
  table-head: "#1d2a6b"
  table-head-ink: "#e8efd6"
  chip: "#3a3e1a"
  chip-ink: "#e8efd6"
  wordmark: "#141103"
  wordmark-edge: "#eef3db"
  wordmark-accent: "#f5c542"
  date-bar: "#8f7400"
  zone-champion: "#1e5e1e"
  zone-qualify: "#2e6b2e"
  zone-playoff: "#39573a"
  zone-promotion: "#2b4a5c"
  zone-relegation: "#6b2e38"
  zone-none: "#33371b"
  form-win: "#4fc24f"
  form-draw: "#f0c84a"
  form-loss: "#ff6b5a"
  form-rim: "#0a0b02"
  shadow-ink-3: "hsl(60 40% 2% / 27%)"
  shadow-ink-4: "hsl(60 40% 2% / 28%)"
  shadow-ink-5: "hsl(60 40% 2% / 29%)"
  shadow-ink-6: "hsl(60 40% 2% / 30%)"
  shadow-ink-7: "hsl(60 40% 2% / 31%)"
  shadow-ink-8: "hsl(60 40% 2% / 32%)"
  shadow-ink-10: "hsl(60 40% 2% / 34%)"
rounded:
  sm: "2px"
  md: "3px"
  full: "999px"
spacing:
  sm: "4px"
  md: "8px"
  lg: "12px"
  xl: "20px"
motion:
  fast: "90ms"
  base: "140ms"
  ease: "cubic-bezier(.2, 0, 0, 1)"
  shift: "3px"
control:
  h-xs: "24px"
  h-sm: "28px"
  h: "32px"
  h-lg: "40px"
  pad-x: "var(--sp-md)"
measures:
  page: "960px"
  side: "200px"
  masthead: "72px"
type:
  display: "2.25rem"
  title: "1.5rem"
  subtitle: "1.0625rem"
  body: "0.9375rem"
  caption: "0.8125rem"
  label: "0.75rem"
  leading-title: "1.25"
  leading-body: "1.5"
shell:
  bg: "neutral"
  fg: "primary"
  rule: "band"
---

# GolAberto — identity

The identity is the archive's own, read off upstream's
`app/assets/stylesheets/main.css.erb` and the live site, and stated whole here:
every token the default preset would supply is overridden, so nothing of the
preset's editorial paper survives.

## What is kept

- **The ground and the column.** An earth-brown page (`neutral`, `#3b3008`)
  holding one parchment-green column (`surface`, `#e3efca`) whose tables stripe
  with the darker moss (`surface-muted`, `#cee3a3`). Two decades of readers
  know the site by this pair.
- **The chrome, in its three olive steps.** The masthead (`masthead`,
  `#8f983b`), the navigation strip (`strip`, `#abb561`, ink `#333300`) and the
  title band every page opens with (`band`, `#474d0f`, white ink).
- **The table.** Upstream's navy table head (`table-head`, `darkblue`) and the
  zone colours a table is painted in. A zone's colour is a role, not a hex an
  editor typed (ir `decision-zones`): `champion`, `qualify`, `playoff`,
  `promotion`, `relegation`, and `zone-none` for the grey middle of a table.
- **Arial.** The site is set in Arial/Helvetica, and a football archive's
  tables are read as numbers in columns: a neutral grotesque at small sizes is
  the point, not a lack of taste.
- **Square corners.** `rounded` is 2–3px, a bevel rather than a pill.

## What changes, and why

- **The column is 960px, not 790px.** Upstream fixes 790px, which a 1440px
  laptop shows as a narrow strip in a brown field and a phone cannot show at
  all. The column is fluid up to 960px, which keeps the brown ground visible on
  a desktop and gives the table its phase-button row and the side column room
  without a horizontal scroll (`measures.page`). Below 720px the side column
  moves under the content, the strip scrolls, and a table keeps its
  identifying columns.
- **Contrast.** Upstream's link brown `#963` is 4.1:1 on the parchment and less on the zebra stripe; the
  `accent` is darkened to `#784d1e`, which holds 4.5:1 on the column, its stripe and a grey table row; a link in the side column wears the strip's ink (`strip-ink`), because no brown clears 4.5:1 on that olive.
  `secondary` is the olive-black `#4a4a1f`, not a grey, because every grey on
  this green reads dirty.
- **A dark twin.** Upstream has none. The dark appearance keeps the same
  hierarchy by lowering value and keeping hue: the ground goes to near-black
  olive, the column to a deep moss, the strip and the band stay olive, the
  band's ink turns the wordmark's gold so a title still reads as the archive's, and the wordmark inverts to dark letters in a light outline, because the outline is what makes block letters read against the olive.
  Zone colours keep their order of lightness, so champion is still the
  strongest green and relegation still the only red.

## The last five

A table's last five results are dots in upstream's green, amber and red, each with a dark rim, because a dot sits on whatever zone colour its row wears and the rim is what keeps a green win visible on the champion's green.

## Measures

- `page`: the column's widest measure.
- `side`: the side column beside a page's content on a wide screen.
- `masthead-ink` (colour): the language switcher's ink on the masthead, darker than the strip's, since the masthead is the darker olive.
- `masthead`: the wordmark band's height, which the language switcher is
  placed inside.
