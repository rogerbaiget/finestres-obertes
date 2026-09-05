# Finestres obertes

A map of live and recently-captured webcams across the Catalan Countries
(Catalunya, País Valencià, Illes Balears, Andorra, and l'Alguer) — "open
windows" onto each region. Built on [MapLibre GL JS](https://maplibre.org/)
over a trimmed CARTO basemap, with camera markers clustered and rendered as
native GPU layers rather than DOM elements.

Camera data isn't part of this repo: the map fetches it at runtime from a
separate Cloudflare Worker,
[finestres-obertes-cameras-service](https://github.com/rogerbaiget/finestres-obertes-cameras-service),
which is the only source of truth for the camera list and their live/broken
status.

## Requirements

- Node version pinned in [.nvmrc](.nvmrc)

## Development

```sh
npm install
npm run dev
```

Starts an esbuild watch+serve dev server at http://localhost:8420/ — it
bundles `src/js/app.js` (MapLibre GL JS is bundled in, not loaded from a CDN)
and rebuilds automatically on save.

## Building

```sh
npm run build
```

Produces the deployable site in `dist/`. To check the built output locally:

```sh
npm run serve:dist
```

## Deployment

Pushing to the `prod` branch triggers `.github/workflows/deploy.yml`, which
builds the site and publishes `dist/` to Cloudflare Pages (direct-upload
mode). `main` is pushed to freely; `prod` is fast-forwarded to it as the
deliberate "go live" step.

## Project structure

```
src/
  index.html
  styles.css
  js/
    app.js          — entry point: map setup, contours, region labels
    carto-style.js  — basemap style trimming + shared label styling
    theme.js        — light/dark theme handling
    ui/player.js    — camera player UI controls
    data/           — static geo data (borders, contour levels)
    layers/cameras/ — the cameras data layer (self-contained; see below)
build.mjs           — esbuild-based build/dev script
```

Each map data source is a self-contained "layer" living in its own
`js/layers/<name>/` folder (see `js/layers/cameras/index.js` for the shape
`app.js` expects). `app.js` only knows this generic interface — it has no
cameras-specific knowledge — so a future layer (weather stations, points of
interest, etc.) is added the same way, without touching `app.js`.
