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

## How to re-run this audit

```
python3 -m http.server 8420   # from the repo root
npx lighthouse http://localhost:8420 \
  --output=json --output-path=./lh-report.json \
  --chrome-flags="--headless=new --no-sandbox" \
  --only-categories=performance
```

The `performance`, `core-web-vitals`, and `web-quality-audit` project skills
(installed 2026-09-02) cover the methodology and interpretation used above.
