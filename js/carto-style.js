import { CONTOUR_LOCAL_VERY_LOW } from './data/contours.js';

// Coarsest contour tier, reshaped into a MultiPolygon for the "inside the Catalan
// Countries" test below. Precision doesn't matter much here (a few km of slack near a
// border is fine), and a small polygon keeps the per-feature 'within' check cheap.
const CONTOUR_MASK_GEOMETRY = {
  type: 'MultiPolygon',
  coordinates: CONTOUR_LOCAL_VERY_LOW.map(ring => [ring.map(([lat,lng])=>[lng,lat])])
};

function propertyExpression(key){
  // "$type"/"$id" are legacy-filter pseudo-properties, not real feature properties —
  // ["get","$type"] would just return undefined, silently breaking the filter.
  if(key === '$type') return ['geometry-type'];
  if(key === '$id') return ['id'];
  return ['get', key];
}

// CARTO's style ships every filter in the old legacy shorthand (e.g.
// ["==","class","river"]), not as expressions. Combining that directly with an
// expression-only operator like 'within' via ['all', legacyFilter, ['within',...]]
// produces a filter MapLibre can't validate — and since style loading validates the
// whole style up front, one bad filter like that fails the ENTIRE style (nothing
// renders at all), not just that one layer. So every existing filter is converted to
// an equivalent expression first.
function toExpressionFilter(filter){
  if(!Array.isArray(filter)) return filter;
  const [op, ...args] = filter;
  // A bare string key (e.g. "class") is legacy shorthand and needs wrapping into a
  // real expression; an array (e.g. ["get","class"]) is already one — wrapping that
  // again produces ["get",["get","class"]], which looks up a property NAMED "class"'s
  // value ("state") as if IT were a property name, silently breaking the filter. This
  // comes up whenever this function runs on a filter some earlier step already
  // converted (e.g. the place_state override below), so it must be idempotent.
  const key = typeof args[0] === 'string' ? propertyExpression(args[0]) : args[0];
  switch(op){
    case 'all': case 'any':
      return [op, ...args.map(toExpressionFilter)];
    case '==': case '!=': case '<': case '<=': case '>': case '>=':
      return [op, key, args[1]];
    case 'has':
      return ['has', args[0]];
    case '!has':
      return ['!', ['has', args[0]]];
    case 'in':
      return ['in', key, ['literal', args.slice(1)]];
    case '!in':
      return ['!', ['in', key, ['literal', args.slice(1)]]];
    default:
      return filter; // already expression syntax (uses "get" etc.) — leave as-is
  }
}

// Outside the Catalan Countries, labels should not show through the mask — fill/line
// layers (roads, buildings, water, landuse) don't need this: they're already drawn
// *below* the contour mask, so the mask already fully hides them there. Labels render
// *above* the mask (so text stays crisp over it), so they need their own filter.
// This is deliberately NOT applied to every layer: MapLibre's 'within' expression
// reprojects the whole contour polygon per evaluated feature with no caching, so
// applying it to fill/line layers too (which have vastly more features than labels)
// made every tile load extremely slow — occasionally hanging the page outright.
function restrictToContour(layer){
  if(!layer.source || !(layer.layout && layer.layout['text-field'])) return;
  layer.filter = layer.filter
    ? ['all', toExpressionFilter(layer.filter), ['within', CONTOUR_MASK_GEOMETRY]]
    : ['within', CONTOUR_MASK_GEOMETRY];
}

// MapLibre places symbol labels in layer order and won't let a later layer's label
// overlap space an earlier one already claimed. CARTO's style lists place_hamlet/
// place_suburbs/place_villages/place_town — small, numerous local labels — before
// place_state, so by the time "CATALUNYA" or "PAÍS VALENCIÀ" (big, multi-word) gets
// its turn, nearby town labels have often already filled the space it would need.
// Moving it earlier lets it claim its space first.
function moveLayerBefore(style, layerId, beforeLayerId){
  const idx = style.layers.findIndex(l => l.id === layerId);
  const beforeIdx = style.layers.findIndex(l => l.id === beforeLayerId);
  if(idx === -1 || beforeIdx === -1) return;
  const [layer] = style.layers.splice(idx, 1);
  style.layers.splice(style.layers.findIndex(l => l.id === beforeLayerId), 0, layer);
}

// CARTO's single 'water' layer covers ocean, sea, lake, pond, and river polygons alike
// with no class-based distinction. Splitting it lets the mask (inserted later, in
// map.js) sit between the two: inland water (lake/river) stays dimmed outside the
// region like any other foreign feature, while ocean/sea — placed back on top of the
// mask — doesn't get a visible haze painted over open water. Ponds are dropped
// entirely: only rivers and lakes are meant to show.
function splitSeaFromInlandWater(style){
  const idx = style.layers.findIndex(l => l.id === 'water');
  if(idx === -1) return;
  const original = style.layers[idx];
  const baseFilter = toExpressionFilter(original.filter);
  const isSea = ['in', ['get','class'], ['literal', ['ocean','sea']]];
  // Pools/fountains (OpenMapTiles buckets ornamental fountains under 'swimming_pool')
  // aren't rivers or lakes either.
  const isExcluded = ['in', ['get','class'], ['literal', ['pond','swimming_pool']]];
  const inlandLayer = { ...original, id: 'water-inland', filter: ['all', baseFilter, ['!', isSea], ['!', isExcluded]] };
  const seaLayer = { ...original, id: 'water-sea', filter: ['all', baseFilter, isSea] };
  style.layers.splice(idx, 1, inlandLayer, seaLayer);

  // 'water-sea' also needs to sit at the very end of the non-label layers (just
  // before the first symbol layer), not where the original 'water' layer was. CARTO's
  // roads, railways, bridges, buildings, and country-border lines all render *after*
  // that original position — if 'water-sea' (and the mask, inserted just before it in
  // map.js) stayed there too, every one of those layers would render on top of the
  // mask outside the region, undimmed. Moving 'water-sea' to the end means the mask
  // ends up after all of them (dimming them, as intended) and still just before
  // 'water-sea' (keeping the sea itself undimmed).
  moveLayerBefore(style, 'water-sea', 'watername_ocean');
}

// Only rivers should show as waterway lines — CARTO's 'waterway' layer otherwise
// includes every OpenMapTiles waterway class (stream, canal, drain, ditch), i.e.
// creeks and similar minor watercourses.
function showOnlyRivers(style){
  const waterway = style.layers.find(l => l.id === 'waterway');
  if(waterway) waterway.filter = ['==', ['get','class'], 'river'];
}

// CARTO's default water color sits too close in luminance to the land/background
// color to read clearly at a glance (contrast ratio ~1.35-1.55, both near the
// respective background tone) — a more distinctly blue tone separates sea from land
// without departing far from each theme's palette.
function increaseWaterContrast(style, mode){
  const waterColor = mode === 'light' ? '#7bafd4' : '#446073';
  style.layers.forEach(layer=>{
    if(layer.id === 'water-inland' || layer.id === 'water-sea') layer.paint['fill-color'] = waterColor;
    if(layer.id === 'waterway') layer.paint['line-color'] = waterColor;
    // The ocean/sea label halo is meant to blend into the water fill behind it —
    // only relevant in light mode, where it explicitly matched the old water color;
    // dark mode's halo is a translucent black, unrelated to the water hex.
    if(mode === 'light' && (layer.id === 'watername_ocean' || layer.id === 'watername_sea')){
      layer.paint['text-halo-color'] = waterColor;
    }
  });
}

// International borders (admin_level 2) aren't wanted on a map centered on a
// linguistic/cultural region that itself straddles the Spain/France/Italy border —
// drawing them would visually contradict the whole point of the contour outline.
// Region (admin_level 4) and county/comarca (admin_level 6) boundaries are untouched.
// (The Andorra/Catalonia border is drawn separately, as its own static line layer in
// map.js, restyled to look internal — see addAndorraCataloniaBorderLayer there. It
// can't be recovered from these layers via a style filter: MapLibre's 'within' only
// matches a feature whose ENTIRE geometry sits inside the given polygon, and CARTO's
// per-tile boundary lines run the whole way around Andorra — both the Catalonia and
// France sides at once — so no such filter ever matched anything.)
const COUNTRY_BORDER_LAYER_IDS = ['boundary_country_outline', 'boundary_country_inner'];
function removeCountryBorders(style){
  style.layers = style.layers.filter(l => !COUNTRY_BORDER_LAYER_IDS.includes(l.id));
}

export async function loadCartoStyle(mode){
  const url = mode === 'light'
    ? 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
    : 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
  const res = await fetch(url);
  const style = await res.json();
  moveLayerBefore(style, 'place_state', 'place_hamlet');
  removeCountryBorders(style);
  splitSeaFromInlandWater(style);
  showOnlyRivers(style);
  increaseWaterContrast(style, mode);
  // Force every label to use the Catalan name field, falling back to the default name.
  // A few names are then overridden: OSM's official "Comunitat Valenciana" is replaced
  // with the more commonly used "País Valencià".
  const NAME_OVERRIDES = ['Comunitat Valenciana', 'Comunidad Valenciana', 'Comunitat Valenciana / Comunidad Valenciana'];
  style.layers.forEach(layer=>{
    if(layer.layout && layer.layout['text-field']){
      const base = ['coalesce', ['get','name:ca'], ['get','name']];
      layer.layout['text-field'] = ['case',
        ['in', base, ['literal', NAME_OVERRIDES]], 'País Valencià',
        base
      ];
    }
    // Region/state labels (e.g. "place_state") sometimes have a strict "rank" filter
    // in CARTO's style that can exclude a territory entirely, regardless of zoom.
    // Relax it so "País Valencià" (and similar) always gets a chance to render.
    if(layer.id === 'place_state'){
      layer.filter = ['==', ['get','class'], 'state'];
      layer.minzoom = 0;
    }
  });
  style.layers.forEach(restrictToContour);
  return style;
}
