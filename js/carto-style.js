export async function loadCartoStyle(mode){
  const url = mode === 'light'
    ? 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
    : 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
  const res = await fetch(url);
  const style = await res.json();
  // Force every label to use the Catalan name field, falling back to the default name.
  // A few names are then overridden: OSM's official "Comunitat Valenciana" is replaced
  // with the more commonly used "País Valencià".
  const NAME_OVERRIDES = ['Comunitat Valenciana', 'Comunidad Valenciana', 'Comunitat Valenciana / Comunidad Valenciana'];
  style.layers.forEach(layer=>{
    if(layer.layout && layer.layout['text-field']){
      const base = ['coalesce', ['get','name:ca'], ['get','name']];
      layer.layout['text-field'] = ['case',
        ['in', base, ['literal', NAME_OVERRIDES]], 'País Valencià',
        base
      ];
    }
    // Region/state labels (e.g. "place_state") sometimes have a strict "rank" filter
    // in CARTO's style that can exclude a territory entirely, regardless of zoom.
    // Relax it so "País Valencià" (and similar) always gets a chance to render.
    if(layer.id === 'place_state'){
      layer.filter = ['all', ['==', 'class', 'state']];
      layer.minzoom = 0;
    }
  });
  return style;
}
