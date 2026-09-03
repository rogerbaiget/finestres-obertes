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

## To-do (priority order)

1. **`display=block` → `display=swap`** on the Google Fonts `<link>`
   (`index.html:25`, both the real tag and its `<noscript>` twin). Highest
   confidence, lowest risk, largest expected single win (~4s off LCP).
2. **Preload the theme-appropriate CARTO `style.json`** from the inline
   theme script in `index.html`, using `<link rel="preload" as="fetch"
   crossorigin>`, to start that fetch in parallel with `app.js` instead of
   after it.
3. **Re-run this audit (3× devtools-throttled, median) after 1–2** to get
   real before/after numbers rather than estimates.
4. **Try deferring `maplibre-gl.css`** with the same async-CSS pattern as
   the fonts; visually verify no control/popup flash before keeping it.
   Leave `styles.css` blocking unless testing proves the CLS fix survives
   deferring it too.
5. **Re-run the CPU-profile TBT breakdown** (bare MapLibre+CARTO vs. our
   layers vs. our markers, as done 2026-09-02) to confirm the ~52/20/28
   split still holds after CARTO-trimming and bundling, and check whether
   `yieldToMain()` chunking is actually keeping tasks under 50ms in
   production (a 438ms task was observed this round).
6. **Investigate the 51%-unused MapLibre bundle** only if 1–5 don't get TBT/
   bundle-size where you want them — lower confidence this has an easy fix,
   higher effort to investigate (would need to check which MapLibre features
   `app.js` actually exercises vs. what esbuild's tree-shaking is keeping).

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
