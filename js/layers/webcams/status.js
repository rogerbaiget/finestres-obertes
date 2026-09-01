import { WEBCAMS } from './data.js';

// --- Camera availability check (live, from the browser) ---
function markBroken(cam){
  cam._broken = true;
  const dot = cam._dotEl;
  if(dot){ dot.style.background = '#5a5a5a'; dot.style.boxShadow = 'none'; dot.style.opacity = '0.55'; }
}

function checkPhoto(cam){
  const img = new Image();
  img.onload = ()=>{};
  img.onerror = ()=> markBroken(cam);
  img.src = cam.img + (cam.img.includes('?') ? '&' : '?') + 'chk=' + Date.now();
}

function extractYoutubeId(src){
  const m = src.match(/embed\/([a-zA-Z0-9_-]{6,})/);
  return (m && m[1] !== 'videoseries') ? m[1] : null;
}

async function checkVideo(cam){
  const ytId = extractYoutubeId(cam.src);
  if(ytId){
    try{
      const res = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + ytId) + '&format=json');
      if(res.status === 404 || res.status === 401) markBroken(cam);
    }catch(e){ /* cannot be known for certain: not marked as broken */ }
    return;
  }
  if(cam.playlist) return;
  // Other sources (erdrag...): try to read the page's actual content.
  try{
    const res = await fetch(cam.src, {mode:'cors'});
    if(!res.ok){ markBroken(cam); return; }
    const text = await res.text();
    const hasContent = /<iframe[\s>]|<img[\s>]|<video[\s>]/i.test(text);
    if(!hasContent) markBroken(cam);
  }catch(e){ /* CORS blocked or network error: cannot be known for certain, not marked */ }
}

export function checkAvailability(){
  WEBCAMS.forEach(cam=>{
    if(cam.media==='photo') checkPhoto(cam);
    else checkVideo(cam);
  });
}
