// URL of the deployed cameras-api Worker — kept here, local to this layer, rather
// than in the shared site-config.js: it's a cameras-layer implementation detail, not
// something a differently-laid-out version of the site would still need. The Worker
// (source: github.com/rogerbaiget/finestres-obertes-cameras-api) is the *only*
// source of the camera list — this site holds no camera data at all — so if it's
// unreachable, loadCameras() returns an empty list rather than falling back to
// anything local.
const CAMERA_STATUS_URL = 'https://finestres-obertes-cameras-api.roger-baiget.workers.dev';

// --- Load cameras + their live availability ---
// The Worker returns each cam already carrying a `broken` flag, checked server-side
// on an hourly Cron Trigger — not in the browser. Most of the photo-hosting third
// parties send no CORS headers at all, so a browser-side check is always blocked from
// reading the real result anyway, and checking a live multi-megabyte image from every
// visitor's browser on every page load was the single largest cost on the page (see
// PERFORMANCE.md). This is one small fetch instead.
export async function loadCameras(){
  try{
    const res = await fetch(CAMERA_STATUS_URL);
    if(!res.ok) return [];
    const {cams} = await res.json();
    return cams || [];
  }catch(e){
    return []; // worker unreachable — no cams to show rather than a broken map
  }
}
