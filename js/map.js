import { COMARQUES_DATA } from './data/comarques.js';
import { ANDORRA_CATALONIA_BORDER } from './data/andorra-catalonia-border.js';
import {
  CONTOUR_LOCAL_VERY_LOW, CONTOUR_LOCAL_LOW, CONTOUR_LOCAL, CONTOUR_LOCAL_DETAIL,
  CONTOUR_LOCAL_VERY_FINE, CONTOUR_LOCAL_FINEST, CONTOUR_LOCAL_MAX
} from './data/contours.js';
import { loadCartoStyle } from './carto-style.js';
import { applyTheme } from './theme.js';
import { wirePlayerControls } from './ui/player.js';
import { webcamsLayer } from './layers/webcams/index.js';
import { SITE_CONFIG } from './site-config.js';

// Data sources shown on the map. Each entry follows the layer shape documented in
// js/layers/webcams/index.js — add a new layer by adding its module here.
const LAYERS = [webcamsLayer];

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

function waitForStyleReady(callback){
  // 'style.load' fires once the swapped-in style (layers/sources/sprite) is ready to
  // accept addLayer calls. The previous 'styledata' listener never reliably re-fired
  // once tiles were still loading, so the contour border/mask never came back after
  // a theme toggle; 'idle' worked but only after full tile render, which left a
  // multi-second gap (and a stacked race) when the toggle was clicked twice quickly.
  map.once('style.load', callback);
}

function fitToContour(){
  map.fitBounds(computeContourBounds(), {padding:24, duration:0});
}

function pickContour(zoom){
  if(zoom < 6) return CONTOUR_LOCAL_VERY_LOW;
  if(zoom < 7) return CONTOUR_LOCAL_LOW;
  if(zoom < 8) return CONTOUR_LOCAL;
  if(zoom < 9) return CONTOUR_LOCAL_DETAIL;
  if(zoom < 10) return CONTOUR_LOCAL_VERY_FINE;
  if(zoom < 11) return CONTOUR_LOCAL_FINEST;
  return CONTOUR_LOCAL_MAX;
}

function updateContour(){
  const zoom = map.getZoom();
  const rings = pickContour(zoom);
  const geo = contourToGeoJSON(rings);
  if(map.getSource(maskSourceId)){
    map.getSource(maskSourceId).setData(geo.mask);
    map.getSource(outlineSourceId).setData(geo.outline);
  }
}

function addContourLayers(){
  // Remove any leftovers from a previous style (defensive, avoids "already exists" errors)
  [ 'contour-outline-layer','contour-mask-layer' ].forEach(id=>{ if(map.getLayer(id)) map.removeLayer(id); });
  [ maskSourceId, outlineSourceId ].forEach(id=>{ if(map.getSource(id)) map.removeSource(id); });

  const style0 = getComputedStyle(document.documentElement);
  const maskColor = style0.getPropertyValue('--mask').trim() || '#050d14';
  const maskOpacity = parseFloat(style0.getPropertyValue('--mask-opacity')) || 0.9;
  const geo = contourToGeoJSON(pickContour(map.getZoom()));

  // CARTO's actual *first* symbol layer overall is 'waterway_label' (river-name
  // labels), which sits far earlier than roads/buildings/boundaries — style layers
  // aren't cleanly split into "fills/lines first, then all labels"; labels are
  // interleaved throughout for cartographic z-ordering. So "before the first symbol
  // layer" is NOT a safe insertion point for anything meant to sit after all the
  // land-detail layers; it landed contour-outline-layer and comarques-outline-layer
  // far too early, letting the mask (correctly positioned late, see below) paint
  // right over them.
  //
  // carto-style.js instead deliberately positions 'water-sea' at the very end of the
  // non-label layers — after every road/rail/bridge/building/boundary line CARTO
  // draws, and right before the first *late* label layer ('watername_ocean'). Using
  // 'water-sea' as the shared reference point puts everything in the right place:
  // the mask goes immediately before it (ending up after all land-detail layers, so
  // they're dimmed outside the region), while the outline and comarques layers go
  // immediately after it (staying crisp, on top of both the mask and the sea, same as
  // before).
  const layers = map.getStyle().layers;
  const seaLayerIdx = layers.findIndex(l => l.id === 'water-sea');
  const seaLayer = seaLayerIdx >= 0 ? layers[seaLayerIdx] : null;
  const afterSeaLayer = seaLayerIdx >= 0 ? layers[seaLayerIdx + 1] : null;
  const maskBeforeId = seaLayer ? seaLayer.id : undefined;
  const beforeId = afterSeaLayer ? afterSeaLayer.id : maskBeforeId;

  map.addSource(maskSourceId, {type:'geojson', data: geo.mask});
  map.addLayer({id:'contour-mask-layer', type:'fill', source:maskSourceId, paint:{'fill-color':maskColor, 'fill-opacity':maskOpacity}}, maskBeforeId);
  map.addSource(outlineSourceId, {type:'geojson', data: geo.outline});
  map.addLayer({id:'contour-outline-layer', type:'line', source:outlineSourceId, paint:{'line-color':'#f2b705', 'line-width':1.4, 'line-opacity':0.6}}, beforeId);

  addComarquesLayer(beforeId);
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

const COMARQUES_MIN_ZOOM = 8;

function comarquesToGeoJSON(){
  const features = [];
  COMARQUES_DATA.forEach(c=>{
    c.r.forEach(ring=>{
      features.push({type:'Feature', properties:{name:c.n}, geometry:{type:'LineString', coordinates: ring.map(([lat,lng])=>[lng,lat])}});
    });
  });
  return {type:'FeatureCollection', features};
}

function addComarquesLayer(beforeId){
  if(map.getLayer('comarques-outline-layer')) map.removeLayer('comarques-outline-layer');
  if(map.getSource('comarques')) map.removeSource('comarques');
  map.addSource('comarques', {type:'geojson', data: comarquesToGeoJSON()});
  const style0 = getComputedStyle(document.documentElement);
  map.addLayer({
    id:'comarques-outline-layer', type:'line', source:'comarques',
    paint:{'line-color': style0.getPropertyValue('--sand').trim() || '#f1e4c8', 'line-width':0.8, 'line-opacity':0.45},
    layout:{'visibility': map.getZoom() >= COMARQUES_MIN_ZOOM ? 'visible' : 'none'}
  }, beforeId);
}

function updateComarquesVisibility(){
  if(!map.getLayer('comarques-outline-layer')) return;
  map.setLayoutProperty('comarques-outline-layer', 'visibility', map.getZoom() >= COMARQUES_MIN_ZOOM ? 'visible' : 'none');
}

function refreshContourColors(){
  if(!map || !map.getLayer('contour-mask-layer')) return;
  const style0 = getComputedStyle(document.documentElement);
  map.setPaintProperty('contour-mask-layer', 'fill-color', style0.getPropertyValue('--mask').trim());
  map.setPaintProperty('contour-mask-layer', 'fill-opacity', parseFloat(style0.getPropertyValue('--mask-opacity')));
  if(map.getLayer('comarques-outline-layer')){
    map.setPaintProperty('comarques-outline-layer', 'line-color', style0.getPropertyValue('--sand').trim());
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

function checkAllLayersAvailability(){
  LAYERS.forEach(layer=>{ if(layer.checkAvailability) layer.checkAvailability(); });
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

  map.on('load', ()=>{
    fitToContour();
    // Lock panning to whatever the fit above actually shows, rather than a guessed
    // fixed-degree margin: on a wide viewport, fitting the contour's height can need
    // several extra degrees of longitude to fill the width, so a small fixed margin
    // ends up tighter than the fit itself and clips part of the region on first load.
    // Deriving maxBounds from the real post-fit viewport can't be too tight this way,
    // for any window size/aspect ratio.
    map.setMaxBounds(map.getBounds());
    addContourLayers();
    addAllMarkers();
    checkAllLayersAvailability();
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
    // diff:false forces a full style teardown/reload. By default setStyle() diffs
    // against the current style once one exists (true for every toggle after the
    // first), which silently patches in place and never fires 'style.load' at all —
    // that's why the border vanished and the guard below never got released.
    map.setStyle(newStyle, {diff:false});
    waitForStyleReady(()=>{
      addContourLayers();
      refreshContourColors();
      themeSwitching = false;
    });
  });
  applyTheme(initialTheme);
}

initMap();
