// --- Dark / light mode ---
export function applyTheme(mode){
  document.documentElement.classList.toggle('light', mode==='light');
  document.getElementById('icon-moon').style.display = mode==='light' ? 'none' : '';
  document.getElementById('icon-sun').style.display = mode==='light' ? '' : 'none';
  localStorage.setItem('theme', mode);
  // The map style swap and contour recolor for MapLibre are handled separately,
  // in initMap()'s theme-toggle click listener (needs async style fetch + setStyle).
}
