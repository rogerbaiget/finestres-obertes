export const VIDEO_COLOR = '#c8102e';
export const PHOTO_COLOR = '#f2b705';
export const BROKEN_COLOR = '#5a5a5a';
export const MARKER_STROKE_COLOR = '#0a1f2e';

// What a camera marker looks like, as one ordered list of rules (first match wins)
// rather than defined once in plain JS for the legend and again as a MapLibre paint
// expression for the on-map circles — those two forms can't share code directly (a
// paint expression isn't executable JS), so instead each condition is named ('broken',
// 'video', 'video-live') and interpreted two ways below: matches()/pickValue() run it
// in plain JS, conditionExpr()/toCaseExpression() compile it into a MapLibre
// expression. Either interpreter can be extended with a new named condition without
// the design decisions themselves (what's broken, what's video) ever being repeated.
const CONDITIONS = {
  broken: cam => !!cam.broken,
  video: cam => cam.media === 'video',
  'video-live': cam => cam.media === 'video' && !cam.broken
};

function conditionExpr(when){
  if(when === 'broken') return ['get', 'broken'];
  if(when === 'video') return ['==', ['get', 'media'], 'video'];
  if(when === 'video-live') return ['all', ['==', ['get', 'media'], 'video'], ['!', ['get', 'broken']]];
  throw new Error(`unknown marker condition: ${when}`);
}

function pickValue(cam, rules, key){
  const rule = rules.find(r => r.when === undefined || CONDITIONS[r.when](cam));
  return rule[key];
}

// Builds a MapLibre `case` expression from the same rule list pickValue() reads —
// every rule but the last (the catch-all default, with no `when`) becomes a
// [condition, value] pair; transform optionally converts the JS-side value (e.g. a
// CSS pixel diameter) into whatever unit the paint property actually expects.
function toCaseExpression(rules, key, transform = v => v){
  const expr = ['case'];
  rules.forEach((rule, i)=>{
    const isDefault = i === rules.length - 1 && rule.when === undefined;
    if(isDefault) expr.push(transform(rule[key]));
    else expr.push(conditionExpr(rule.when), transform(rule[key]));
  });
  return expr;
}

const COLOR_RULES = [
  { when: 'broken', color: BROKEN_COLOR },
  { when: 'video', color: VIDEO_COLOR },
  { color: PHOTO_COLOR }
];
const DIAMETER_RULES = [
  { when: 'video', diameter: 15 },
  { diameter: 12 }
];
const OPACITY_RULES = [
  { when: 'broken', opacity: 0.55 },
  { opacity: 1 }
];

// The legend swatch (a DOM element) renders from this.
export function getCameraAppearance(cam){
  return {
    color: pickValue(cam, COLOR_RULES, 'color'),
    size: pickValue(cam, DIAMETER_RULES, 'diameter'),
    boxShadow: CONDITIONS['video-live'](cam) ? '0 0 0 3px rgba(200,16,46,0.3)' : '',
    opacity: pickValue(cam, OPACITY_RULES, 'opacity')
  };
}

// MapLibre circle layers for individual (unclustered) camera points, in draw order
// (first = bottom): a soft glow behind non-broken video cameras — approximating the
// legend swatch's CSS box-shadow, which circle paint properties can't express
// directly — then the real dot, with a dark stroke matching the site's ink color.
// circle-blur is a *global* fade from center to edge (at blur:1 only the centerpoint
// is full opacity), not an edge-only softening — a high blur (tried 0.9 first) fades
// the whole glow before it ever reaches the opaque dot sitting on top of its center,
// leaving nothing visible outside it. A low blur keeps the glow solid enough that the
// ring left showing past the dot's edge is still visible.
// Only the dot layer is marked `interactive`: the glow layer's filter only matches
// non-broken video cameras, so wiring clicks there too would miss every photo/broken
// camera entirely.
export function getCameraPointLayers(){
  return [
    {
      type: 'circle',
      extraFilter: conditionExpr('video-live'),
      paint: {
        'circle-radius': 12,
        'circle-color': VIDEO_COLOR,
        'circle-opacity': 0.5,
        'circle-blur': 0.15
      }
    },
    {
      type: 'circle',
      interactive: true,
      paint: {
        'circle-radius': toCaseExpression(DIAMETER_RULES, 'diameter', d => d / 2),
        'circle-color': toCaseExpression(COLOR_RULES, 'color'),
        'circle-opacity': toCaseExpression(OPACITY_RULES, 'opacity'),
        'circle-stroke-width': 2,
        'circle-stroke-color': MARKER_STROKE_COLOR,
        'circle-stroke-opacity': toCaseExpression(OPACITY_RULES, 'opacity')
      }
    }
  ];
}

// MapLibre layers for clusters — sandColor/inkColor are read from the current theme's
// CSS custom properties (the same --sand/--blue-dark already used for the
// comarques/Andorra-border lines elsewhere), so clusters stay legible in both themes.
// Only the circle layer is marked `interactive`: both it and the count-text symbol
// layer cover every cluster, so wiring both would just fire each click twice.
export function getCameraClusterLayers(sandColor, inkColor){
  return [
    {
      type: 'circle',
      interactive: true,
      paint: {
        'circle-radius': ['step', ['get','point_count'], 14, 10, 18, 30, 22],
        'circle-color': sandColor,
        'circle-stroke-width': 2,
        'circle-stroke-color': inkColor
      }
    },
    {
      type: 'symbol',
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-size': 12
      },
      paint: {
        'text-color': inkColor
      }
    }
  ];
}
