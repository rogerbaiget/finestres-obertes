import { showPlayer } from '../../ui/player.js';

export function openWebcamPlayer(cam){
  let mediaHtml;
  if(cam.broken || cam._broken){
    mediaHtml = `<div class="player-fallback">Aquesta font no està disponible ara mateix.</div>`;
  }else if(cam.media==='video'){
    mediaHtml = `<iframe src="${cam.src}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen loading="lazy"></iframe>`;
  }else{
    mediaHtml = `<img src="${cam.img}" alt="${cam.n}" onerror="this.parentElement.innerHTML='<div class=&quot;player-fallback&quot;>Imatge no disponible ara mateix</div>'">`;
  }
  showPlayer({
    mediaHtml,
    name: cam.n,
    loc: cam.loc,
    badgeText: cam._broken ? 'Possiblement no disponible' : (cam.media==='video' ? 'Vídeo en directe' : 'Última captura'),
    badgeClass: cam._broken ? 'broken' : cam.media
  });
}
