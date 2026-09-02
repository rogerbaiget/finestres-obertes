// Comarca (county) boundaries of Catalonia, shown only when zoomed in (see
// COMARQUES_MIN_ZOOM in map.js). Source: Institut Cartogràfic Nacional 2025 dataset
// (via ArnauInes/geometries_cat_bcn_2024), simplified with Turf.js. Includes all 43
// current comarques (e.g. Lluçanès), unlike older OSM-derived extracts.
//
// Stored as static JSON (comarques.json, 276KB) rather than a JS module: nobody needs
// this before they zoom in, so it's fetched on demand — cached after the first call —
// instead of downloaded and parsed on every page load regardless of zoom.
let promise;
export function loadComarques(){
  if(!promise) promise = fetch('js/data/comarques.json').then(r => r.json());
  return promise;
}
