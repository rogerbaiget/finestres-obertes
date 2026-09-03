import { CONTOUR_LOCAL_VERY_LOW } from './data/contours.js';

// Coarsest contour tier, reshaped into a MultiPolygon for the "inside the Catalan
// Countries" test below. Precision doesn't matter much here (a few km of slack near a
// border is fine), and a small polygon keeps the per-feature 'within' check cheap.
const CONTOUR_MASK_GEOMETRY = {
  type: 'MultiPolygon',
  coordinates: CONTOUR_LOCAL_VERY_LOW.map(ring => [ring.map(([lat,lng])=>[lng,lat])])
};

// OSM's official name for the Valencian Community; used both to relabel it "País
// Valencià" and (in restrictToContour below) to exempt it from the contour check by
// name rather than disabling that check for every region label.
const VALENCIA_NAME_OVERRIDES = ['Comunitat Valenciana', 'Comunidad Valenciana', 'Comunitat Valenciana / Comunidad Valenciana'];

// CARTO's own place_state color is a desaturated blue-gray that reads as an imported
// hue against this site's warm sand/ink palette. Using the site's own ink color
// instead (styles.css's --white — near-black on light, near-cream on dark) at reduced
// opacity ties the labels to the rest of the page instead of CARTO's default, and
// still reads as secondary/background text rather than competing with foreground UI.
export const REGION_LABEL_COLOR = { light: 'rgba(28,21,13,0.7)', dark: 'rgba(251,247,238,0.7)' };

// A thin, translucent halo/stroke so region labels stay legible over the (blue-ish)
// sea fill, not just land. Opposite polarity from the text itself (white behind dark
// ink on light theme, black behind light ink on dark theme) rather than matching
// either theme's ink — same color for both would make the stroke invisible against
// its own text — kept translucent and thin so it reads as a soft edge, not a sticker
// outline.
export const REGION_LABEL_HALO = { light: 'rgba(255,255,255,0.55)', dark: 'rgba(0,0,0,0.55)' };

// One shared layout for every region/country-level label (Catalunya, País Valencià,
// Andorra via place_state/place_country_1/place_country_2 below, plus Illes Balears
// and l'Alguer's own custom layers in map.js) — exported so map.js can reuse it
// verbatim instead of duplicating values that could drift out of sync. Needed because
// CARTO's place_country_1/place_country_2 ship their OWN, smaller text-size stops
// (e.g. 12 at zoom 6) than place_state's (14 at zoom 6) — without overriding it,
// Andorra's label renders visibly smaller than Catalunya's/País Valencià's, confirmed
// directly against both of CARTO's style.jsons.
export const REGION_LABEL_LAYOUT = {
  'text-font': ['Montserrat Medium', 'Open Sans Bold', 'Noto Sans Regular', 'HanWangHeiLight Regular', 'NanumBarunGothic Regular'],
  'text-size': ['interpolate', ['linear'], ['zoom'], 5, 12, 7, 14],
  'text-transform': 'uppercase',
  'text-max-width': 9,
  // Region/country-level labels are the most important text on the map and few enough
  // to never meaningfully clutter it, so they always render even if MapLibre's
  // collision detection would otherwise suppress them — confirmed directly (via
  // showCollisionBoxes) that "PAÍS VALENCIÀ" was losing a collision fight against a
  // nearby camera cluster's count label. allow-overlap keeps it visible regardless of
  // what's nearby; ignore-placement stops it from then blocking whatever comes next.
  'text-allow-overlap': true,
  'text-ignore-placement': true
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
//
// "Comunitat Valenciana" is exempted by name (place_state only): its OSM label point
// (-0.76, 39.68) falls in the region's non-Catalan-speaking interior, outside our
// contour, so the 'within' check silently dropped "PAÍS VALENCIÀ" entirely — a
// region's single anchor point can legitimately sit outside our contour even when
// most of the region is inside it. Exempted by name rather than skipping the check
// for place_state entirely, so neighbouring regions genuinely outside the Catalan
// Countries (Aragón, Navarra, ...) stay correctly hidden — confirmed directly: a
// blanket skip let those back in and, worse, put them in collision with "PAÍS
// VALENCIÀ" for the same label space, hiding it just as before but for a new reason.
function restrictToContour(layer){
  if(!layer.source || !(layer.layout && layer.layout['text-field'])) return;
  const nameExpr = ['coalesce', ['get','name:ca'], ['get','name']];
  const withinExpr = layer.id === 'place_state'
    ? ['any', ['within', CONTOUR_MASK_GEOMETRY], ['in', nameExpr, ['literal', VALENCIA_NAME_OVERRIDES]]]
    : ['within', CONTOUR_MASK_GEOMETRY];
  layer.filter = layer.filter
    ? ['all', toExpressionFilter(layer.filter), withinExpr]
    : withinExpr;
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

// CARTO's full positron/dark-matter styles ship every layer a general-purpose basemap
// needs, most of it irrelevant to a small camera-location map: building footprints,
// house numbers, CARTO's own POI icons (we have our own markers for that), airport
// runways/taxiways, and — the largest single chunk — a separate line layer for every
// combination of road class × tunnel/bridge/surface × case/fill styling. Even where a
// removed layer's minzoom never matches this site's actual usage range, MapLibre still
// pays a one-time setup cost per layer at style-load time (paint/layout expression
// compilation) for every layer in the style regardless of whether anything ever
// renders from it — confirmed directly, via queryRenderedFeatures() at the real
// overview zoom, that only 20 of the base style's 93 layers ever render a single
// feature there. Kept: state/comarca boundaries, major roads (secondary and up,
// including their own tunnels/bridges) for orientation, and every place/water-name
// label — including ones below town level, since those only become relevant once
// someone zooms into a specific area, which happens.
const UNUSED_LAYER_IDS = [
  // Not relevant to a camera-location map at any zoom: our own markers are the POIs.
  'building', 'building-top', 'housenumber', 'poi_stadium', 'poi_park',
  'aeroway-runway', 'aeroway-taxiway',
  // Fine road detail (service/minor/path/rail) that only ever shows deep zoomed in,
  // and isn't useful there either — secondary/primary/trunk/motorway (and their own
  // tunnels/bridges) stay untouched for orientation at every zoom this site reaches.
  'tunnel_service_case', 'tunnel_minor_case', 'tunnel_path', 'tunnel_service_fill', 'tunnel_minor_fill',
  'tunnel_rail', 'tunnel_rail_dash',
  'road_service_case', 'road_minor_case', 'road_path', 'road_service_fill', 'road_minor_fill',
  'bridge_service_case', 'bridge_minor_case', 'bridge_path', 'bridge_service_fill', 'bridge_minor_fill',
  'rail', 'rail_dash'
];
function removeUnusedLayers(style){
  style.layers = style.layers.filter(l => !UNUSED_LAYER_IDS.includes(l.id));
}

export async function loadCartoStyle(mode){
  const url = mode === 'light'
    ? 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
    : 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
  const res = await fetch(url);
  const style = await res.json();
  moveLayerBefore(style, 'place_state', 'place_hamlet');
  removeCountryBorders(style);
  removeUnusedLayers(style);
  splitSeaFromInlandWater(style);
  showOnlyRivers(style);
  increaseWaterContrast(style, mode);
  // Force every label to use the Catalan name field, falling back to the default name.
  // A few names are then overridden: OSM's official "Comunitat Valenciana" is replaced
  // with the more commonly used "País Valencià".
  style.layers.forEach(layer=>{
    if(layer.layout && layer.layout['text-field']){
      const base = ['coalesce', ['get','name:ca'], ['get','name']];
      layer.layout['text-field'] = ['case',
        ['in', base, ['literal', VALENCIA_NAME_OVERRIDES]], 'País Valencià',
        base
      ];
      // l'Alguer is drawn as our own big region-style label instead (see
      // addRegionLabels() in map.js), matching Illes Balears/Catalunya/País
      // Valencià, rather than fading in as a small town dot at some zoom threshold
      // — which would just duplicate it. Excluded from every CARTO label layer
      // rather than picking one "handoff" zoom: confirmed directly that more than
      // one layer can show a town name (place_town at minzoom 8, but also
      // place_city_dot_z7 — a catch-all for anything not country/state — from
      // minzoom 7), so a single cutoff still left a stretch showing both.
      if(layer.id !== 'place_state'){
        const excludeAlguer = ['!', ['==', base, "l'Alguer"]];
        layer.filter = layer.filter ? ['all', layer.filter, excludeAlguer] : excludeAlguer;
      }
    }
    // Region/state labels (e.g. "place_state") sometimes have a strict "rank" filter
    // in CARTO's style that can exclude a territory entirely, regardless of zoom.
    // Relax it so "País Valencià" (and similar) always gets a chance to render.
    if(layer.id === 'place_state'){
      layer.filter = ['==', ['get','class'], 'state'];
    }
    // Catalunya/País Valencià (place_state) and Andorra (place_country_1 or _2,
    // depending on its rank — not place_state, since it's a country not a region) ship
    // with different layout AND paint in CARTO's own style (different text-size
    // stops, different color/halo) — overridden here, identically for all three, so
    // the three read as one consistent set rather than Andorra looking like a smaller,
    // differently-colored afterthought. minzoom/maxzoom is likewise unified to
    // place_state's own range rather than place_country_1's narrower one (which would
    // otherwise make Andorra's label vanish above zoom 7).
    if(layer.id === 'place_state' || layer.id === 'place_country_1' || layer.id === 'place_country_2'){
      layer.minzoom = 0;
      layer.maxzoom = 10;
      layer.layout = { ...layer.layout, ...REGION_LABEL_LAYOUT };
      layer.paint['text-color'] = REGION_LABEL_COLOR[mode];
      layer.paint['text-halo-color'] = REGION_LABEL_HALO[mode];
      layer.paint['text-halo-width'] = 0.8;
    }
  });
  style.layers.forEach(restrictToContour);
  return style;
}
