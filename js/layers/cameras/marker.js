export const VIDEO_COLOR = '#c8102e';
export const PHOTO_COLOR = '#f2b705';
export const BROKEN_COLOR = '#5a5a5a';
export const VIDEO_GLOW = '0 0 0 3px rgba(200,16,46,0.3)';

// Single source of truth for what a camera dot looks like — both the real map marker
// and the legend swatch render from this, so a future styling change (a new media
// type, a different broken/glow treatment) can't drift between the two.
export function getCameraAppearance(cam){
  return {
    color: cam.broken ? BROKEN_COLOR : (cam.media==='video' ? VIDEO_COLOR : PHOTO_COLOR),
    size: cam.media==='video' ? 15 : 12,
    boxShadow: (cam.media==='video' && !cam.broken) ? VIDEO_GLOW : '',
    opacity: cam.broken ? 0.55 : 1
  };
}

export function createCameraMarkerElement(cam){
  const { color, size, boxShadow, opacity } = getCameraAppearance(cam);
  const hit = 34; // invisible touch target, bigger than the visible dot
  const wrap = document.createElement('div');
  wrap.style.cssText = `width:${hit}px;height:${hit}px;display:flex;align-items:center;justify-content:center;cursor:pointer;`;
  const dot = document.createElement('div');
  dot.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #0a1f2e;pointer-events:none;${boxShadow?`box-shadow:${boxShadow};`:''}${opacity<1?`opacity:${opacity};`:''}`;
  wrap.appendChild(dot);
  return wrap;
}
