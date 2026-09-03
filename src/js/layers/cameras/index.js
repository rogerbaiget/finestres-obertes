import { getCameraAppearance, getCameraPointLayers, getCameraClusterLayers } from './marker.js';
import { openCameraPlayer } from './player.js';
import { loadCameras } from './load.js';

// A "layer" is a self-contained data source for the map: its items (populated by an
// optional async load(), for a layer whose data doesn't ship with the site — see
// load.js), how to turn an item into a GeoJSON Feature (toFeature), clustering
// options, the MapLibre circle/symbol layers to draw for individual points and for
// clusters (buildPointLayers/buildClusterLayers), how to recover an item from a
// clicked feature (fromFeature), what happens when one is selected (onSelect), and
// an optional legend describing what its marker colors mean. map.js knows nothing
// about cameras specifically — it only knows this shape, so a future layer (e.g.
// weather stations, points of interest) is added the same way, in its own
// js/layers/<name>/ folder.
//
// Rendered as a native MapLibre clustered GeoJSON source (GPU circle/symbol layers)
// rather than individual DOM markers: far cheaper to draw at scale, at the cost of
// losing per-marker keyboard/screen-reader access, since a canvas-drawn circle has no
// DOM element of its own to attach that to.
//
// The legend entries below render getCameraAppearance() for a representative item of
// each media type, rather than restating color/size/glow as separate hardcoded data —
// so the legend can't drift from what markers actually look like as that styling
// evolves.
export const camerasLayer = {
  id: 'cameras',
  items: [],
  async load(){
    this.items = await loadCameras();
  },
  toFeature: cam => ({ type: 'Feature', properties: cam, geometry: { type: 'Point', coordinates: [cam.lng, cam.lat] } }),
  cluster: { radius: 50, maxZoom: 14 },
  buildPointLayers: getCameraPointLayers,
  buildClusterLayers: getCameraClusterLayers,
  fromFeature: f => f.properties,
  onSelect: openCameraPlayer,
  legend: [
    { ...getCameraAppearance({ media: 'video' }), label: 'Vídeo en directe' },
    { ...getCameraAppearance({ media: 'photo' }), label: 'Última captura' }
  ]
};
