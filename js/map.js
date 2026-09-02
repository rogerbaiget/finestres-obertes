import { loadComarques } from './data/comarques.js';
import { ANDORRA_CATALONIA_BORDER } from './data/andorra-catalonia-border.js';
import {
  CONTOUR_LOCAL_VERY_LOW, loadLow, loadLocal, loadDetail, loadVeryFine, loadFinest, loadMax
} from './data/contours.js';
import { loadCartoStyle } from './carto-style.js';
import { applyTheme } from './theme.js';
import { wirePlayerControls } from './ui/player.js';
import { camerasLayer } from './layers/cameras/index.js';
import { SITE_CONFIG } from './site-config.js';

// Data sources shown on the map. Each entry follows the layer shape documented in
// js/layers/cameras/index.js — add a new layer by adding its module here.
const LAYERS = [camerasLayer];

let map, maskSourceId = 'contour-mask', outlineSourceId = 'contour-outline';

function contourToGeoJSON(rings){
  // rings are [lat,lng]; GeoJSON needs [lng,lat]. First ring = world (outer), rest = holes.
  const world = [[-179,-89],[179,-89],[179,89],[-179,89],[-179,-89]];
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

function fitToContour(){
  map.fitBounds(computeContourBounds(), {padding:24, duration:0});
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
// outside the region), while the outline/comarques/Andorra-border layers go
// immediately after it (staying crisp, on top of both the mask and the sea).
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

async function updateContour(){
  const zoom = map.getZoom();
  const gen = ++contourGeneration;
  const rings = await pickContour(zoom);
  if(gen !== contourGeneration) return;
  const geo = contourToGeoJSON(rings);
  if(map.getSource(maskSourceId)){
    map.getSource(maskSourceId).setData(geo.mask);
    map.getSource(outlineSourceId).setData(geo.outline);
  }
}

async function addContourLayers(){
  // Remove any leftovers from a previous style (defensive, avoids "already exists" errors)
  [ 'contour-outline-layer','contour-mask-layer' ].forEach(id=>{ if(map.getLayer(id)) map.removeLayer(id); });
  [ maskSourceId, outlineSourceId ].forEach(id=>{ if(map.getSource(id)) map.removeSource(id); });

  const style0 = getComputedStyle(document.documentElement);
  const maskColor = style0.getPropertyValue('--mask').trim() || '#050d14';
  const maskOpacity = parseFloat(style0.getPropertyValue('--mask-opacity')) || 0.9;
  const geo = contourToGeoJSON(await pickContour(map.getZoom()));

  const { maskBeforeId, beforeId } = computeInsertionPoints(map.getStyle().layers);

  map.addSource(maskSourceId, {type:'geojson', data: geo.mask});
  map.addLayer({id:'contour-mask-layer', type:'fill', source:maskSourceId, paint:{'fill-color':maskColor, 'fill-opacity':maskOpacity}}, maskBeforeId);
  map.addSource(outlineSourceId, {type:'geojson', data: geo.outline});
  map.addLayer({id:'contour-outline-layer', type:'line', source:outlineSourceId, paint:{'line-color':'#f2b705', 'line-width':1.4, 'line-opacity':0.6}}, beforeId);

  updateComarquesVisibility();
  addAndorraCataloniaBorderLayer(beforeId);
}

// Andorra/Catalonia is the one country border kept on the map (see js/carto-style.js
// for why every other one is dropped): both sides sit inside the Catalan Countries
// contour, so it's styled like an internal boundary — same look as comarques — rather
// than the international border line CARTO would otherwise draw.
function andorraCataloniaBorderToGeoJSON(){
  return {type:'Feature', geometry:{type:'LineString', coordinates: ANDORRA_CATALONIA_BORDER.map(([lat,lng])=>[lng,lat])}};
}

function addAndorraCataloniaBorderLayer(beforeId){
  if(map.getLayer('andorra-catalonia-border-layer')) map.removeLayer('andorra-catalonia-border-layer');
  if(map.getSource('andorra-catalonia-border')) map.removeSource('andorra-catalonia-border');
  map.addSource('andorra-catalonia-border', {type:'geojson', data: andorraCataloniaBorderToGeoJSON()});
  const style0 = getComputedStyle(document.documentElement);
  map.addLayer({
    id:'andorra-catalonia-border-layer', type:'line', source:'andorra-catalonia-border',
    paint:{'line-color': style0.getPropertyValue('--sand').trim() || '#f1e4c8', 'line-width':0.8, 'line-opacity':0.45}
  }, beforeId);
}

// The layers/sources above all get torn down and rebuilt by addContourLayers() — fine
// on initial load, but on a theme toggle that meant a visible flicker: setStyle()'s
// diff (see the click handler below) already drops them, since none of them are part of
// either CARTO style JSON, and re-adding a GeoJSON source kicks off async tessellation,
// so there's a frame or two where the mask/outline/comarques/Andorra-border are all gone.
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
const COMARQUES_LAYER_ID = 'comarques-outline-layer'; // optional — only exists once the user has zoomed past COMARQUES_MIN_ZOOM at least once

function preserveContourLayersAcrossStyleSwap(newStyle){
  const current = map.getStyle();
  const requiredLayers = REQUIRED_LAYER_IDS.map(id => current.layers.find(l => l.id === id));
  if(requiredLayers.some(l => !l)) return false;

  const style0 = getComputedStyle(document.documentElement);
  const maskColor = style0.getPropertyValue('--mask').trim() || '#050d14';
  const maskOpacity = parseFloat(style0.getPropertyValue('--mask-opacity')) || 0.9;
  const sandColor = style0.getPropertyValue('--sand').trim() || '#f1e4c8';

  const [maskLayer, outlineLayer, andorraLayer] = requiredLayers.map(l => ({...l, paint: {...l.paint}}));
  maskLayer.paint['fill-color'] = maskColor;
  maskLayer.paint['fill-opacity'] = maskOpacity;
  andorraLayer.paint['line-color'] = sandColor;

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

  const comarquesLive = current.layers.find(l => l.id === COMARQUES_LAYER_ID);
  if(comarquesLive){
    const comarquesLayer = {...comarquesLive, paint: {...comarquesLive.paint, 'line-color': sandColor}};
    newStyle.sources['comarques'] = current.sources['comarques'];
    insertBefore(comarquesLayer, beforeId);
  }

  insertBefore(andorraLayer, beforeId);
  return true;
}

const COMARQUES_MIN_ZOOM = 8;

function comarquesToGeoJSON(data){
  const features = [];
  data.forEach(c=>{
    c.r.forEach(ring=>{
      features.push({type:'Feature', properties:{name:c.n}, geometry:{type:'LineString', coordinates: ring.map(([lat,lng])=>[lng,lat])}});
    });
  });
  return {type:'FeatureCollection', features};
}

// Fetches comarques.json (276KB) the first time it's actually needed — i.e. the first
// time the user zooms to COMARQUES_MIN_ZOOM — rather than on every page load
// regardless of zoom. Guarded against concurrent calls (e.g. two zoomend events firing
// before the first fetch resolves) with comarquesLoading.
let comarquesLoading = false;

async function addComarquesLayer(){
  if(map.getLayer(COMARQUES_LAYER_ID) || comarquesLoading) return;
  comarquesLoading = true;
  try{
    const data = await loadComarques();
    if(map.getLayer(COMARQUES_LAYER_ID)) return; // added by another call while this one awaited
    if(map.getSource('comarques')) map.removeSource('comarques');
    map.addSource('comarques', {type:'geojson', data: comarquesToGeoJSON(data)});
    const style0 = getComputedStyle(document.documentElement);
    const { beforeId } = computeInsertionPoints(map.getStyle().layers);
    map.addLayer({
      id:COMARQUES_LAYER_ID, type:'line', source:'comarques',
      paint:{'line-color': style0.getPropertyValue('--sand').trim() || '#f1e4c8', 'line-width':0.8, 'line-opacity':0.45},
      layout:{'visibility': map.getZoom() >= COMARQUES_MIN_ZOOM ? 'visible' : 'none'}
    }, beforeId);
  } finally {
    comarquesLoading = false;
  }
}

function updateComarquesVisibility(){
  if(map.getZoom() >= COMARQUES_MIN_ZOOM){
    if(map.getLayer(COMARQUES_LAYER_ID)){
      map.setLayoutProperty(COMARQUES_LAYER_ID, 'visibility', 'visible');
    }else{
      addComarquesLayer();
    }
  }else if(map.getLayer(COMARQUES_LAYER_ID)){
    map.setLayoutProperty(COMARQUES_LAYER_ID, 'visibility', 'none');
  }
}

function refreshContourColors(){
  if(!map || !map.getLayer('contour-mask-layer')) return;
  const style0 = getComputedStyle(document.documentElement);
  map.setPaintProperty('contour-mask-layer', 'fill-color', style0.getPropertyValue('--mask').trim());
  map.setPaintProperty('contour-mask-layer', 'fill-opacity', parseFloat(style0.getPropertyValue('--mask-opacity')));
  if(map.getLayer(COMARQUES_LAYER_ID)){
    map.setPaintProperty(COMARQUES_LAYER_ID, 'line-color', style0.getPropertyValue('--sand').trim());
  }
  if(map.getLayer('andorra-catalonia-border-layer')){
    map.setPaintProperty('andorra-catalonia-border-layer', 'line-color', style0.getPropertyValue('--sand').trim());
  }
}

function addLayerMarkers(layer){
  if(layer._markers) layer._markers.forEach(m=>m.remove());
  layer._markers = layer.items.map(item=>{
    const el = layer.createMarkerElement(item);
    el.addEventListener('click', ()=>layer.onSelect(item));
    return new maplibregl.Marker({element:el}).setLngLat([item.lng, item.lat]).addTo(map);
  });
}

function addAllMarkers(){
  LAYERS.forEach(addLayerMarkers);
}

// A layer whose data doesn't ship with the site (e.g. cameras, fetched from a
// Worker) implements load(); map.js just awaits whichever layers have one, generic
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

  // No maxBounds here: fitBounds() below would be clamped by whatever maxBounds is
  // already active *during* the fit call, which under-zooms and clips part of the
  // region — confirmed directly (with a small constructor-time maxBounds, fitting the
  // same contour bounds landed at zoom 7.3 and cut off everything outside roughly
  // 39.2-41.6°N; with no maxBounds active it correctly reached zoom 6.1, covering the
  // whole 37.6-43.1°N range). Panning is unrestricted for the brief moment before
  // 'load' fires below, which is harmless — there's no realistic way to interact with
  // the map in that window.
  map = new maplibregl.Map({
    container:'map', style, center:[1.3,41.5], zoom:6.6, minZoom:5,
    attributionControl:false
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');

  // Kicked off now rather than inside 'load' below: a layer's data (e.g. cameras,
  // fetched from a Worker) has no actual dependency on the map's style/tiles/fonts
  // finishing first, so starting the fetch in parallel with that avoids serializing
  // two unrelated round trips into one long chain.
  const layersLoaded = loadAllLayers();

  map.on('load', async ()=>{
    fitToContour();
    // Lock panning to whatever the fit above actually shows, rather than a guessed
    // fixed-degree margin: on a wide viewport, fitting the contour's height can need
    // several extra degrees of longitude to fill the width, so a small fixed margin
    // ends up tighter than the fit itself and clips part of the region on first load.
    // Deriving maxBounds from the real post-fit viewport can't be too tight this way,
    // for any window size/aspect ratio.
    map.setMaxBounds(map.getBounds());
    // The map itself is already interactive at this point — markers and the contour
    // pop in once their (already in-flight) data finishes loading, rather than
    // blocking the map on either fetch.
    await Promise.all([addContourLayers(), layersLoaded]);
    addAllMarkers();
  });
  map.on('zoomend', updateContour);
  map.on('zoomend', updateComarquesVisibility);

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
    const preserved = preserveContourLayersAcrossStyleSwap(newStyle);
    map.setStyle(newStyle);
    if(!preserved){
      // First toggle raced the initial 'load' handler — nothing to preserve yet, so
      // fall back to the same imperative add the initial load uses.
      await addContourLayers();
      refreshContourColors();
    }
    themeSwitching = false;
  });
  applyTheme(initialTheme);
}

initMap();
