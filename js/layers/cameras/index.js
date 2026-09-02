import { createCameraMarkerElement, getCameraAppearance } from './marker.js';
import { openCameraPlayer } from './player.js';
import { loadCameras } from './load.js';

// A "layer" is a self-contained data source for the map: its items (populated by an
// optional async load(), for a layer whose data doesn't ship with the site — see
// load.js), how to draw a marker for one, what happens when that marker is clicked,
// and an optional legend describing what its marker colors mean. map.js knows
// nothing about cameras specifically — it only knows this shape, so a future layer
// (e.g. weather stations, points of interest) is added the same way, in its own
// js/layers/<name>/ folder.
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
  createMarkerElement: createCameraMarkerElement,
  onSelect: openCameraPlayer,
  legend: [
    { ...getCameraAppearance({ media: 'video' }), label: 'Vídeo en directe' },
    { ...getCameraAppearance({ media: 'photo' }), label: 'Última captura' }
  ]
};
