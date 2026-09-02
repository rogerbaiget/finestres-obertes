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

- **[Performance] 70 webcam "availability check" calls download full-resolution
  photos on every page load, for markers that aren't even open yet.**
  File: `js/layers/webcams/status.js:9-14` (`checkPhoto`)
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
  `js/map.js:addAllMarkers()` — 70 photo + 20 video webcams each get a DOM
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
- **The webcam availability-check network calls entirely** — disabling them
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
