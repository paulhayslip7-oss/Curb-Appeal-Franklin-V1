// Aerial imagery sources, shared by the estimator and the dashboards.
//
// Tennessee's own TDOT imagery is sharper (6-inch) and is used first; Esri
// World Imagery is the fallback outside Tennessee or if the state server is
// down. Both top out at zoom 19 around Franklin.
//
// NOTE for the owner: Esri's World Imagery is free to *display* with
// attribution, but check Esri's terms (an ArcGIS account / API key may be
// required for commercial use at volume). TDOT imagery is public data.

export const ZOOM = 19;

export const SOURCES = {
  tn: {
    url: 'https://tnmap.tn.gov/arcgis/rest/services/BASEMAPS/IMAGERY_WEB_MERCATOR/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery © TDOT Aerial Surveys',
  },
  esri: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
};

export const tileUrl = (source, z, x, y) => SOURCES[source].url.replace('{z}', z).replace('{y}', y).replace('{x}', x);

export function loadTile(source, z, x, y) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // needed to read pixels back from a canvas
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('tile failed'));
    img.src = tileUrl(source, z, x, y);
  });
}

/** Pick the best source that actually has imagery at this spot. */
export async function pickSource(lon, lat) {
  const n = 2 ** ZOOM;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  try {
    await loadTile('tn', ZOOM, x, y);
    return 'tn';
  } catch {
    return 'esri';
  }
}

/** A Leaflet aerial layer for a source. */
export const aerialLayer = (source) =>
  L.tileLayer(SOURCES[source].url, { maxNativeZoom: ZOOM, maxZoom: 21, attribution: SOURCES[source].attribution, crossOrigin: 'anonymous' });
