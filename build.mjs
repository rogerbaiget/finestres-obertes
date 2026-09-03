import { build } from 'esbuild';
import { rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';

const OUT = 'dist';

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// Bundle map.js's full import graph into one minified ESM file. maplibregl is
// referenced as a bare free identifier (never imported — it's attached to
// window by the separately-loaded CDN script), which esbuild's minifier
// never renames, so that keeps working unchanged. format:'esm' keeps
// index.html's <script type="module"> tag valid with no changes needed.
await build({
  entryPoints: ['src/js/map.js'],
  outfile: `${OUT}/js/map.js`,
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'esnext',
  sourcemap: true,
  logLevel: 'info',
});

// Single file, no @import chain — minify only, no bundling needed.
await build({
  entryPoints: ['src/styles.css'],
  outfile: `${OUT}/styles.css`,
  minify: true,
  logLevel: 'info',
});

// Runtime-fetched JSON: contours.js reaches these via a relative fetch()
// string, not an import, so esbuild's bundler never sees them — copy verbatim.
await cp('src/data/contours', `${OUT}/data/contours`, { recursive: true });

// index.html: strip the 10 now-redundant modulepreload tags (bundling
// already flattens the fetch chain they existed for; their target files no
// longer exist as separate outputs in dist/, so leaving them in would 404).
// A plain regex is enough here — one narrow, stable pattern in a small
// hand-authored file, confirmed no other <link> has an href starting with
// "js/". Revisit with a real HTML parser if that ever stops being true.
// Everything else, including the entry <script type="module" src="js/map.js">
// tag, is copied through unchanged: the bundle above lands at that exact
// same relative path.
let html = await readFile('src/index.html', 'utf8');
html = html.replace(/[ \t]*<link rel="modulepreload" href="js\/[^"]+">\r?\n/g, '');
await writeFile(`${OUT}/index.html`, html);

console.log(`Build complete → ${OUT}/`);
