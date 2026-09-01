export function createWebcamMarkerElement(cam){
  const color = cam.broken ? '#5a5a5a' : (cam.media==='video' ? '#c8102e' : '#f2b705');
  const size = cam.media==='video' ? 15 : 12;
  const hit = 34; // invisible touch target, bigger than the visible dot
  const wrap = document.createElement('div');
  wrap.style.cssText = `width:${hit}px;height:${hit}px;display:flex;align-items:center;justify-content:center;cursor:pointer;`;
  const dot = document.createElement('div');
  dot.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #0a1f2e;pointer-events:none;${(cam.media==='video' && !cam.broken)?'box-shadow:0 0 0 3px rgba(200,16,46,0.3);':''}${cam.broken?'opacity:0.55;':''}`;
  wrap.appendChild(dot);
  cam._dotEl = dot;
  if(cam.broken) cam._broken = true;
  return wrap;
}
