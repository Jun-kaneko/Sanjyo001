// 地図レイヤーの定義。色だけに頼らないよう「色＋形＋文字」で区別する。
// nearby: 「うちの近く」パネルの検索対象にするか / on: 初期表示 / minzoom: 点が多いため、このズーム以上で描画

export const LAYERS = [
  { id: 'shelter', label: '指定緊急避難場所', short: '避難場所', color: '#b3261e', shape: 'triangle', glyph: '避', nearby: true, on: true },
  { id: 'aed', label: 'AED', short: 'AED', color: '#0b6e4f', shape: 'circle', glyph: 'A', nearby: true, on: true },
  { id: 'toilet', label: '公衆トイレ', short: '公衆トイレ', color: '#6a3d9a', shape: 'square', glyph: 'ト', nearby: true, on: true },
  { id: 'medical', label: '医療機関', short: '医療機関', color: '#0057b8', shape: 'diamond', glyph: '医', nearby: true, on: true },
  { id: 'childcare', label: '子育て支援施設', short: '子育て', color: '#b34700', shape: 'hexagon', glyph: '子', nearby: true, on: true },
  { id: 'station', label: '駅・バス停留所', short: '駅・バス停', color: '#4a4a4a', shape: 'pentagon', glyph: '駅', nearby: true, on: true },
  { id: 'drt', label: 'デマンド交通停留所', short: 'デマンド交通', color: '#00707a', shape: 'star', glyph: 'デ', nearby: true, on: false },
  { id: 'bear', label: 'クマ出没箇所', short: 'クマ出没', color: '#7a1f5c', shape: 'invtriangle', glyph: '熊', nearby: true, on: true },
  { id: 'school', label: '小・中学校', short: '学校', color: '#7a5c00', shape: 'square', glyph: '学', nearby: false, on: false },
  { id: 'public', label: '公共施設', short: '公共施設', color: '#33415c', shape: 'hexagon', glyph: '公', nearby: false, on: false },
  { id: 'tourism', label: '観光施設', short: '観光', color: '#1b5e20', shape: 'diamond', glyph: '観', nearby: false, on: false },
  { id: 'wifi', label: '公衆無線LANアクセスポイント', short: 'Wi-Fi', color: '#006064', shape: 'hexagon', glyph: 'W', nearby: true, on: false },
  { id: 'exchange', label: '交流施設・アトリエ付滞在型施設', short: '交流施設', color: '#6d4c00', shape: 'pentagon', glyph: '交', nearby: false, on: false },
  { id: 'hydrant', label: '消火栓', short: '消火栓', color: '#b3261e', shape: 'circle', glyph: '消', nearby: false, on: false, minzoom: 14 },
  { id: 'tank', label: '防火水槽', short: '防火水槽', color: '#1a4f8f', shape: 'square', glyph: '水', nearby: false, on: false, minzoom: 14 },
  { id: 'care', label: '介護サービス施設', short: '介護', color: '#8c2f00', shape: 'circle', glyph: '介', nearby: false, on: false },
];

// 国土地理院タイル（ハザードマップポータルサイト）。ズーム 2〜17。
const HAZARD_BASE = 'https://disaportaldata.gsi.go.jp/raster/';
export const HAZARDS = [
  { id: 'flood', label: '洪水浸水想定区域（想定最大規模）', path: '01_flood_l2_shinsuishin_data', on: true },
  { id: 'sediment-debris', label: '土砂災害警戒区域（土石流）', path: '05_dosekiryukeikaikuiki', on: false },
  { id: 'sediment-steep', label: '土砂災害警戒区域（急傾斜地の崩壊）', path: '05_kyukeishakeikaikuiki', on: false },
  { id: 'sediment-slide', label: '土砂災害警戒区域（地すべり）', path: '05_jisuberikeikaikuiki', on: false },
].map((h) => ({ ...h, url: `${HAZARD_BASE}${h.path}/{z}/{x}/{y}.png` }));

export const OFFICIAL_HAZARD_URL =
  'https://www.city.sanjo.niigata.jp/bosai_bohan/bosai/higoronosonae/gaidomappuhazzardmap/index.html';
