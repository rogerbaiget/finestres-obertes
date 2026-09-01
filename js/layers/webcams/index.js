import { WEBCAMS } from './data.js';
import { createWebcamMarkerElement, getWebcamAppearance } from './marker.js';
import { openWebcamPlayer } from './player.js';
import { checkAvailability } from './status.js';

// A "layer" is a self-contained data source for the map: its items, how to draw a
// marker for one, what happens when that marker is clicked, an optional legend
// describing what its marker colors mean, and (optionally) how to check the items'
// live availability. map.js knows nothing about webcams specifically — it only knows
// this shape, so a future layer (e.g. weather stations, points of interest) is added
// the same way, in its own js/layers/<name>/ folder.
//
// The legend entries below render getWebcamAppearance() for a representative item of
// each media type, rather than restating color/size/glow as separate hardcoded data —
// so the legend can't drift from what markers actually look like as that styling
// evolves.
export const webcamsLayer = {
  id: 'webcams',
  items: WEBCAMS,
  createMarkerElement: createWebcamMarkerElement,
  onSelect: openWebcamPlayer,
  checkAvailability,
  legend: [
    { ...getWebcamAppearance({ media: 'video' }), label: 'Vídeo en directe' },
    { ...getWebcamAppearance({ media: 'photo' }), label: 'Última captura' }
  ]
};
