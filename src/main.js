import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { LAYERS, HAZARDS, OFFICIAL_HAZARD_URL, DISTRICT_MODES, DISTRICT_COLORS, HUGCA_INFO_URL, QUICK_PLACES, GOMI_ENABLED } from './layers.js';
import { initGomi } from './gomi.js';
import { iconImageData, iconDataUrl } from './icons.js';
import { distanceM, formatDistance, bearingLabel, geocode, pointInMultiPolygon } from './geo.js';

const CITY_HALL = [138.961526, 37.636361]; // 三条市役所（初期表示）
const $ = (id) => document.getElementById(id);

const state = {
  features: {}, // layerId -> Feature[]
  visible: Object.fromEntries(LAYERS.map((l) => [l.id, l.on])),
  pin: null, // [lon, lat]
  marker: null,
  bearFrom: '',
  bearTo: '',
  popup: null,
  manifest: {},
  districts: null, // 行政区別人口の FeatureCollection
  districtMode: 'off',
};

const layerById = Object.fromEntries(LAYERS.map((l) => [l.id, l]));

// ---------- 地図 ----------
const map = new maplibregl.Map({
  container: 'map',
  center: CITY_HALL,
  zoom: 13,
  minZoom: 8,
  maxZoom: 18,
  attributionControl: { compact: true },
  style: {
    version: 8,
    sources: {
      gsi: {
        type: 'raster',
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png'],
        tileSize: 256,
        minzoom: 5,
        maxzoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル</a>（国土地理院）',
      },
    },
    layers: [{ id: 'gsi', type: 'raster', source: 'gsi' }],
  },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

function bearFilter() {
  const f = ['all'];
  if (state.bearFrom) f.push(['>=', ['get', 'date'], state.bearFrom]);
  if (state.bearTo) f.push(['<=', ['get', 'date'], state.bearTo]);
  return f.length > 1 ? f : null;
}

function addHazardLayers() {
  HAZARDS.forEach((h) => {
    map.addSource(`hz-${h.id}`, {
      type: 'raster', tiles: [h.url], tileSize: 256, minzoom: 2, maxzoom: 17,
      attribution: '<a href="https://disaportal.gsi.go.jp/" target="_blank" rel="noopener noreferrer">ハザードマップポータルサイト</a>（国土地理院）',
    });
    map.addLayer({
      id: `hz-${h.id}`, type: 'raster', source: `hz-${h.id}`,
      paint: { 'raster-opacity': 0.6 },
      layout: { visibility: h.on ? 'visible' : 'none' },
    });
  });
}

async function loadData() {
  const get = (name) => fetch(`data/${name}`).then((r) => {
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.json();
  });
  state.manifest = await get('manifest.json');
  const [collections, districts] = await Promise.all([
    Promise.all(LAYERS.map((l) => get(`${l.id}.geojson`))),
    get('districts.geojson'),
  ]);
  // 区域の塗り分け（点アイコンより下に描く）
  state.districts = districts;
  map.addSource('districts', { type: 'geojson', data: districts });
  map.addLayer({ id: 'districts-fill', type: 'fill', source: 'districts',
    paint: { 'fill-color': DISTRICT_COLORS[2], 'fill-opacity': 0.55 }, layout: { visibility: 'none' } });
  map.addLayer({ id: 'districts-line', type: 'line', source: 'districts',
    paint: { 'line-color': '#1f3a5f', 'line-width': 0.8, 'line-opacity': 0.6 }, layout: { visibility: 'none' } });
  // 点の多いレイヤー（消火栓など）を先に追加して、他のアイコンの下に描く
  const order = LAYERS.map((l, i) => ({ l, fc: collections[i] }))
    .sort((a, b) => Number(Boolean(b.l.minzoom)) - Number(Boolean(a.l.minzoom)));
  order.forEach(({ l, fc }) => {
    state.features[l.id] = fc.features;
    const k = l.minzoom ? 0.65 : 1; // 密集するレイヤーは小さめに
    map.addSource(`pt-${l.id}`, { type: 'geojson', data: fc });
    map.addLayer({
      id: `pt-${l.id}`, type: 'symbol', source: `pt-${l.id}`,
      ...(l.minzoom ? { minzoom: l.minzoom } : {}),
      filter: l.id === 'bear' ? bearFilter() ?? true : true,
      layout: {
        'icon-image': `icon-${l.id}`,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.7 * k, 13, 1.0 * k, 16, 1.25 * k],
        'icon-allow-overlap': true,
        visibility: state.visible[l.id] ? 'visible' : 'none',
      },
    });
  });
}

function setLayerVisible(id, on) {
  state.visible[id] = on;
  if (map.getLayer(`pt-${id}`)) map.setLayoutProperty(`pt-${id}`, 'visibility', on ? 'visible' : 'none');
  renderNearby();
}

// ---------- 地区別の人口（塗り分け） ----------
const numFmt = new Intl.NumberFormat('ja-JP');

function niceRound(v) {
  if (v < 10) return Math.round(v * 10) / 10;
  const k = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(v / k) * k;
}

function districtBreaks(prop) {
  const vals = state.districts.features
    .map((f) => f.properties[prop]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const raw = [0.2, 0.4, 0.6, 0.8].map((q) => niceRound(vals[Math.floor(q * vals.length)]));
  return raw.filter((v, i) => i === 0 || v > raw[i - 1]);
}

function applyDistrictMode(id) {
  state.districtMode = id;
  const mode = DISTRICT_MODES.find((m) => m.id === id);
  const legend = $('map-legend');
  const on = Boolean(mode.prop);
  ['districts-fill', 'districts-line'].forEach((l) => map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none'));
  if (!on) { legend.hidden = true; return; }
  const breaks = districtBreaks(mode.prop);
  const expr = ['step', ['coalesce', ['get', mode.prop], 0], DISTRICT_COLORS[0]];
  breaks.forEach((b, i) => expr.push(b, DISTRICT_COLORS[i + 1]));
  map.setPaintProperty('districts-fill', 'fill-color', expr);
  const fmt = (v) => numFmt.format(v);
  const labels = [`${fmt(breaks[0])} 未満`,
    ...breaks.slice(1).map((b, i) => `${fmt(breaks[i])} 〜 ${fmt(b)} 未満`),
    `${fmt(breaks[breaks.length - 1])} 以上`];
  legend.replaceChildren(
    el('h3', {}, `${mode.label}（${mode.unit}）`),
    ...labels.map((t, i) => el('div', { class: 'legend-row' },
      el('span', { class: 'legend-swatch', style: `background:${DISTRICT_COLORS[i]}` }), t)),
    el('div', { class: 'legend-row' }, '区域は令和2年国勢調査'));
  legend.hidden = false;
}

function buildDistrictControls() {
  const box = $('district-modes');
  DISTRICT_MODES.forEach((m) => {
    const input = el('input', { type: 'radio', name: 'district-mode', value: m.id });
    input.checked = m.id === 'off';
    input.addEventListener('change', () => applyDistrictMode(m.id));
    box.append(el('label', {}, input, m.label));
  });
  const m = state.manifest.districts;
  $('district-note').textContent = m
    ? `行政区のうち ${m.count} 地区（人口の ${Math.round((m.population / m.populationAll) * 100)}%）を、令和2年国勢調査の区域に重ねて表示します。`
      + `人口は ${m.fetchedAt || ''} 取得の三条市データです。区域の変更や表記の違いで対応できない地区、新興住宅地などは正確に表せない場合があります。人口密度は区域の面積（水面等を含む）で計算しています。`
    : '';
}

function districtPopupContent(p) {
  const root = el('div', { class: 'popup' });
  root.append(el('p', { class: 'popup-cat' }, '行政区（地区別人口）'));
  root.append(el('h3', { class: 'popup-title' }, p.name));
  const rows = [
    ['人口', `${numFmt.format(p.population)} 人（男 ${numFmt.format(p.male)}・女 ${numFmt.format(p.female)}）`],
    ['世帯数', `${numFmt.format(p.households)} 世帯`],
  ];
  if (p.hh_size) rows.push(['1世帯あたり', `${p.hh_size} 人`]);
  if (p.density != null) rows.push(['人口密度', `${numFmt.format(p.density)} 人/km²（区域 ${p.area_km2} km²）`]);
  const dl = el('dl', { class: 'popup-dl' });
  rows.forEach(([k, v]) => dl.append(el('dt', {}, k), el('dd', {}, v)));
  root.append(dl);
  if (p.matched_as) {
    root.append(el('p', { class: 'popup-warn' }, `「${p.matched_as}」の区域に対応させています（名称が異なるため推定）。`));
  }
  root.append(el('p', { class: 'popup-warn' }, '区域は令和2年国勢調査、人口は三条市の行政区別データです。時点や区域が一致しない場合があります。'));
  return root;
}

// ---------- ポップアップ ----------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  });
  children.flat().forEach((c) => node.append(c));
  return node;
}

function popupContent(layerId, feature) {
  const p = feature.properties;
  const layer = layerById[layerId];
  const root = el('div', { class: 'popup' });
  root.append(el('p', { class: 'popup-cat' }, layer.short + (p.sub && p.sub !== layer.short ? `・${p.sub}` : '')));
  root.append(el('h3', { class: 'popup-title' }, p.name || '(名称なし)'));
  const rows = [];
  if (state.pin) {
    const here = feature.geometry.coordinates;
    rows.push(['ピンから', `${formatDistance(distanceM(state.pin, here))}（${bearingLabel(state.pin, here)}）`]);
  }
  if (p.address) rows.push(['住所', p.address]);
  if (p.date) rows.push(['日付', p.date]);
  (p.details || []).forEach(([k, v]) => rows.push([k, v]));
  (p.services ? [['サービス', p.services.join('、')]] : []).forEach((r) => rows.push(r));
  const dl = el('dl', { class: 'popup-dl' });
  rows.forEach(([k, v]) => dl.append(el('dt', {}, k), el('dd', {}, String(v))));
  root.append(dl);
  if (p.phone) {
    const a = el('a', { href: `tel:${p.phone.replace(/[^0-9+]/g, '')}`, class: 'popup-link' }, `電話 ${p.phone}`);
    root.append(a);
  }
  if (p.url) {
    root.append(el('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', class: 'popup-link' }, '詳細ページ（外部サイト）'));
  }
  if (p.approx) {
    root.append(el('p', { class: 'popup-warn' },
      `位置は「${(p.located || '').replace('新潟県三条市', '')}」付近の目安で、正確な場所ではありません。住所をもとに町丁目の代表点へ配置しています。`));
  }
  if (layerId === 'hugca') {
    root.append(el('p', { class: 'popup-warn' }, '特典の内容・条件・利用できる方は、店舗によって異なります。三条市の案内でご確認ください。'));
    root.append(el('a', { href: HUGCA_INFO_URL, target: '_blank', rel: 'noopener noreferrer', class: 'popup-link' },
      'HUGCA（ハグカ）の案内（三条市）'));
  }
  if (layerId === 'shelter') {
    root.append(el('p', { class: 'popup-warn' }, '使用可否は災害の種類や状況で変わります。避難時は三条市の避難情報を確認してください。'));
  }
  return root;
}

function openPopup(layerId, feature, sameSpot = []) {
  state.popup?.remove();
  let content = popupContent(layerId, feature);
  if (sameSpot.length > 1) {
    // 同じ地点に複数ある場合（町丁目の代表点に配置した文化財など）は、まとめて縦に並べる
    content = el('div', { class: 'popup-multi' },
      el('p', { class: 'popup-count' }, `この地点に ${sameSpot.length} 件あります`),
      sameSpot.map((f) => popupContent(layerId, f)));
  }
  state.popup = new maplibregl.Popup({ maxWidth: '320px', offset: 18, focusAfterOpen: !isMobile() })
    .setLngLat(feature.geometry.coordinates)
    .setDOMContent(content)
    .addTo(map);
}

// queryRenderedFeatures は配列・オブジェクトの属性を JSON 文字列にして返すため、元に戻す
function restoreProps(props) {
  const out = { ...props };
  ['details', 'services'].forEach((key) => {
    if (typeof out[key] === 'string') {
      try { out[key] = JSON.parse(out[key]); } catch { delete out[key]; }
    }
  });
  return out;
}

function bindMapClicks() {
  const ids = LAYERS.map((l) => `pt-${l.id}`);
  map.on('click', (e) => {
    const hits = map.queryRenderedFeatures(e.point, { layers: ids.filter((i) => map.getLayer(i)) });
    if (hits.length) {
      const h = hits[0];
      const layerId = h.layer.id.replace(/^pt-/, '');
      const same = hits.filter((x) => x.layer.id === h.layer.id
        && x.geometry.coordinates[0] === h.geometry.coordinates[0]
        && x.geometry.coordinates[1] === h.geometry.coordinates[1])
        .map((x) => ({ geometry: x.geometry, properties: restoreProps(x.properties), type: 'Feature' }));
      openPopup(layerId, same[0], same);
      return;
    }
    if (state.districtMode !== 'off') {
      const d = map.queryRenderedFeatures(e.point, { layers: ['districts-fill'] });
      if (d.length) {
        state.popup?.remove();
        state.popup = new maplibregl.Popup({ maxWidth: '320px', focusAfterOpen: true })
          .setLngLat(e.lngLat).setDOMContent(districtPopupContent(d[0].properties)).addTo(map);
      }
    }
  });
  map.on('mousemove', (e) => {
    const hits = map.queryRenderedFeatures(e.point, { layers: ids.filter((i) => map.getLayer(i)) });
    map.getCanvas().style.cursor = hits.length ? 'pointer' : '';
  });
}

// ---------- ピンと近くの施設 ----------
function makePinElement() {
  const wrap = el('div', { class: 'pin', role: 'img', 'aria-label': '調べている地点（ドラッグで移動できます）' });
  wrap.innerHTML = '<svg width="36" height="46" viewBox="0 0 36 46" aria-hidden="true"><path d="M18 2C9 2 3 8.5 3 16.5 3 27 18 44 18 44s15-17 15-27.500C33 8.500 27 2 18 2z" fill="#0b4f8a" stroke="#fff" stroke-width="3"/><circle cx="18" cy="17" r="6" fill="#fff"/></svg><span class="pin-label">ここ</span>';
  return wrap;
}

// 初回ヒント: ピンを置く操作をするか「閉じる」を押すと消え、次回以降は出さない
const HINT_KEY = 'sanjo-hint-dismissed';
function hintDismissed() {
  try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; }
}
function dismissHint() {
  $('map-hint').hidden = true;
  try { localStorage.setItem(HINT_KEY, '1'); } catch { /* 保存できない環境では毎回表示 */ }
}

function buildQuickPlaces() {
  const box = $('quick-places');
  QUICK_PLACES.forEach((p) => {
    const b = el('button', { type: 'button', class: 'btn chip' }, p.name);
    b.addEventListener('click', () => {
      setStatus(`「${p.name}」付近にピンを置きました（例）。自宅周辺は住所か「現在地」で表示できます。`);
      setPin(p.lonlat);
      selectTab('nearby');
    });
    box.append(b);
  });
}

// ピンの位置が入る行政区（国勢調査の区域）の名称。判定はこの端末の中だけで行う。区域外・未読込なら null
function findDistrictName(lonlat) {
  const feats = state.districts?.features || [];
  const hit = feats.find((f) => pointInMultiPolygon(lonlat, f.geometry.coordinates));
  return hit ? hit.properties.name : null;
}

function setPin(lonlat, { fly = true, zoom = 15 } = {}) {
  dismissHint();
  state.pin = lonlat;
  document.dispatchEvent(new CustomEvent('pin-changed'));
  if (!state.marker) {
    state.marker = new maplibregl.Marker({ element: makePinElement(), anchor: 'bottom', draggable: true })
      .setLngLat(lonlat).addTo(map);
    state.marker.on('dragend', () => {
      const ll = state.marker.getLngLat();
      setPin([ll.lng, ll.lat], { fly: false });
    });
  } else {
    state.marker.setLngLat(lonlat);
  }
  if (fly) map.flyTo({ center: lonlat, zoom: Math.max(map.getZoom(), zoom) });
  renderNearby();
}

function inBearRange(f) {
  const d = f.properties.date;
  if (!state.bearFrom && !state.bearTo) return true;
  if (!d) return false;
  return (!state.bearFrom || d >= state.bearFrom) && (!state.bearTo || d <= state.bearTo);
}

function renderNearby() {
  const list = $('nearby-list');
  const summary = $('nearby-summary');
  list.replaceChildren();
  if (!state.pin) {
    summary.textContent = '住所を検索するか「現在地」を押すと、近くの施設が距離順に表示されます。';
    return;
  }
  const radius = Number($('radius').value);
  const items = [];
  LAYERS.filter((l) => l.nearby && state.visible[l.id]).forEach((l) => {
    (state.features[l.id] || []).forEach((f) => {
      if (l.id === 'bear' && !inBearRange(f)) return;
      const d = distanceM(state.pin, f.geometry.coordinates);
      if (d <= radius) items.push({ layer: l, feature: f, d });
    });
  });
  items.sort((a, b) => a.d - b.d);
  const radiusText = radius >= 1000 ? `${radius / 1000}km` : `${radius}m`;
  summary.textContent = items.length
    ? `ピンから${radiusText}以内に ${items.length} 件（近い順）。表示中のカテゴリのみ。`
    : `ピンから${radiusText}以内に、表示中のカテゴリの施設は見つかりませんでした。範囲を広げるか、「表示の切替」を確認してください。`;
  const shown = items.slice(0, 100);
  shown.forEach(({ layer, feature, d }) => {
    const p = feature.properties;
    const btn = el('button', { type: 'button', class: 'nearby-item' });
    const img = el('img', { src: iconDataUrl(layer), alt: '', width: '32', height: '32' });
    const text = el('span', { class: 'nearby-text' },
      el('span', { class: 'nearby-name' }, p.name || '(名称なし)'),
      el('span', { class: 'nearby-meta' }, `${layer.short}${p.date ? `（${p.date}）` : ''}${p.address ? `　${p.address}` : ''}`));
    const dist = el('span', { class: 'nearby-dist' }, `${formatDistance(d)} ${bearingLabel(state.pin, feature.geometry.coordinates)}`);
    btn.append(img, text, dist);
    btn.addEventListener('click', () => {
      if (isMobile()) selectTab('map'); // シートを閉じて地図を見せる
      // スマホでは地図が小さいため、施設を上寄りに置いて吹き出しの下側を確保する
      const up = isMobile() ? -Math.round(map.getContainer().clientHeight * 0.22) : 0;
      map.flyTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), 16), offset: [0, up] });
      openPopup(layer.id, feature);
      document.querySelector('.map-wrap').scrollIntoView({ block: 'nearest' });
    });
    list.append(el('li', {}, btn));
  });
  if (items.length > shown.length) {
    list.append(el('li', { class: 'nearby-more' }, `ほか ${items.length - shown.length} 件（範囲を狭めると絞り込めます）`));
  }
}

// ---------- 検索・現在地 ----------
function setStatus(msg) { $('search-status').textContent = msg; }

async function onSearch(e) {
  e.preventDefault();
  const q = $('search-input').value.trim();
  const choices = $('search-results');
  choices.hidden = true;
  choices.replaceChildren();
  if (!q) { setStatus('住所を入力してください。'); return; }
  setStatus('国土地理院の住所検索APIに問い合わせ中です…');
  try {
    const results = await geocode(q);
    if (!results.length) {
      setStatus('住所が見つかりませんでした。「三条市」から入力するか、丁目・番地を省いて試してください。');
      return;
    }
    if (results.length === 1) {
      setStatus(`「${results[0].title}」付近にピンを置きました。`);
      setPin(results[0].lonlat);
      selectTab('nearby');
      return;
    }
    setStatus(`${results.length} 件見つかりました。場所を選んでください。`);
    results.forEach((r) => {
      const b = el('button', { type: 'button', class: 'btn choice' }, r.title);
      b.addEventListener('click', () => {
        choices.hidden = true;
        setStatus(`「${r.title}」付近にピンを置きました。`);
        setPin(r.lonlat);
        selectTab('nearby');
      });
      choices.append(el('li', {}, b));
    });
    choices.hidden = false;
  } catch {
    setStatus('住所検索に失敗しました。通信状況を確認するか、地図の中心にピンを置く方法をお試しください。');
  }
}

function onLocate() {
  if (!navigator.geolocation) { setStatus('この端末では現在地を取得できません。'); return; }
  setStatus('現在地を取得中です…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setStatus('現在地にピンを置きました（位置情報は端末内でのみ使います）。');
      setPin([pos.coords.longitude, pos.coords.latitude]);
      selectTab('nearby');
    },
    (err) => {
      setStatus(err.code === 1
        ? '位置情報の利用が許可されていません。ブラウザの設定を確認するか、住所で検索してください。'
        : '現在地を取得できませんでした。住所で検索してください。');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
}

// ---------- UI ----------
// スマホ（幅899px以下）では「近く/表示/データ」を地図の上に重なるシートとして表示する
const mobileMq = window.matchMedia('(max-width: 899px)');
const isMobile = () => mobileMq.matches;

function placeSheets() {
  const host = $('sheet-host');
  const panel = document.querySelector('.panel');
  const footer = document.querySelector('.site-footer');
  const views = [...document.querySelectorAll('.view')];
  if (isMobile()) {
    views.forEach((v) => host.append(v));
    $('view-about').append(footer); // 下タブと重ならないよう、出典は「データ」シートの末尾へ
  } else {
    views.forEach((v) => panel.append(v));
    document.body.append(footer);
  }
  map.resize();
}

function selectTab(name) {
  document.dispatchEvent(new CustomEvent('tab-selected', { detail: name }));
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.id === `tab-${name}`;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
}

function buildTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t.id.replace('tab-', '')));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const shown = tabs.filter((x) => x.offsetParent !== null); // PCでは「地図」タブは非表示
      const at = shown.indexOf(t);
      const next = shown[(at + (e.key === 'ArrowRight' ? 1 : shown.length - 1)) % shown.length];
      next.focus();
      selectTab(next.id.replace('tab-', ''));
    });
  });
}

function toggleItem(idPrefix, id, labelNode, checked, onChange) {
  const input = el('input', { type: 'checkbox', id: `${idPrefix}-${id}` });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('li', {}, el('label', { class: 'toggle', for: `${idPrefix}-${id}` }, input, labelNode));
}

function buildToggles() {
  const ul = $('layer-toggles');
  LAYERS.forEach((l) => {
    const img = el('img', { src: iconDataUrl(l), alt: '', width: '28', height: '28' });
    const m = state.manifest[l.id];
    const label = el('span', { class: 'toggle-text' }, `${l.label}`,
      el('span', { class: 'toggle-count' }, `${m ? `（${m.count}件）` : ''}${l.minzoom ? '　※拡大すると表示' : ''}`));
    ul.append(toggleItem('layer', l.id, [img, label], state.visible[l.id], (on) => setLayerVisible(l.id, on)));
  });
  const hz = $('hazard-toggles');
  HAZARDS.forEach((h) => {
    hz.append(toggleItem('hz', h.id, el('span', { class: 'toggle-text' }, h.label), h.on, (on) => {
      map.setLayoutProperty(`hz-${h.id}`, 'visibility', on ? 'visible' : 'none');
    }));
  });
}

function buildBearControls() {
  const m = state.manifest.bear;
  const note = $('bear-note');
  if (m?.dateRange) {
    note.textContent = `この情報は最新ではありません。${m.dateRange[0]}〜${m.dateRange[1]} の報告のうち、座標のある ${m.count} 件（全 ${m.totalReports} 件中）だけを表示しています。`;
    $('bear-from').min = m.dateRange[0];
    $('bear-from').max = m.dateRange[1];
    $('bear-to').min = m.dateRange[0];
    $('bear-to').max = m.dateRange[1];
  }
  const apply = () => {
    state.bearFrom = $('bear-from').value;
    state.bearTo = $('bear-to').value;
    if (map.getLayer('pt-bear')) map.setFilter('pt-bear', bearFilter());
    renderNearby();
  };
  $('bear-from').addEventListener('change', apply);
  $('bear-to').addEventListener('change', apply);
  $('bear-reset').addEventListener('click', () => {
    $('bear-from').value = '';
    $('bear-to').value = '';
    apply();
  });
}

function buildDataTable() {
  const body = $('data-table-body');
  const dm = state.manifest.districts;
  if (dm) {
    body.append(el('tr', {}, el('th', { scope: 'row' }, '行政区別人口'),
      el('td', {}, dm.fetchedAt || '不明'),
      el('td', {}, `${dm.count}地区（対応なし ${dm.excluded}）`)));
  }
  LAYERS.forEach((l) => {
    const m = state.manifest[l.id];
    if (!m) return;
    const row = el('tr', {},
      el('th', { scope: 'row' }, l.label),
      el('td', {}, m.fetchedAt || '不明'),
      el('td', {}, `${m.count}件${m.excluded ? `（除外 ${m.excluded}）` : ''}`));
    body.append(row);
  });
}

function init() {
  $('official-link').href = OFFICIAL_HAZARD_URL;
  if (GOMI_ENABLED || new URLSearchParams(location.search).get('gomi') === '1') {
    $('tab-gomi').hidden = false;
    initGomi({ getPin: () => state.pin, findDistrict: findDistrictName });
  }
  buildTabs();
  placeSheets();
  selectTab(isMobile() ? 'map' : 'nearby');
  mobileMq.addEventListener('change', () => {
    placeSheets();
    if (!isMobile() && document.getElementById('tab-map').getAttribute('aria-selected') === 'true') selectTab('nearby');
  });
  $('search-form').addEventListener('submit', onSearch);
  $('locate-btn').addEventListener('click', onLocate);
  buildQuickPlaces();
  $('map-hint').hidden = hintDismissed();
  $('hint-locate').addEventListener('click', onLocate);
  $('hint-close').addEventListener('click', dismissHint);
  $('radius').addEventListener('change', renderNearby);
  $('center-pin-btn').addEventListener('click', () => {
    const c = map.getCenter();
    setPin([c.lng, c.lat], { fly: false });
    setStatus('地図の中心にピンを置きました。ピンはドラッグで動かせます。');
    if (isMobile()) selectTab('map');
  });
}

init();

map.on('load', async () => {
  LAYERS.forEach((l) => map.addImage(`icon-${l.id}`, iconImageData(l), { pixelRatio: 2 }));
  addHazardLayers();
  try {
    await loadData();
  } catch (e) {
    setStatus(`データの読み込みに失敗しました（${e.message}）。ページを再読み込みしてください。`);
    return;
  }
  buildToggles();
  buildBearControls();
  buildDistrictControls();
  buildDataTable();
  bindMapClicks();
  renderNearby();
});
