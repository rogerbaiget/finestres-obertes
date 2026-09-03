import * as maplibregl from 'maplibre-gl';
// Mandatory once bundled: import.meta.url inside MapLibre's own source now
// resolves to this bundle's chunk, not MapLibre's real location, so its
// normal worker auto-detection would 404 silently (no error, load never
// fires — see MapLibre issue #8018). This path must match where build.mjs
// copies maplibre-gl-worker.mjs relative to this file's own output location.
maplibregl.setWorkerUrl(new URL('./maplibre-gl-worker.mjs', import.meta.url).toString());
import { ANDORRA_CATALONIA_BORDER } from './data/andorra-catalonia-border.js';
import {
  CONTOUR_LOCAL_VERY_LOW, loadLow, loadLocal, loadDetail, loadVeryFine, loadFinest, loadMax
} from './data/contours.js';
import { loadCartoStyle, REGION_LABEL_COLOR, REGION_LABEL_HALO, REGION_LABEL_LAYOUT } from './carto-style.js';
import { applyTheme } from './theme.js';
import { wirePlayerControls } from './ui/player.js';
import { camerasLayer } from './layers/cameras/index.js';
import { SITE_CONFIG } from './site-config.js';

// Data sources shown on the map. Each entry follows the layer shape documented in
// js/layers/cameras/index.js — add a new layer by adding its module here.
const LAYERS = [camerasLayer];

// Lighthouse's Total Blocking Time only counts the part of a task PAST 50ms — a single
// 500ms task contributes 450ms of TBT, but the same 500ms split into six ~83ms chunks
// (with a yield between each) contributes only 6*(83-50)=198ms, for identical total
// work. addContourLayers()/addRegionLabels()/addAllMarkers() each addSource/addLayer
// several times, and per a CPU profile taken during a performance audit, most of the
// actual time is spent inside MapLibre's own style-recalculation/tile-evaluation code
// that those calls trigger, not in this file's own functions — so splitting *between*
// these calls, not inside them, is what actually creates yield points in the right
// place. scheduler.yield() (Chrome 129+) is preferred when available since it's
// prioritized to run before other queued work the same way a continuation would;
// setTimeout(0) is a normal (de-prioritized, throttled-when-backgrounded) macrotask
// but still creates the task boundary that's actually needed here.
function yieldToMain(){
  if(typeof scheduler !== 'undefined' && scheduler.yield) return scheduler.yield();
  return new Promise(resolve => setTimeout(resolve, 0));
}

let map, maskSourceId = 'contour-mask', outlineSourceId = 'contour-outline';

// The mask's outer ring only needs to reach past whatever the map can ever actually
// show — maxBounds (set from the post-fit viewport once 'load' fires) already locks
// panning close to the contour itself (roughly 37.8-42.9°N, -1.5-8.4°E), regardless of
// window size/aspect ratio. A generous margin around that, rather than the true
// (-179,-89)-(179,89) world bounds used before, cuts the polygon's rasterized area by
// roughly 15x with no visual difference (nothing outside maxBounds is ever reachable
// to look different) — worth doing since a fill layer's GPU cost scales with the
// screen area it covers, and this shape gets rasterized on every frame it's visible,
// including under the sea (drawn over by 'water-sea' for correctness, but still
// rasterized underneath first).
const MASK_OUTER_BOUNDS = { minLng: -40, maxLng: 50, minLat: 15, maxLat: 65 };

function contourToGeoJSON(rings){
  // rings are [lat,lng]; GeoJSON needs [lng,lat]. First ring = the outer bound above, rest = holes.
  const { minLng, maxLng, minLat, maxLat } = MASK_OUTER_BOUNDS;
  const world = [[minLng,minLat],[maxLng,minLat],[maxLng,maxLat],[minLng,maxLat],[minLng,minLat]];
  const holes = rings.map(ring => ring.map(([lat,lng])=>[lng,lat]));
  return {
    mask: {type:'Feature', geometry:{type:'Polygon', coordinates:[world, ...holes]}},
    outline: {type:'FeatureCollection', features: holes.map(h=>({type:'Feature', geometry:{type:'LineString', coordinates:h}}))}
  };
}

function computeContourBounds(){
  let minLat=90, maxLat=-90, minLng=180, maxLng=-180;
  CONTOUR_LOCAL_VERY_LOW.forEach(ring=>ring.forEach(([lat,lng])=>{
    if(lat<minLat) minLat=lat; if(lat>maxLat) maxLat=lat;
    if(lng<minLng) minLng=lng; if(lng>maxLng) maxLng=lng;
  }));
  return [[minLng,minLat],[maxLng,maxLat]];
}

// Every level but VERY_LOW is fetched on demand (see data/contours.js) and cached
// there — only the level the current zoom actually needs gets downloaded, instead of
// all 7 (up to 320KB each) on every page load regardless of whether the user ever
// zooms in that far.
function pickContour(zoom){
  if(zoom < 6) return Promise.resolve(CONTOUR_LOCAL_VERY_LOW);
  if(zoom < 7) return loadLow();
  if(zoom < 8) return loadLocal();
  if(zoom < 9) return loadDetail();
  if(zoom < 10) return loadVeryFine();
  if(zoom < 11) return loadFinest();
  return loadMax();
}

// Shared by addContourLayers() and preserveContourLayersAcrossStyleSwap(): CARTO's
// actual *first* symbol layer overall is 'waterway_label' (river-name labels), which
// sits far earlier than roads/buildings/boundaries — style layers aren't cleanly split
// into "fills/lines first, then all labels"; labels are interleaved throughout for
// cartographic z-ordering. So "before the first symbol layer" is NOT a safe insertion
// point for anything meant to sit after all the land-detail layers.
//
// carto-style.js instead deliberately positions 'water-sea' at the very end of the
// non-label layers — after every road/rail/bridge/building/boundary line CARTO draws,
// and right before the first *late* label layer ('watername_ocean'). Using 'water-sea'
// as the shared reference point puts everything in the right place: the mask goes
// immediately before it (ending up after all land-detail layers, so they're dimmed
// outside the region), while the outline layer goes immediately after it (staying
// crisp, on top of both the mask and the sea).
function computeInsertionPoints(layers){
  const seaLayerIdx = layers.findIndex(l => l.id === 'water-sea');
  const seaLayer = seaLayerIdx >= 0 ? layers[seaLayerIdx] : null;
  const afterSeaLayer = seaLayerIdx >= 0 ? layers[seaLayerIdx + 1] : null;
  const maskBeforeId = seaLayer ? seaLayer.id : undefined;
  const beforeId = afterSeaLayer ? afterSeaLayer.id : maskBeforeId;
  return { maskBeforeId, beforeId };
}

// A zoom change can fire updateContour() again before an earlier call's fetch (for a
// level not loaded yet) resolves — this guards against the earlier one's stale data
// landing after the newer one's, which would otherwise leave the wrong detail level
// showing until the next zoomend.
let contourGeneration = 0;

// Tracks whichever rings array is currently applied to the mask/outline sources —
// pickContour() returns the SAME cached array/promise result for repeat calls within
// one tier, so reference equality is enough to tell "zoom moved but stayed in the same
// tier" apart from "zoom crossed into a new one". Without this check, updateContour()
// called setData() with equivalent data on every single zoomend regardless — visibly
// retessellating the mask (a single MultiPolygon covering everywhere outside the
// Catalan Countries, up to ~19,000 points at the finer tiers) on every zoom, which
// read as the whole map flashing/reloading each time a zoom gesture ended, confirmed
// directly by reproducing a zoom-in-then-out with no tier change and no network
// activity, yet the mask still visibly redrew.
let currentContourRings = null;

async function updateContour(){
  const zoom = map.getZoom();
  const gen = ++contourGeneration;
  const rings = await pickContour(zoom);
  if(gen !== contourGeneration) return;
  if(rings === currentContourRings) return;
  currentContourRings = rings;
  const geo = contourToGeoJSON(rings);
  if(map.getSource(maskSourceId)){
    map.getSource(maskSourceId).setData(geo.mask);
    map.getSource(outlineSourceId).setData(geo.outline);
  }
}

// ringsPromise defaults to a fresh fetch (used by the theme-toggle fallback, an edge
// case where nothing was pre-fetched), but the initial-load call site instead passes
// one already kicked off at map construction time — pickContour() has no dependency
// on the map's style/tiles/fonts being ready (map.getZoom() reflects the constructor's
// fitBoundsOptions immediately, confirmed directly: it doesn't change once the style
// finishes loading), so waiting for 'load' to even *start* this fetch was needlessly
// chaining it behind the entire style load — measured on the live site as by far the
// single longest request on the page (2.4s), worse than every other chain combined.
async function addContourLayers(ringsPromise = pickContour(map.getZoom())){
  // Remove any leftovers from a previous style (defensive, avoids "already exists" errors)
  [ 'contour-outline-layer','contour-mask-layer' ].forEach(id=>{ if(map.getLayer(id)) map.removeLayer(id); });
  [ maskSourceId, outlineSourceId ].forEach(id=>{ if(map.getSource(id)) map.removeSource(id); });

  const style0 = getComputedStyle(document.documentElement);
  const maskColor = style0.getPropertyValue('--mask').trim() || '#050d14';
  const maskOpacity = parseFloat(style0.getPropertyValue('--mask-opacity')) || 0.9;
  currentContourRings = await ringsPromise;
  const geo = contourToGeoJSON(currentContourRings);

  const { maskBeforeId, beforeId } = computeInsertionPoints(map.getStyle().layers);

  // maxzoom caps MapLibre's OWN internal re-tiling of these GeoJSON sources (separate
  // from, and in addition to, the zoom-tiered detail we already swap in via
  // updateContour()'s setData calls): every zoom past it then overzooms the same
  // already-generated tile(s) instead of crossing into freshly-generated ones — left
  // at the default (18), crossing an integer zoom made MapLibre swap tiles, and for a
  // moment before the new one was ready the previous one was just gone (the mask, a
  // single polygon covering everywhere outside the Catalan Countries, visibly
  // disappearing mid-zoom), confirmed via a fast zoom sequence with settle-waits
  // removed. maxzoom alone wasn't enough, though: our region straddles longitude 0, so
  // it always spans (at least) two horizontally-adjacent tiles at any zoom above 0 —
  // panning during an aggressive zoom could still bring one of those into view for the
  // first time, causing one more single-frame gap, confirmed with an automated check
  // that queries a known-outside-contour point at every step of a fast zoom-in/out
  // sequence and verifies the mask actually covers it whenever it's on-screen. A
  // larger buffer (default 128, out of 4096 units) helps some (each tile already
  // renders past its own edge, into its neighbour's territory) but doesn't close it
  // completely and going much past 512 makes it measurably worse (more duplicated
  // geometry per tile slows each one's own worker-side generation, widening the exact
  // race it's meant to shrink) — a residual single-frame gap remains achievable with
  // an adversarially fast synthetic zoom sequence, not reproduced at realistic
  // interaction speeds.
  //
  // A too-low maxzoom has a second, separate cost, though: it also caps geojson-vt's
  // simplification tolerance to whatever's "good enough" at that zoom's own scale —
  // maxzoom:4's tolerance is roughly 3.7km, throwing away everything finer no matter
  // how detailed updateContour()'s own 'max' tier data (up to ~19,000 points) actually
  // is, and overzooming further only scales up that already-coarsened line. maxzoom:0
  // (the most aggressive anti-flicker setting — exactly one tile, globally) makes this
  // worst: geojson-vt quantizes each tile's internal coordinates to a fixed 4096-unit
  // grid regardless of source detail, and at zoom 0 that grid covers the whole world
  // (~10km per unit) — visibly blocky, confirmed directly. Raising it enough to keep
  // real detail (11, matching pickContour()'s own threshold for the finest tier) fixes
  // that — but mask and outline MUST use the same value: they're built from the same
  // rings (see contourToGeoJSON below), so a mismatched maxzoom between them
  // tessellates the same coordinates at two different tolerances, and the two edges
  // visibly stop lining up at high zoom — confirmed directly (and reported) after a
  // first attempt tried raising only the outline's.
  map.addSource(maskSourceId, {type:'geojson', data: geo.mask, maxzoom: 11, buffer: 512});
  map.addLayer({id:'contour-mask-layer', type:'fill', source:maskSourceId, paint:{'fill-color':maskColor, 'fill-opacity':maskOpacity}}, maskBeforeId);
  map.addSource(outlineSourceId, {type:'geojson', data: geo.outline, maxzoom: 11, buffer: 512});
  map.addLayer({id:'contour-outline-layer', type:'line', source:outlineSourceId, paint:{'line-color':'#f2b705', 'line-width':1.4, 'line-opacity':0.6}}, beforeId);

  addAndorraCataloniaBorderLayer(beforeId);
  // Not added here: addRegionLabels() needs to run before camera markers exist (see
  // call sites below), so marker circles paint on top of region-name text instead of
  // the reverse — a marker sitting right under a big region label reads better when
  // its own circle/count stays fully visible.
}

// Andorra/Catalonia is the one country border kept on the map (see js/carto-style.js
// for why every other one is dropped): both sides sit inside the Catalan Countries
// contour, so it's styled to look exactly like CARTO's own internal region boundaries
// (e.g. the Catalonia/Franja de Ponent line) rather than the international border
// line CARTO would otherwise draw — paint values copied directly from CARTO's own
// 'boundary_state' layer (admin_level 4) in both style.jsons, dash pattern included,
// rather than a bespoke approximation.
const BOUNDARY_STATE_PAINT = {
  dark: {
    'line-color': {stops: [[4,'rgba(103,103,114,1)'],[5,'rgba(103,103,114,1)'],[6,'rgba(103,103,114,1)']]},
    'line-width': {stops: [[4,0.5],[7,1],[8,1],[9,1.2]]},
    'line-dasharray': {stops: [[6,[1,2,3]],[7,[1,2,3]]]}
  },
  light: {
    'line-color': {stops: [[4,'#ead5d7'],[5,'#ead5d7'],[6,'#e1c5c7']]},
    'line-width': {stops: [[4,0.5],[7,1],[8,1],[9,1.2]]},
    'line-dasharray': {stops: [[6,[1]],[7,[2,2]]]}
  }
};

function andorraCataloniaBorderToGeoJSON(){
  return {type:'Feature', geometry:{type:'LineString', coordinates: ANDORRA_CATALONIA_BORDER.map(([lat,lng])=>[lng,lat])}};
}

function addAndorraCataloniaBorderLayer(beforeId){
  if(map.getLayer('andorra-catalonia-border-layer')) map.removeLayer('andorra-catalonia-border-layer');
  if(map.getSource('andorra-catalonia-border')) map.removeSource('andorra-catalonia-border');
  map.addSource('andorra-catalonia-border', {type:'geojson', data: andorraCataloniaBorderToGeoJSON()});
  const mode = document.documentElement.classList.contains('light') ? 'light' : 'dark';
  map.addLayer({
    id:'andorra-catalonia-border-layer', type:'line', source:'andorra-catalonia-border',
    paint: BOUNDARY_STATE_PAINT[mode]
  }, beforeId);
}

// Region-style labels for places CARTO's own place data doesn't give a usable one
// for: Illes Balears has no region-level ("state") label at all — only per-island
// names like "Mallorca" — since the archipelago isn't a single contiguous shape with
// a natural label point; l'Alguer only has small town-level entries in CARTO's own
// data (excluded in carto-style.js, so this is its only label at any zoom). Both
// drawn here instead, using REGION_LABEL_LAYOUT/REGION_LABEL_COLOR imported from
// carto-style.js so they can't drift out of sync with place_state/place_country's own
// (also-overridden-there) styling. Both share one source/layer (a 2-feature
// FeatureCollection) rather than one each, since their styling is already identical —
// one less layer for MapLibre to set up and evaluate paint/layout expressions for on
// every render.
const REGION_LABEL_SOURCE_ID = 'region-labels';
const REGION_LABEL_ID = 'region-labels-layer';

// [name, lng, lat] for each custom label. l'Alguer's point is offset a little out to
// sea, northwest of the city itself (8.3154, 40.5587) — centered exactly on it, our
// big uppercase label sat right on top of CARTO's own (small) town dot and name,
// crowding both.
const REGION_LABEL_POINTS = [
  ['Illes Balears', 2.2, 39.3],
  ["l'Alguer", 8.05, 40.60]
];

function regionLabelsGeoJSON(){
  return {
    type: 'FeatureCollection',
    features: REGION_LABEL_POINTS.map(([name, lng, lat]) => (
      {type:'Feature', properties:{name}, geometry:{type:'Point', coordinates:[lng, lat]}}
    ))
  };
}

function regionLabelPaint(mode){
  return {'text-color': REGION_LABEL_COLOR[mode], 'text-halo-color': REGION_LABEL_HALO[mode], 'text-halo-width': 0.8};
}

function addRegionLabels(){
  if(map.getLayer(REGION_LABEL_ID)) map.removeLayer(REGION_LABEL_ID);
  if(map.getSource(REGION_LABEL_SOURCE_ID)) map.removeSource(REGION_LABEL_SOURCE_ID);

  const mode = document.documentElement.classList.contains('light') ? 'light' : 'dark';
  map.addSource(REGION_LABEL_SOURCE_ID, {type:'geojson', data: regionLabelsGeoJSON()});
  map.addLayer({
    id: REGION_LABEL_ID, type:'symbol', source: REGION_LABEL_SOURCE_ID,
    layout: {...REGION_LABEL_LAYOUT, 'text-field': ['get','name']}, paint: regionLabelPaint(mode)
  });
}

// The custom-label equivalent of preserveContourLayersAcrossStyleSwap() below: lifts
// the *current* (live) source/layer definitions into the new style before setStyle()
// runs, with only the paint colors patched for the new theme, so the diff sees them
// already present and unchanged geometry-wise — just a setPaintProperty, not a
// remove/re-add. Without this, Illes Balears/l'Alguer visibly disappeared and popped
// back in on every theme toggle (setStyle's diff drops them, since neither is part of
// either CARTO style JSON, then addRegionLabels() rebuilt them from scratch a beat
// later) — the same flicker the contour/cluster layers would have had without their
// own preservation. Returns false if nothing's there yet (e.g. a toggle racing the
// very first load), so the caller can fall back to a fresh addRegionLabels().
function preserveRegionLabelsAcrossStyleSwap(newStyle, newMode){
  const current = map.getStyle();
  const liveLayer = current.layers.find(l => l.id === REGION_LABEL_ID);
  if(!liveLayer) return false;

  newStyle.sources = {...newStyle.sources, [REGION_LABEL_SOURCE_ID]: current.sources[REGION_LABEL_SOURCE_ID]};
  newStyle.layers = [...newStyle.layers, {...liveLayer, paint: regionLabelPaint(newMode)}];
  return true;
}

// The layers/sources above all get torn down and rebuilt by addContourLayers() — fine
// on initial load, but on a theme toggle that meant a visible flicker: setStyle()'s
// diff (see the click handler below) already drops them, since none of them are part of
// either CARTO style JSON, and re-adding a GeoJSON source kicks off async tessellation,
// so there's a frame or two where the mask/outline/Andorra-border are all gone.
//
// To avoid that, the toggle handler calls this first: it lifts the *current* (live)
// definitions of these layers/sources — unchanged except for the paint colors that
// actually differ between themes — and splices them into the new style object before
// handing it to setStyle(). Diffing then sees each of them present, in the same
// position, in both the old and new serialized style, so it emits only the
// setPaintProperty calls for the color change — no remove/add, no re-tessellation, no
// flicker. Returns false (nothing spliced in) if the *required* layers aren't there
// yet — e.g. a toggle click racing the very first 'load' — so the caller can fall back
// to addContourLayers().
const REQUIRED_LAYER_IDS = ['contour-mask-layer','contour-outline-layer','andorra-catalonia-border-layer'];
const REQUIRED_SOURCE_IDS = [maskSourceId, outlineSourceId, 'andorra-catalonia-border'];

function preserveContourLayersAcrossStyleSwap(newStyle){
  const current = map.getStyle();
  const requiredLayers = REQUIRED_LAYER_IDS.map(id => current.layers.find(l => l.id === id));
  if(requiredLayers.some(l => !l)) return false;

  const style0 = getComputedStyle(document.documentElement);
  const maskColor = style0.getPropertyValue('--mask').trim() || '#050d14';
  const maskOpacity = parseFloat(style0.getPropertyValue('--mask-opacity')) || 0.9;
  const mode = document.documentElement.classList.contains('light') ? 'light' : 'dark';

  const [maskLayer, outlineLayer, andorraLayer] = requiredLayers.map(l => ({...l, paint: {...l.paint}}));
  maskLayer.paint['fill-color'] = maskColor;
  maskLayer.paint['fill-opacity'] = maskOpacity;
  Object.assign(andorraLayer.paint, BOUNDARY_STATE_PAINT[mode]);

  newStyle.sources = {...newStyle.sources};
  REQUIRED_SOURCE_IDS.forEach(id => { if(current.sources[id]) newStyle.sources[id] = current.sources[id]; });

  const { maskBeforeId, beforeId } = computeInsertionPoints(newStyle.layers);

  newStyle.layers = [...newStyle.layers];
  function insertBefore(layer, targetId){
    const idx = targetId ? newStyle.layers.findIndex(l => l.id === targetId) : -1;
    if(idx === -1) newStyle.layers.push(layer);
    else newStyle.layers.splice(idx, 0, layer);
  }
  insertBefore(maskLayer, maskBeforeId);
  insertBefore(outlineLayer, beforeId);
  insertBefore(andorraLayer, beforeId);
  return true;
}

function refreshContourColors(){
  if(!map || !map.getLayer('contour-mask-layer')) return;
  const style0 = getComputedStyle(document.documentElement);
  map.setPaintProperty('contour-mask-layer', 'fill-color', style0.getPropertyValue('--mask').trim());
  map.setPaintProperty('contour-mask-layer', 'fill-opacity', parseFloat(style0.getPropertyValue('--mask-opacity')));
  if(map.getLayer('andorra-catalonia-border-layer')){
    const mode = document.documentElement.classList.contains('light') ? 'light' : 'dark';
    Object.entries(BOUNDARY_STATE_PAINT[mode]).forEach(([prop, value])=>{
      map.setPaintProperty('andorra-catalonia-border-layer', prop, value);
    });
  }
}

function themeClusterColors(){
  const style0 = getComputedStyle(document.documentElement);
  return [
    style0.getPropertyValue('--sand').trim() || '#f1e4c8',
    style0.getPropertyValue('--blue-dark').trim() || '#0a1f2e'
  ];
}

// Adds a layer's items as a clustered GeoJSON source with GPU-drawn circle/symbol
// layers, rather than one DOM element per item — far cheaper at this scale, since the
// browser never creates or lays out 90 individual elements. Normally called once,
// after the initial load; a theme toggle instead goes through
// preserveClusteredLayersAcrossStyleSwap() below and only falls back to a full re-add
// here if that couldn't find anything to preserve.
//
// Click/hover interactivity is wired once ever (guarded by _clusterInteractionWired)
// rather than on every re-add: MapLibre's layer-filtered map.on() resolves the layer
// id at event time, not at registration time, so a listener registered against
// 'cameras-point-0' keeps working correctly across that layer being removed and
// recreated with the same id — registering it again on every theme toggle would just
// stack up duplicate handlers.
function addClusteredLayer(layer){
  const pointLayers = layer.buildPointLayers();
  const clusterLayers = layer.buildClusterLayers(...themeClusterColors());
  const pointIds = pointLayers.map((_, i)=>`${layer.id}-point-${i}`);
  const clusterIds = clusterLayers.map((_, i)=>`${layer.id}-cluster-${i}`);

  [...pointIds, ...clusterIds].forEach(id=>{ if(map.getLayer(id)) map.removeLayer(id); });
  if(map.getSource(layer.id)) map.removeSource(layer.id);

  map.addSource(layer.id, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: layer.items.map(layer.toFeature) },
    cluster: true, clusterRadius: layer.cluster.radius, clusterMaxZoom: layer.cluster.maxZoom
  });

  // MapLibre's style validation rejects a `layout` key present with value undefined
  // (as opposed to the key being absent entirely) — def.layout is only set for the
  // cluster count's symbol layer, so it's spread in rather than always included.
  pointLayers.forEach((def, i)=>{
    map.addLayer({
      id: pointIds[i], source: layer.id, type: def.type, paint: def.paint, ...(def.layout && {layout: def.layout}),
      filter: def.extraFilter ? ['all', ['!', ['has','point_count']], def.extraFilter] : ['!', ['has','point_count']]
    });
  });
  clusterLayers.forEach((def, i)=>{
    map.addLayer({ id: clusterIds[i], source: layer.id, type: def.type, paint: def.paint, ...(def.layout && {layout: def.layout}), filter: ['has','point_count'] });
  });

  if(!layer._clusterInteractionWired){
    layer._clusterInteractionWired = true;
    // Only the layer(s) explicitly marked `interactive` get click/hover wiring — a
    // sub-layer like the video glow only matches a subset of points (missing clicks
    // on everything else), and wiring both the cluster circle and its count-text
    // symbol layer would fire every click twice, since both cover the same features.
    pointIds.filter((_, i)=>pointLayers[i].interactive).forEach(id=>{
      map.on('mouseenter', id, ()=>{ map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, ()=>{ map.getCanvas().style.cursor = ''; });
      map.on('click', id, e=> layer.onSelect(layer.fromFeature(e.features[0])) );
    });
    clusterIds.filter((_, i)=>clusterLayers[i].interactive).forEach(id=>{
      map.on('mouseenter', id, ()=>{ map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, ()=>{ map.getCanvas().style.cursor = ''; });
      map.on('click', id, e=>{
        const feature = e.features[0];
        // getClusterExpansionZoom is promise-based in this MapLibre version (not the
        // Node-style callback its own type signature still documents) — confirmed
        // directly against the library's source rather than assumed.
        map.getSource(layer.id).getClusterExpansionZoom(feature.properties.cluster_id)
          .then(zoom => map.easeTo({ center: feature.geometry.coordinates, zoom }))
          .catch(()=>{});
      });
    });
  }
}

function addAllMarkers(){
  LAYERS.forEach(addClusteredLayer);
}

// The clustered-layer equivalent of preserveContourLayersAcrossStyleSwap() above:
// lifts a layer's *current* source/layers into the new style before setStyle() runs,
// so the diff sees them already present and just patches paint properties instead of
// tearing the source down and rebuilding it — the same flicker addClusteredLayer()'s
// remove-then-add would otherwise cause on every theme toggle.
//
// The point/glow layers carry no theme-dependent colors (camera media/broken state
// determines those, not light/dark mode), so their *live* definitions are copied
// across unchanged, filter included. The cluster bubble/count layers do depend on
// theme (--sand/--blue-dark), so rather than app.js needing to know which specific
// paint properties that affects, it just asks the layer to build fresh cluster-layer
// definitions for the new theme's colors — the same function used to add them in the
// first place — and splices those in instead. Returns false (nothing to preserve) if
// the layer's source was never added yet, e.g. a toggle racing the very first load.
function spliceClusteredLayer(newStyle, layer){
  const current = map.getStyle();
  if(!current.sources[layer.id]) return false;

  const pointIds = layer.buildPointLayers().map((_, i)=>`${layer.id}-point-${i}`);
  const livePointLayers = pointIds.map(id => current.layers.find(l => l.id === id));
  if(livePointLayers.some(l => !l)) return false;

  const clusterLayers = layer.buildClusterLayers(...themeClusterColors());
  const clusterIds = clusterLayers.map((_, i)=>`${layer.id}-cluster-${i}`);

  newStyle.sources = {...newStyle.sources, [layer.id]: current.sources[layer.id]};
  newStyle.layers = [...newStyle.layers, ...livePointLayers];
  clusterLayers.forEach((def, i)=>{
    newStyle.layers.push({
      id: clusterIds[i], source: layer.id, type: def.type, paint: def.paint,
      ...(def.layout && {layout: def.layout}), filter: ['has','point_count']
    });
  });
  return true;
}

function preserveClusteredLayersAcrossStyleSwap(newStyle){
  return LAYERS.every(layer => spliceClusteredLayer(newStyle, layer));
}

// A layer whose data doesn't ship with the site (e.g. cameras, fetched from a
// Worker) implements load(); app.js just awaits whichever layers have one, generic
// to any future layer, before drawing markers.
async function loadAllLayers(){
  await Promise.all(LAYERS.map(layer => layer.load ? layer.load() : null));
}

function applySiteConfig(){
  document.title = SITE_CONFIG.title;
  document.getElementById('site-heading').textContent = SITE_CONFIG.heading;
}

function renderLegend(){
  const legendEl = document.getElementById('legend');
  LAYERS.forEach(layer=>{
    (layer.legend || []).forEach(({color, label, size, boxShadow, opacity})=>{
      const item = document.createElement('span');
      const swatch = document.createElement('i');
      swatch.style.background = color;
      if(size){ swatch.style.width = size + 'px'; swatch.style.height = size + 'px'; }
      if(boxShadow) swatch.style.boxShadow = boxShadow;
      if(opacity != null && opacity < 1) swatch.style.opacity = opacity;
      item.append(swatch, ' ' + label);
      legendEl.appendChild(item);
    });
  });
}

async function initMap(){
  applySiteConfig();
  renderLegend();
  wirePlayerControls();

  const initialTheme = localStorage.getItem('theme') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const style = await loadCartoStyle(initialTheme === 'light' ? 'light' : 'dark');

  // Passed as the constructor's own bounds/fitBoundsOptions, rather than a guessed
  // center/zoom followed by a corrective fitBounds() once 'load' fires: that
  // sequence painted the guessed view first, then visibly snapped to the real one —
  // this way the very first frame the map ever paints is already the fitted view.
  //
  // No maxBounds here: the fit would be clamped by whatever maxBounds is already
  // active *during* the fit, which under-zooms and clips part of the region —
  // confirmed directly (with a small constructor-time maxBounds, fitting the same
  // contour bounds landed at zoom 7.3 and cut off everything outside roughly
  // 39.2-41.6°N; with no maxBounds active it correctly reached zoom 6.1, covering the
  // whole 37.6-43.1°N range). Panning is unrestricted for the brief moment before
  // 'load' fires below, which is harmless — there's no realistic way to interact with
  // the map in that window.
  map = new maplibregl.Map({
    container:'map', style, bounds: computeContourBounds(), fitBoundsOptions:{padding:24}, minZoom:5,
    attributionControl:false
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');

  // Both kicked off now rather than inside 'load' below: neither a layer's data
  // (e.g. cameras, fetched from a Worker) nor the initial contour level has any
  // actual dependency on the map's style/tiles/fonts finishing first — map.getZoom()
  // already reflects the constructor's fitBoundsOptions immediately, confirmed
  // directly (it doesn't change once the style finishes loading). Starting both
  // fetches in parallel with that avoids serializing unrelated round trips into one
  // long chain — the contour fetch in particular, previously gated behind 'load'
  // entirely, measured as the single longest request on the live site (2.4s).
  const layersLoaded = loadAllLayers();
  const contourRingsLoaded = pickContour(map.getZoom());

  map.on('load', async ()=>{
    // Lock panning to whatever the constructor's fit above actually shows, rather than a guessed
    // fixed-degree margin: on a wide viewport, fitting the contour's height can need
    // several extra degrees of longitude to fill the width, so a small fixed margin
    // ends up tighter than the fit itself and clips part of the region on first load.
    // Deriving maxBounds from the real post-fit viewport can't be too tight this way,
    // for any window size/aspect ratio.
    map.setMaxBounds(map.getBounds());
    // The map itself is already interactive at this point — markers and the contour
    // pop in once their (already in-flight) data finishes loading, rather than
    // blocking the map on either fetch.
    await Promise.all([addContourLayers(contourRingsLoaded), layersLoaded]);
    await yieldToMain();
    addRegionLabels();
    await yieldToMain();
    addAllMarkers();
  });
  map.on('zoomend', updateContour);

  let themeSwitching = false;
  document.getElementById('theme-toggle').addEventListener('click', async ()=>{
    // Guards against a second click landing mid-swap: overlapping setStyle() calls
    // raced each other and could leave the border/mask missing for several seconds.
    if(themeSwitching) return;
    themeSwitching = true;
    const newTheme = document.documentElement.classList.contains('light') ? 'dark' : 'light';
    applyTheme(newTheme);
    const newStyle = await loadCartoStyle(newTheme);
    // Both themes share the same CARTO vector source/tiles/glyphs (only the sprite and
    // each layer's paint/layout differ), so diffing — the setStyle() default — patches
    // colors and swaps the sprite in place without refetching any tiles, unlike a full
    // style teardown (diff:false). MapLibre 4.7's diff path (Style.setState) applies
    // every add/removeLayer/setPaintProperty/etc. synchronously and fires no event
    // afterwards, so — unlike the initial load, which waits for the map's 'load' event —
    // the code below runs right after setStyle() returns, not from a callback.
    // Spliced in this order (labels, then clusters) because each push()es onto the end
    // of newStyle.layers — so if both fall through to a fresh add below, labels are
    // still added (and thus painted) before markers, keeping marker circles on top.
    const preserved = preserveContourLayersAcrossStyleSwap(newStyle);
    const labelsPreserved = preserveRegionLabelsAcrossStyleSwap(newStyle, newTheme);
    const clustersPreserved = preserveClusteredLayersAcrossStyleSwap(newStyle);
    map.setStyle(newStyle);
    if(!preserved){
      // First toggle raced the initial 'load' handler — nothing to preserve yet, so
      // fall back to the same imperative add the initial load uses.
      await addContourLayers();
      refreshContourColors();
    }
    await yieldToMain();
    if(!labelsPreserved){
      // Same situation as above, for Illes Balears/l'Alguer — nothing existed yet to
      // lift into the new style, so just add them fresh.
      addRegionLabels();
    }
    await yieldToMain();
    if(!clustersPreserved){
      // Same situation as above, for camera clusters — nothing existed yet to lift
      // into the new style, so just add them fresh (from the already-loaded items,
      // no refetch).
      addAllMarkers();
    }
    themeSwitching = false;
  });
  applyTheme(initialTheme);
}

initMap();
