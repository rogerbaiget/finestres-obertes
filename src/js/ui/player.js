// Generic overlay for showing details about a selected map item. Layer-specific
// code (e.g. the cameras layer) builds the content and calls showPlayer() with it —
// this module knows nothing about cameras, photos, or video.
export function showPlayer({ mediaHtml, name, loc, badgeText, badgeClass }){
  document.getElementById('player-media').innerHTML = mediaHtml;
  document.getElementById('player-name').textContent = name;
  document.getElementById('player-loc').textContent = loc;
  const badge = document.getElementById('player-badge');
  badge.textContent = badgeText;
  badge.className = 'player-badge ' + badgeClass;
  document.getElementById('player').classList.add('open');
}

export function closePlayer(){
  document.getElementById('player').classList.remove('open');
  document.getElementById('player-media').innerHTML = '';
}

export function wirePlayerControls(){
  document.getElementById('player').addEventListener('click', (e)=>{
    if(e.target === e.currentTarget) closePlayer();
  });
  document.querySelector('.player-close').addEventListener('click', closePlayer);
}
