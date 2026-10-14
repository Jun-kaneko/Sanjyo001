import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { LAYERS, HAZARDS, OFFICIAL_HAZARD_URL } from './layers.js';
import { iconImageData, iconDataUrl } from './icons.js';
import { distanceM, formatDistance, bearingLabel, geocode } from './geo.js';

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
  await Promise.all(LAYERS.map(async (l) => {
    const fc = await get(`${l.id}.geojson`);
    state.features[l.id] = fc.features;
    map.addSource(`pt-${l.id}`, { type: 'geojson', data: fc });
    map.addLayer({
      id: `pt-${l.id}`, type: 'symbol', source: `pt-${l.id}`,
      filter: l.id === 'bear' ? bearFilter() ?? true : true,
      layout: {
        'icon-image': `icon-${l.id}`,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.7, 13, 1.0, 16, 1.25],
        'icon-allow-overlap': true,
        visibility: state.visible[l.id] ? 'visible' : 'none',
      },
    });
  }));
}

function setLayerVisible(id, on) {
  state.visible[id] = on;
  if (map.getLayer(`pt-${id}`)) map.setLayoutProperty(`pt-${id}`, 'visibility', on ? 'visible' : 'none');
  renderNearby();
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
  if (layerId === 'shelter') {
    root.append(el('p', { class: 'popup-warn' }, '使用可否は災害の種類や状況で変わります。避難時は三条市の避難情報を確認してください。'));
  }
  return root;
}

function openPopup(layerId, feature) {
  state.popup?.remove();
  state.popup = new maplibregl.Popup({ maxWidth: '300px', offset: 18, focusAfterOpen: true })
    .setLngLat(feature.geometry.coordinates)
    .setDOMContent(popupContent(layerId, feature))
    .addTo(map);
}

function bindMapClicks() {
  const ids = LAYERS.map((l) => `pt-${l.id}`);
  map.on('click', (e) => {
    const hits = map.queryRenderedFeatures(e.point, { layers: ids.filter((i) => map.getLayer(i)) });
    if (hits.length) {
      const h = hits[0];
      const layerId = h.layer.id.replace(/^pt-/, '');
      openPopup(layerId, { geometry: h.geometry, properties: h.properties, type: 'Feature' });
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

function setPin(lonlat, { fly = true, zoom = 15 } = {}) {
  state.pin = lonlat;
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
      map.flyTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), 16) });
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
function selectTab(name) {
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
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
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
      el('span', { class: 'toggle-count' }, m ? `（${m.count}件）` : ''));
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
  buildTabs();
  $('search-form').addEventListener('submit', onSearch);
  $('locate-btn').addEventListener('click', onLocate);
  $('radius').addEventListener('change', renderNearby);
  $('center-pin-btn').addEventListener('click', () => {
    const c = map.getCenter();
    setPin([c.lng, c.lat], { fly: false });
    setStatus('地図の中心にピンを置きました。ピンはドラッグで動かせます。');
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
  buildDataTable();
  bindMapClicks();
  renderNearby();
});
