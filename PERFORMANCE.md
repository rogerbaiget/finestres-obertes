                                                                                                                                                                                                                        # Performance audit — 2026-09-02

Lighthouse 13 (mobile, default throttling: 4x CPU, ~1.6Mbps) against a local
static server. No production URL was live at audit time, so this is lab data
only — no CrUX field data exists yet for this project.

## Evidence

| Signal | Scope/conditions | Result | Source |
|---|---|---|---|
| Performance score | mobile, lab | **21/100** | Lighthouse |
| LCP | mobile, lab, cold cache | 10.0s (score 0) | Lighthouse |
| Total Blocking Time | mobile, lab | 4,990ms (score 0) | Lighthouse |
| CLS | mobile, lab | 0.335 (score 0.34) | Lighthouse |
| Total page weight | mobile, lab | **16.3 MB** | Lighthouse |

## Critical issues (1 found)

- **[Performance] 70 camera "availability check" calls download full-resolution
  photos on every page load, for markers that aren't even open yet.**
  File: `js/layers/webcams/status.js:9-14` (`checkPhoto`) — this file has
  since been restructured and moved server-side; see "Fix" below.
  - **Impact:** Dominant cause of nearly everything else being bad. Measured:
    9 of the top 10 heaviest requests on the page are these checks —
    `MeteoAlmoster.jpg` (3.5MB), `MeteoAlmoster_S.jpg` (2.5MB), `artana.jpg`
    (1.7MB), `paiporta.jpg` (1.1MB), `betera.jpg` (1.1MB), plus more —
    totaling **13.2MB from just 9 of the 70 photo cams**. All 70 fire in
    parallel via `WEBCAMS.forEach()` the instant the map loads. Under
    throttled mobile bandwidth this saturates the network for many seconds,
    which is why LCP and Time to Interactive both cap out at exactly 10.0s
    (the page never reaches a network-quiet state within Lighthouse's
    observation window) and why decoding 70 large images contributes to the
    4,990ms blocking time.
  - **Evidence:** `total-byte-weight` audit, measured.
  - **Fix:** `checkPhoto()` creates a real `<img>` element purely to see if
    `onerror` fires — it never displays the image. Swap it for a
    `fetch(cam.img, {method:'HEAD'})` (or a `no-cors` HEAD if the host blocks
    HEAD/CORS) checking `response.ok`/status, which downloads headers only,
    not the multi-megabyte body. Should cut page weight from ~16MB to well
    under 1MB.

## High priority (1 found)

- **[Performance/CLS] The map area visibly shifts after page load.**
  Files: `styles.css:15,17,19` (`#app` grid, `header`, `h1`), `js/map.js`
  (`applySiteConfig`, `renderLegend`)
  - **Impact:** CLS 0.335 is far past the 0.1 "poor" threshold. Traced via
    Lighthouse's layout-shift-culprits insight to a single element:
    `#mapwrap` (score 0.3351 out of the total 0.3352 — essentially the entire
    CLS score). `#app` is a CSS grid (`grid-template-rows:auto 1fr`) where the
    header row is sized to content; the `<h1>` and `.legend` div are both
    empty at first paint and only get their real content from JS
    (`applySiteConfig()`/`renderLegend()` in `initMap()`) plus a web font swap
    shortly after (Fraunces/Space Grotesk load with `display=swap`). On a
    narrow/mobile viewport the header wraps to more lines once populated,
    growing the `auto` row and pushing/shrinking the map (`1fr` row) beneath
    it.
  - **Evidence:** `cls-culprits-insight` audit, measured — element and score
    directly attributed.
  - **Fix:** give `header` a `min-height` sized for its fully-populated,
    wrapped state (or reserve space some other way) so the row doesn't grow
    after JS runs. Not yet verified with a before/after re-run.

## Medium priority (2 found)

- **[Performance] Unminified first-party JS.** `js/map.js` and
  `js/carto-style.js` — ~13KB combined estimated savings. Low effort, low
  impact relative to the above, but free.
- **[Performance] 90 markers created synchronously on load.**
  `js/map.js:addAllMarkers()` — 70 photo + 20 video cameras each get a DOM
  element and a `maplibregl.Marker` instance in one synchronous pass.
  Contributes to Script Evaluation / Style & Layout time. Not isolated with
  its own before/after test — a hypothesis, not a measured finding. Worth
  revisiting after fixing the critical issue above, since it may no longer be
  significant once network contention is gone.

## Ruled out

Tested directly (patched the code, re-ran Lighthouse, reverted) rather than
guessed from source alone:

- **The `within` filter on label layers** (`js/carto-style.js`, flagged in an
  existing code comment as a known perf risk) — disabling it made no
  measurable difference.
- **The camera availability-check network calls entirely** — disabling them
  improved FCP (2.9s → 1.6s) but LCP/TTI/TBT stayed just as bad, because the
  *photo* checks (`checkPhoto`, separate from `checkVideo`) were still
  running and are the actual weight problem.

## Recommended priority

1. Fix `checkPhoto()` to use a lightweight HEAD check instead of downloading
   full images.
2. Reserve header space to eliminate the CLS.
3. Re-run Lighthouse after both fixes for real before/after numbers.
4. Revisit marker-creation cost and JS minification only if the score still
   isn't where you want it after 1–2.

## Follow-up audit — 2026-09-03

Lighthouse 13 (mobile, default throttling: 4x CPU, ~1.6Mbps), same methodology
as above, re-run after fixing `checkPhoto()` and reserving header space (both
recommended above), plus a session's worth of unrelated map-rendering work
(region labels, contour mask/outline, marker z-order).

### Evidence

| Signal | 2026-09-02 | 2026-09-03 | Change |
|---|---|---|---|
| Performance score | 21/100 | **49/100** | +28 |
| LCP | 10.0s (score 0) | 5.2s (score 0.23) | −4.8s |
| Total Blocking Time | 4,990ms (score 0) | 4,200ms (score 0.01) | −790ms — still critical |
| CLS | 0.335 (score 0.34) | **0.012 (score 1.0)** | fixed |
| Total page weight | 16.3 MB | **1.02 MB** | −15.3MB (~16x) |
| FCP | not reported | 1.8s (score 0.89) | — |
| TTI | 10.0s (capped) | 6.7s (score 0.56) | −3.3s |

The two fixes recommended in the previous audit worked exactly as predicted:
page weight dropped ~16x (the `checkPhoto()` fix) and CLS is now essentially
perfect (the header space reservation). LCP and TTI improved substantially as
a side effect of the same two fixes (no longer network-starved).

### Total Blocking Time — measured, not guessed

TBT barely moved and is now the single worst-scoring metric (0.01/1.0).
Diagnosed with a CDP CPU profile (4x throttle, 8s post-load window,
`Profiler.start`/`stop`) rather than source inspection alone:

- Of ~2.6s of actual (non-idle) CPU time sampled, essentially all
  attributable self-time is *inside* `maplibre-gl.min.js` itself
  (`renderLayer`, `_render`, `possiblyEvaluate`, `_setupPainter`, symbol/label
  placement, matrix calculations) — none of it in `map.js` or
  `carto-style.js` directly.
- Confirmed with a patch/measure/revert A/B test (three Lighthouse runs, each
  reverted after): stripping out our own additions (contour mask/outline,
  region labels, 90 camera markers) and loading *only* the raw CARTO style
  drops TBT from 4,200ms to **2,170ms**. Adding back the contour
  mask/outline/region labels brings it to **3,010ms** (+840ms). Adding back
  the 90 camera markers (2 clustered GeoJSON layers) brings it to the full
  **4,200ms** (+1,190ms).

This splits the remaining TBT into three roughly-quantified sources:

| Source | Contribution | Nature |
|---|---|---|
| Bare MapLibre GL + CARTO's full base style | ~2,170ms (52%) | Inherent to rendering a full general-purpose basemap (positron/dark-matter ship dozens of layers — roads, buildings, POIs, admin boundaries — most irrelevant to this site) under mobile 4x CPU throttle |
| Our contour mask/outline + region labels | ~840ms (20%) | Extra symbol/fill layers MapLibre must evaluate and place |
| Our 90 camera markers (clustered layers) | ~1,190ms (28%) | Confirms the 2026-09-02 "medium priority" hypothesis — not DOM/Marker creation (markers are already GPU-drawn clustered layers, 0 DOM nodes), but the added paint/layout expression evaluation and symbol-collision placement work this triggers inside MapLibre |

### Recommended priority (updated)

1. **Chunk our own layer/marker setup across multiple frames** (e.g. yield
   between `addContourLayers()`, `addRegionLabels()`, `addAllMarkers()` via a
   `requestAnimationFrame`/`setTimeout(0)` gap, or `scheduler.yield()` where
   supported). TBT specifically penalizes any *single* task over 50ms — several
   of today's long-tasks were 300–900ms. Splitting them into sub-50ms chunks
   can cut TBT substantially without reducing total CPU work or changing
   anything visible. Lowest risk, not yet tried.
2. **Trim CARTO's base style to only the layers this site actually uses**
   (land/water, the few road/label layers still visible, drop the rest) rather
   than shipping the full general-purpose positron/dark-matter style. This is
   the larger of the two remaining costs (~52% of TBT) but a bigger, riskier
   change — it touches every layer CARTO ships and needs care not to silently
   break something `carto-style.js` already depends on by name (e.g.
   `place_state`, `water-sea`).
3. Re-run this same before/after methodology after either fix.

### Ruled out (this round)

- **Our own marker/label/mask code being independently slow** — the CPU
  profile shows no hot functions in `map.js`/`carto-style.js`; their cost is
  entirely the *additional MapLibre-internal rendering work* they trigger, not
  slow JS of our own.

## Follow-up audit #2 — 2026-09-03 (production URL, post-bundling)

First run against the real deployed site (`https://finestres-obertes.pages.dev/`)
rather than a local server — prod didn't exist yet for the previous two audits.
Also the first audit since MapLibre was bundled via esbuild instead of
CDN-loaded (see git history), so this re-checks whether that changed anything
here.

Lighthouse 13.4.1, mobile. Two throttling methods were used and should not be
compared to each other directly:

- **simulate** (Lighthouse's default, matches prior audits' methodology): 1 run.
- **devtools** (real network/CPU throttling applied during navigation, not a
  post-hoc model): 3 runs, median reported. Used for the diagnostic
  drill-down below because its per-resource timestamps and the headline
  metric are self-consistent — under `simulate`, `lcp-breakdown-insight`'s
  subpart durations (TTFB + render delay) summed to ~650ms while the
  headline LCP reported 5.2s, which doesn't reconcile.

### Evidence

| Signal | simulate (1 run) | devtools (median of 3, range) | Source |
|---|---|---|---|
| Performance score | 49/100 | 49/100 (48–50) | Lighthouse |
| LCP | 5.2s (score 0.23) | 4.4s (score —, range 4.3–4.5s) | Lighthouse |
| Total Blocking Time | 5,320ms (score 0) | 1,830ms (range 1,630–1,920ms) — still "poor" (>600ms) | Lighthouse |
| CLS | 0.012 (score 1.0) | 0.012 | Lighthouse |
| Speed Index | 3.8s | 9.0s (range 9.0–9.2s) | Lighthouse |
| Interactive (TTI) | 10.5s | 11.9s (range 11.8–12.1s) | Lighthouse |
| Total page weight | 1,154 KiB | — | Lighthouse |

Compared to the 2026-09-02 follow-up's local-server `simulate` numbers
(score 49, LCP 5.2s, TBT 4,200ms), today's `simulate` score/LCP land in the
same place; TBT looks worse (5,320ms vs 4,200ms) but that's very likely a
localhost-vs-real-CDN-latency artifact of the `simulate` model rather than a
real regression — see the `devtools` column, which is a genuine navigation
under real throttling and shows TBT considerably *lower* (1,830ms). No
apples-to-apples comparison exists yet for `devtools`-method TBT since prior
audits didn't use it.

### New findings (not seen in prior audits — both local-server-only, no live fonts/CDN in the critical path the same way)

- **[Performance/LCP] `font-display: block` on the page's own LCP element.**
  File: `index.html:25` (Google Fonts `<link>`, `&display=block`); the LCP
  element is the `<h1>` (`font-family:'Fraunces'`, `styles.css:25`).
  - **Impact:** Root cause of nearly all remaining LCP time. `lcp-breakdown-insight`
    (devtools run): TTFB 79ms, **element render delay 4,334ms** — the H1 is
    invisible until Fraunces loads because `display=block` withholds fallback
    text during the font block period. Confirmed via `network-requests`
    timestamps: the Fraunces `.woff2` doesn't even *start* downloading until
    ~3.0s in (queued behind `app.js`, MapLibre's worker/shared chunks, and the
    CARTO tile/style fetches all competing for the connection), finishes at
    3.95s, and LCP fires at 4.41s — right after. `font-display-insight`
    independently flags this: score 0, "est. savings of 950ms" for Fraunces
    (790ms for Space Grotesk too, non-LCP but same root cause).
  - **Evidence:** measured (`lcp-breakdown-insight`, `font-display-insight`,
    raw `network-requests` timestamps, devtools-throttled run).
  - **Fix:** change `&display=block` to `&display=swap` in the Google Fonts
    URL (`index.html:25`, both the `<link>` and its `<noscript>` fallback).
    Trades a brief font-swap flash (already how most of the web handles this)
    for the H1 painting immediately in its fallback (`serif`) — should
    decouple LCP from font-load time entirely. Lowest-risk, highest-confidence
    fix in this audit.

- **[Performance] Render-blocking CSS.** `maplibre-gl.css` and `styles.css`
  are both plain blocking `<link rel="stylesheet">` tags.
  - **Impact:** `render-blocking-insight`: score 0, est. 721ms
    (`maplibre-gl.css`, 10.2KB) + 1,071ms (`styles.css`, 1.9KB) — note these
    are Lighthouse's per-resource estimates and likely overlap rather than
    strictly add.
  - **Evidence:** measured (`render-blocking-insight`).
  - **Fix:** consider the same `media="print" onload="this.media='all'"`
    async pattern already used for the Google Fonts `<link>` at
    `index.html:25`. Risk: `maplibre-gl.css` positions map controls/popups —
    deferring it could cause a brief flash of unstyled controls, needs visual
    testing before/after. `styles.css` is small and used for layout (`#app`
    grid, the CLS fix from 2026-09-02) — deferring it risks reintroducing the
    CLS that fix solved; test carefully or leave it blocking.

- **[Performance] 4-level-deep serial network dependency chain drags out
  Speed Index/TTI.** `network-dependency-tree-insight` (devtools run):
  `index.html` → `app.js` (finishes 2.8s: must fully execute before MapLibre
  can even request anything) → CARTO `style.json` (3.6s) → glyph PBFs, only
  discoverable from `style.json`'s own content (finish at **9.6s and
  11.4s**). This chain is very likely why Speed Index (9.0s) and TTI
  (11.9s) are both much worse than LCP (4.4s) suggests.
  - **Evidence:** measured (`network-dependency-tree-insight`).
  - **Fix (partial — shortens the chain by one hop, not all of it):** the
    `style.json` URL is one of exactly two static strings picked by theme
    (`carto-style.js:242-245`), and theme is already resolved synchronously
    before paint by the inline script at the top of `index.html`. That same
    script could inject a `<link rel="preload" as="fetch" crossorigin
    href="[the theme-appropriate style.json URL]">`, letting the browser
    start fetching it in parallel with `app.js` instead of waiting ~2.8s for
    `app.js` to execute first. The glyph PBFs after it are still only
    discoverable from `style.json`'s own content, so this doesn't collapse
    the whole chain — but pulling the first hop forward by ~2s should still
    meaningfully pull the rest forward with it. Not yet tried or measured.

### Not re-verified this round

- **The 2026-09-02 TBT root-cause breakdown** (bare MapLibre+CARTO ~52%, our
  contour/labels ~20%, our camera markers ~28%, via CPU-profile A/B testing)
  was not re-run. Bundling changes *how* MapLibre's JS is delivered, not
  what it does at runtime, so this breakdown is expected to still hold — but
  that's an assumption, not a re-measurement. TBT under real (`devtools`)
  throttling is 1,830ms median, still solidly in Lighthouse's "poor" band
  (>600ms) despite the chunking (`yieldToMain`) and CARTO-trimming fixes
  from the last audit already having shipped — worth a fresh CPU profile to
  see whether trimming CARTO's style already reduced the "bare MapLibre"
  share, and whether chunking is actually keeping individual tasks under
  50ms in production (`long-tasks` in this run still shows a 438ms task
  attributed to `app.js`).
- **The bundled MapLibre JS is 51% unused** (`unused-javascript`: 134.4KiB of
  265.1KiB `app.js` never executes in this session). Plausibly inherent to
  bundling a general-purpose GL library rather than something fixable with a
  simple change — not investigated further this round.

### Verified fix — 2026-09-03, same day, after shipping items 1 and the title/heading change

Item 1 (`display=swap`) shipped, plus an additional fix found in the same
session: the `<h1>` (the LCP element itself) was empty in the HTML and only
got its text from JS (`applySiteConfig()`, gated behind all of `app.js`
downloading/parsing/executing, ~2.8s) — moved to static HTML directly,
`site-config.js` removed. Re-ran the audit against production, 3×
devtools-throttled, median:

| Signal | Before (median of 3) | After (median of 3) | Change |
|---|---|---|---|
| Performance score | 49 | **64** | +15 |
| LCP | 4.4s | **1.4s** | −3.0s |
| FCP | 1.3s | 1.4s | ~flat |
| CLS | 0.012 | 0.003 | slightly better |
| Total Blocking Time | 1,830ms | 1,650ms | ~flat, still "poor" |
| Speed Index | 9.0s | 9.3s | ~flat |
| Interactive (TTI) | 11.9s | 12.1s | ~flat |

LCP and score moved almost exactly as predicted; TBT/Speed Index/TTI stayed
flat, also as expected — those are downstream of the still-open network-chain
(to-do #1 below) and TBT (#3) items, neither of which this round touched.

### Verified fix — 2026-09-03, later the same day: style.json preload

Shipped the `<link rel="preload" as="fetch" crossorigin>` hint for CARTO's
`style.json`, injected by the existing inline theme script. Confirmed via a
Playwright request-timing check that it worked as a single, non-duplicated
request (no "unused preload" warning) starting at **171ms**, down from ~3.6s.
Re-ran the audit against production, 3× devtools-throttled, median:

| Signal | Before this fix | After | Change |
|---|---|---|---|
| Performance score | 64 | 65 | ~flat |
| LCP | 1.4s | 1.4s | flat (already fixed) |
| CLS | 0.003 | 0.003 | flat |
| Total Blocking Time | 1,650ms | 1,670ms | flat, still "poor" |
| Speed Index | 9.3s | **8.8s** | −0.5s |
| Interactive (TTI) | 12.1s | **11.6s** | −0.5s |

Real, but smaller than the to-do list guessed. Root cause: pulling the
*network request* for `style.json` forward by ~3.4s doesn't pull forward
when the browser can *act* on the response — MapLibre only parses
`style.json` and issues the glyph-PBF requests after `app.js` itself has
downloaded, parsed, and started executing, and that ~2.8s gate didn't move.
So the win here is capped by "how much did the download itself overlap with
`app.js`'s own load time" rather than shortening the dependency chain's
depth, which is what actually drives Speed Index/TTI. The real fix for
those would be shrinking or parallelizing `app.js`'s own download+parse+
execute cost — which is exactly what to-do #3 (TBT root cause) below would
also address, so there's no separate action item to add here.

### Verified fix — 2026-09-03, later still: deferred maplibre-gl.css

Deferred with the same `media="print" onload` pattern as the fonts.
`styles.css` left blocking, untouched (small, and load-bearing for the
2026-09-02 CLS fix). Verified first under throttled network+CPU (Playwright
+ CDP, 4x CPU/1.6Mbps/150ms latency, mobile viewport): sampled DOM state
every 300ms–2s through a 14s window — at the first sample where MapLibre's
controls exist in the DOM, they already have their real styled size, no
frame with unstyled controls. Then re-ran the audit against production, 3×
devtools-throttled, median:

| Signal | Before this fix | After | Change |
|---|---|---|---|
| Performance score | 65 | 65 | flat |
| LCP | 1.4s | **1.3s** | −0.1s |
| FCP | 1.4s | **1.3s** | −0.1s |
| CLS | 0.003 | 0.003 | flat — no regression |
| Total Blocking Time | 1,670ms | 1,640ms | flat, still "poor" |
| Speed Index | 8.8s | 8.7s | flat |
| Interactive (TTI) | 11.6s | 11.6s | flat |

Same pattern as the `style.json` preload: a real but small win
(render-blocking-insight's ~721ms estimate didn't materialize at anywhere
near that size), and TBT/Speed Index/TTI still untouched. Both remaining
network/loading-side fixes from this audit are now shipped; what's left is
squarely the `app.js` execution-cost side (to-do below).

### CPU-profile TBT breakdown, re-run — 2026-09-03, later still

Attempted with Lighthouse's TBT metric first, against a local production-equivalent
build (`npm run build` + `npm run serve:dist`) — and found it **unusable as a
local baseline**: TBT came back as 70-140ms despite `mainthread-work-breakdown`
showing 1.3-3.4s of genuine Script Evaluation/Other work in the same trace.
Cause, confirmed via the raw `long-tasks` audit: TTI got marked mid-load,
around a lull at ~9.3-9.5s, with a further burst of long tasks continuing
past it up to ~19.6s — since TBT only sums tasks strictly between FCP and
TTI, everything after that mis-detected TTI point simply doesn't count. This
is specific to this project's local-serving setup (a single-connection
Python static server plus a live CDN for tiles/fonts/style produces a very
different request-timing shape than a real CDN edge for the whole page), not
a bug in the fixes shipped above — production TBT measurements earlier in
this document aren't affected by it.

Switched to the 2026-09-02 audit's own original methodology instead: a raw
CDP CPU profile (`Profiler.start`/`stop`, 4x CPU throttle, 8-second
post-load window), which doesn't depend on TTI detection at all. Also
switched the patch/measure/revert A/B test's comparison metric from TBT to
this same raw self-time sum. **One change from 2026-09-02's version of this
methodology:** MapLibre is now bundled into `app.js` as a single file (it
was a separate `maplibre-gl.min.js` URL before), so per-URL attribution can
no longer separate "MapLibre-internal" from "our own code" — the earlier
finding that essentially all self-time traces into MapLibre-internal
functions couldn't be re-confirmed this way. The three-variant A/B
comparison (which doesn't need that separation, only relative totals across
variants with different amounts of our own code removed) still works.

Three variants, 3 runs each (single-run noise turned out to be substantial —
up to ~40% spread within a variant — so medians are used, and these numbers
should be read as directional, not precise):

| Variant | Runs (ms) | Median |
|---|---|---|
| Bare CARTO style only (no contour/labels/markers) | 720, 413, 704 | 704ms |
| + contour mask/outline + region labels (no markers) | 658, 796, 1014 | 796ms |
| + 90 camera markers (full site, current) | 1171, 1049, 997 | 1049ms |

| Source | Contribution (of 1,049ms median full total) | 2026-09-02 (of 4,200ms TBT) |
|---|---|---|
| Bare MapLibre + CARTO | 704ms (67%) | ~2,170ms (52%) |
| Our contour/labels | 92ms (9%) | ~840ms (20%) |
| Our 90 camera markers | 253ms (24%) | ~1,190ms (28%) |

The contour/labels share dropped sharply (20% → 9%) — consistent with the
CARTO-trimming fix (shipped between the two audits) having worked
specifically well for that cost, on top of shrinking the bare-style cost
itself. Camera markers remain the second-largest contributor at a similar
relative share (~24-28%) across both audits. Bare MapLibre+CARTO is still
the largest single cost by a wide margin in both — consistent with the
2026-09-02 conclusion that this is inherent to MapLibre's own rendering
work, not something this project's own code controls.

**No new fix identified.** The dominant remaining cost (bare MapLibre+CARTO
rendering, ~700ms of actual CPU work under 4x throttle) doesn't have an
obvious lever left to pull from this project's side — CARTO's style is
already trimmed to this site's actual layers (2026-09-02), and the rest is
MapLibre v6's own tile-evaluation/paint cost. The camera-markers cost
(~253ms) is the one area with a plausible, bounded (~24% of total) further
target, but no specific optimization was identified this round — would need
its own profile drilling into what inside marker/cluster-layer setup is
expensive (expression evaluation, symbol placement, clustering itself).

### Camera-markers CPU cost, drilled into — 2026-09-03, later still

Read `addClusteredLayer()` and `marker.js` first: both are minimal — a
handful of `case`/`step`/`get` expressions over ~90 features, no
zoom-dependent stops, no heavy filters. Nothing there reads as expensive at
the JS level, so the ~253ms measured cost is more likely inside MapLibre's
own machinery (clustering computation, the GeoJSON-source tile-worker
pipeline) than in this project's paint definitions.

Tested that directly: same CPU-profile methodology, 3 runs, `cluster: true`
(current) vs. `cluster: false` (same 90 points, unclustered) on the source:

| Variant | Runs (ms) | Median |
|---|---|---|
| Clustered (current) | 1171, 1049, 997 | 1,049ms |
| Unclustered (`cluster: false`) | 1090, 875, 816 | 875ms |

Suggests clustering computation itself accounts for roughly 174ms of the
253ms marker cost — but that delta is smaller than the ~270ms run-to-run
spread *within* the unclustered variant alone, so it's a weak, directional
signal rather than a solid number. **Not recommending disabling clustering**
even if the full 174ms is real: with 70 photo + 20 video cameras clustered
down to a handful of circles at low zoom, clustering is a real, deliberate
UX feature (keeps overlapping markers legible), and trading it away for an
uncertain, sub-200ms gain isn't a good trade. No further action from this
thread — the camera-markers investigation is closed without a recommended
fix, same conclusion as the bare-MapLibre+CARTO cost above.

### Unused-MapLibre-bundle investigation — 2026-09-03, later still

Pulled the sourcemap-attributed byte ranges behind the 51%/134KiB
"unused-javascript" finding (Lighthouse's `unused-javascript` audit,
`subItems`, top 5 by wasted bytes):

| Source | Unused / total | Feature |
|---|---|---|
| `@maplibre/mlt/dist/decoding/fastPforUnpack.js` | 3,926 / 3,926 (100%) | MLT — an alternate binary vector-tile format we never request (CARTO serves standard MVT) |
| `geo/projection/vertical_perspective_transform.ts` | 3,451 / 3,456 (~100%) | Globe (3D sphere) projection — this site never switches out of flat Mercator |
| `ui/map.ts` | 4,749 / 9,406 | The main `Map` class itself — partially used, rest is other unused code paths (terrain, etc.) |
| `style/style.ts` | 3,935 / 7,442 | Style loading/diffing internals |
| `data/bucket/symbol_bucket.ts` | 2,330 / 3,564 | Symbol placement — partially used (we do have label/count text) |

These five account for only ~18KB of the 134KB total; the rest is spread
across many smaller files Lighthouse doesn't list individually — but the
pattern (whole features at ~100% unused) generalizes.

**Root cause, confirmed by reading `node_modules/maplibre-gl/package.json`:**
it declares `"sideEffects": ["*.css", "src/**/*.ts"]` — marking its *entire*
source tree as side-effecting. That's the standard signal a bundler (esbuild
included) uses to decide whether dropping an unused export is safe; marking
the whole tree this broadly means esbuild can't safely tree-shake any of it
out, regardless of what `app.js` actually calls. Its `exports` field also
offers exactly one public entry point (`dist/maplibre-gl.mjs`, the full
pre-bundled artifact) — no lighter/modular alternative to import instead.

**Confirmed as a known, unresolved upstream limitation**, not something
fixable from this project's side: [maplibre-gl-js issue
#977](https://github.com/maplibre/maplibre-gl-js/issues/977) ("Tree
shaking," open since Feb 2022) was closed without a real fix, labeled "PR
more than welcomed" — i.e. still wanted, nobody's shipped it. No smaller
official build, no globe/MLT opt-out flag, no workaround found. The only
paths that could move this number are outside this project's own code:
contributing a tree-shaking fix upstream, or (a bigger, separate
architectural decision, not attempted here) dropping MapLibre for a
different rendering library entirely.

## To-do

None remaining with a known fix. Every item from this audit has been either
shipped and measured (font-display, static title/heading, `style.json`
preload, deferred `maplibre-gl.css`) or investigated and closed without a
viable lever to pull (TBT/CPU-cost breakdown, camera-markers cost, unused
MapLibre bundle, bare MapLibre+CARTO's own rendering cost). Overall this
audit: score 49 → 65, LCP 4.4s → 1.3s.

## How to re-run this audit

Against the live site (preferred — matches real CDN latency):
```
CHROME_PATH=/usr/bin/google-chrome-stable npx lighthouse https://finestres-obertes.pages.dev/ \
  --only-categories=performance --preset=perf --form-factor=mobile --screenEmulation.mobile \
  --throttling-method=devtools \
  --output=json --output-path=./lh-report.json \
  --chrome-flags="--headless=new --no-sandbox"
```
Run at least 3× and report the median — single runs vary by several hundred
ms on TBT/LCP. `--throttling-method=devtools` gives self-consistent headline
metrics and per-resource insight timings (see note above); the historical
audits above used the `simulate` default instead, so a same-method
comparison isn't possible against them.

Against a local build instead (no real CDN latency, but works without a
deployed URL):
```
npm run build && npm run serve:dist   # serves dist/ on :8420
npx lighthouse http://localhost:8420 --only-categories=performance ...
```

The `performance`, `core-web-vitals`, and `web-quality-audit` project skills
(installed 2026-09-02) cover the methodology and interpretation used above.
