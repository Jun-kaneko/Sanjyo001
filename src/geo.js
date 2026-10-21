// 距離計算と住所検索。位置情報はこのブラウザ内でのみ処理する。

const EARTH_RADIUS_M = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;

/** 2点間の距離（m）。引数は [経度, 緯度]。 */
export function distanceM(a, b) {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function formatDistance(m) {
  return m < 1000 ? `約${Math.round(m / 10) * 10}m` : `約${(m / 1000).toFixed(1)}km`;
}

/** 方角（8方位）。a から b を見た向き。 */
export function bearingLabel(a, b) {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
    - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(deg / 45) % 8];
}

const ADDRESS_API = 'https://msearch.gsi.go.jp/address-search/AddressSearch';

/** 国土地理院 住所検索API。入力した住所文字列がそのまま GSI に送られる。 */
export async function geocode(query) {
  const res = await fetch(`${ADDRESS_API}?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.slice(0, 5).map((f) => ({
    title: f.properties.title,
    lonlat: f.geometry.coordinates,
  }));
}

// 点が多角形の内側にあるか（レイキャスティング法）。ring は [[経度, 緯度], ...]
function inRing(pt, ring) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** MultiPolygon（[[外周, 穴...], ...]）の内側にあるか。穴の中は外側として扱う。 */
export function pointInMultiPolygon(pt, polygons) {
  return polygons.some((poly) => inRing(pt, poly[0]) && !poly.slice(1).some((hole) => inRing(pt, hole)));
}
