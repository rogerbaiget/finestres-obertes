import * as esbuild from 'esbuild';
import { rm, mkdir, cp, copyFile, readFile, writeFile } from 'node:fs/promises';

const OUT = 'dist';
const WATCH = process.argv.includes('--watch');

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// Bundle our own code together with maplibre-gl itself. Measured directly
// against two alternatives — loading MapLibre from a jsdelivr CDN, and
// self-hosting its own split output via a same-origin import map — and once
// fairly compared (matched compression, repeated runs to rule out noise from
// live tile-fetch variance) all three land in the same ~5,000-5,600ms Total
// Blocking Time range: that cost comes from MapLibre v6's own rendering work,
// not from how its JS is delivered. So the loading strategy is chosen on
// other grounds: bundling keeps MapLibre version bumps as a single rebuild
// (no separate vendor files to keep in sync with app.js), and needs no
// browser import-map support. format:'esm' keeps index.html's
// <script type="module"> tag valid.
//
// Bundling is also mandatory now, not just an optimization: app.js imports
// 'maplibre-gl' as a bare specifier, which only a bundler (not a plain static
// file server, as npm run dev used to be) can resolve. That's why dev mode
// below runs this same esbuild step instead of serving src/ directly.
const jsCtx = await esbuild.context({
  entryPoints: ['src/js/app.js'],
  outfile: `${OUT}/js/app.js`,
  bundle: true,
  minify: !WATCH,
  format: 'esm',
  target: 'esnext',
  sourcemap: true,
  logLevel: 'info',
});

// The Worker thread MapLibre spawns for tile processing runs in its own
// execution context with its own module registry — it can't reach into the
// main bundle above, so it needs its own real copy of maplibre-gl-worker.mjs,
// which in turn statically imports a maplibre-gl-shared.mjs sibling. Copying
// only the worker (as MapLibre's own docs snippet shows) reproduces a silent
// hang — confirmed via their own test/integration/bundler/esbuild fixture,
// which copies both. app.js's setWorkerUrl() call points at this exact path.
// CSS goes to dist/ root (sibling to styles.css) via a plain copy, not a JS
// import, so esbuild doesn't derive a second stylesheet from app.js's basename.
async function copyStaticAssets() {
  await mkdir(`${OUT}/js`, { recursive: true });
  await copyFile('node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', `${OUT}/js/maplibre-gl-worker.mjs`);
  await copyFile('node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs', `${OUT}/js/maplibre-gl-shared.mjs`);
  await copyFile('node_modules/maplibre-gl/dist/maplibre-gl.css', `${OUT}/maplibre-gl.css`);

  // Without a real file here, Cloudflare Pages' SPA-style fallback serves index.html
  // for the unmatched /robots.txt request instead of 404ing — Search Console then
  // tries to parse that HTML as robots.txt syntax and (correctly) rejects nearly
  // every line of it as invalid.
  await copyFile('src/robots.txt', `${OUT}/robots.txt`);

  // Runtime-fetched JSON: contours.js reaches these via a relative fetch()
  // string, not an import, so esbuild's bundler never sees them — copy verbatim.
  await cp('src/data/contours', `${OUT}/data/contours`, { recursive: true });

  // index.html: strip the 10 now-redundant modulepreload tags (bundling
  // already flattens the fetch chain they existed for; their target files no
  // longer exist as separate outputs in dist/, so leaving them in would 404).
  // A plain regex is enough here — one narrow, stable pattern in a small
  // hand-authored file, confirmed no other <link> has an href starting with
  // "js/". Revisit with a real HTML parser if that ever stops being true.
  // Everything else, including the entry <script type="module" src="js/app.js">
  // tag, is copied through unchanged: the bundle above lands at that exact
  // same relative path.
  let html = await readFile('src/index.html', 'utf8');
  html = html.replace(/[ \t]*<link rel="modulepreload" href="js\/[^"]+">\r?\n/g, '');
  await writeFile(`${OUT}/index.html`, html);
}
await copyStaticAssets();

// Single file, no @import chain — minify only, no bundling needed.
const cssCtx = await esbuild.context({
  entryPoints: ['src/styles.css'],
  outfile: `${OUT}/styles.css`,
  minify: !WATCH,
  logLevel: 'info',
});

if (WATCH) {
  // Static assets (worker/shared/css copies, data, index.html) aren't
  // esbuild outputs, so they don't participate in esbuild's own watch —
  // they only change when node_modules/maplibre-gl or src/index.html
  // change, neither of which happens mid-edit-cycle on app.js/styles.css.
  await jsCtx.watch();
  await cssCtx.watch();
  const { port } = await jsCtx.serve({ servedir: OUT, port: 8420 });
  console.log(`Dev server → http://localhost:${port}/`);
} else {
  await jsCtx.rebuild();
  await cssCtx.rebuild();
  await jsCtx.dispose();
  await cssCtx.dispose();
  console.log(`Build complete → ${OUT}/`);
}
