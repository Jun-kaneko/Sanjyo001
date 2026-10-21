// ごみカレンダー（案A）: 町名を選ぶと、該当地区の市のカレンダー（PDF）へのリンクを出す。
// PDFの複製や内容の再構成はしない。町名→地区→PDF の対応表（public/data/gomi.json）だけを使う。

const STORE_KEY = 'sanjo-gomi-town'; // 選んだ町名（この端末のブラウザにだけ保存）

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  });
  children.flat().forEach((c) => node.append(c));
  return node;
}

// 検索用の正規化: 全角→半角、ひらがな→カタカナ、空白除去
function norm(s) {
  return (s || '').normalize('NFKC').replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/\s+/g, '');
}

function load() {
  try { return localStorage.getItem(STORE_KEY) || ''; } catch { return ''; }
}
function save(v) {
  try { if (v) localStorage.setItem(STORE_KEY, v); else localStorage.removeItem(STORE_KEY); } catch { /* 保存できない環境では何もしない */ }
}

export async function initGomi({ getPin, findDistrict } = {}) {
  const $ = (id) => document.getElementById(id);
  let data;
  try {
    const res = await fetch('data/gomi.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch {
    $('gomi-card').hidden = false;
    $('gomi-card').textContent = 'ごみカレンダーの情報を読み込めませんでした。時間をおいて再読み込みしてください。';
    return;
  }

  const towns = data.towns;
  const kanas = [...new Set(towns.map((t) => t.kana))].sort();
  let kana = '';

  $('gomi-title').textContent = `${data.title}（三条市）`;
  const kanaBox = $('gomi-kana');
  const kanaButtons = kanas.map((k) => {
    const b = h('button', { type: 'button', class: 'btn kana', 'aria-pressed': 'false' }, k);
    b.addEventListener('click', () => {
      kana = kana === k ? '' : k;
      kanaButtons.forEach((x) => x.setAttribute('aria-pressed', String(x.textContent === kana)));
      renderList();
    });
    kanaBox.append(b);
    return b;
  });

  function matches() {
    const q = norm($('gomi-input').value);
    if (!q && !kana) return null;
    return towns.filter((t) => (!kana || t.kana === kana) && (!q || norm(t.town).includes(q)));
  }

  function renderList() {
    const list = $('gomi-results');
    const hit = matches();
    list.replaceChildren();
    $('gomi-hint').hidden = hit !== null;
    if (hit === null) return;
    $('gomi-count').textContent = hit.length ? `${hit.length} 件` : '該当する町名がありません。別の表記（例: 「1丁目」を省く）もお試しください。';
    hit.forEach((t) => {
      const b = h('button', { type: 'button', class: 'gomi-item' },
        h('span', { class: 'gomi-town' }, t.town), h('span', { class: 'gomi-dist' }, t.district));
      b.addEventListener('click', () => select(t));
      list.append(h('li', {}, b));
    });
  }

  function select(t, { persist = true } = {}) {
    if (persist) save(t.town);
    const card = $('gomi-card');
    const url = data.pdfBase + t.pdf;
    const split = /[（(]/.test(t.town);
    card.replaceChildren(
      h('p', { class: 'gomi-lead' }, `「${t.town}」は`),
      h('p', { class: 'gomi-district' }, t.district),
      h('a', { class: 'btn primary gomi-open', href: url, target: '_blank', rel: 'noopener noreferrer' },
        `${data.title}（${t.district}）を開く`),
      h('p', { class: 'note' }, '三条市のサイトで、PDF（A3・2ページ）が開きます。拡大や印刷はPDFの画面で操作してください。'),
      split ? h('p', { class: 'gomi-warn' }, '同じ町名でも、場所によって地区が分かれています。お住まいの場所に合う方か、',
        h('a', { href: data.source, target: '_blank', rel: 'noopener noreferrer' }, '市のカレンダー一覧'), 'で確認してください。') : '',
      h('div', { class: 'gomi-actions' },
        h('button', { type: 'button', class: 'btn', id: 'gomi-forget' }, '選び直す（保存した町名を消す）')),
    );
    card.hidden = false;
    $('gomi-forget').addEventListener('click', () => {
      save('');
      card.hidden = true;
      $('gomi-input').focus();
    });
  }

  $('gomi-input').addEventListener('input', renderList);
  $('gomi-source').href = data.source;
  $('gomi-fetched').textContent = data.fetchedAt || '不明';

  // ピンの位置から地区の候補を出す（区域の判定はこの端末内。外部には送らない）
  function renderPin() {
    const box = $('gomi-pin');
    const pin = getPin?.();
    if (!pin) {
      box.replaceChildren(h('p', { class: 'note' }, '住所検索や「現在地」でピンを置くと、ここにピンの位置の地区の候補が出ます。'));
      return;
    }
    const name = findDistrict?.(pin);
    const cands = name ? data.byDistrict?.[name] : null;
    if (!cands || !cands.length) {
      box.replaceChildren(h('p', { class: 'note' },
        'ピンの位置から地区を判定できませんでした（区域データにない場所、または対応する町名がありません）。下で町名を選んでください。'));
      return;
    }
    const open = (c) => h('a', { class: 'btn primary gomi-open', href: data.pdfBase + c.pdf, target: '_blank', rel: 'noopener noreferrer' },
      `${c.district} のカレンダーを開く`);
    const parts = [h('p', { class: 'gomi-lead' }, `ピンの位置は「${name}」付近です`)];
    if (new Set(cands.map((c) => c.district)).size === 1) {
      parts.push(h('p', { class: 'gomi-district' }, `${cands[0].district} の可能性が高いです`), open(cands[0]));
    } else {
      const hasCond = cands.some((c) => c.cond);
      parts.push(h('p', { class: 'gomi-district' }, '場所によって地区が分かれます'));
      cands.forEach((c) => {
        parts.push(h('p', { class: 'gomi-cond' }, c.cond ? `${c.cond}` : (hasCond ? '上記以外の場所' : '')), open(c));
      });
    }
    parts.push(h('p', { class: 'note' }, 'ピンの位置からの推定です。お住まいの町名・自治会のごみステーションに合うか、必ず市のカレンダーでご確認ください。違う場合は下で町名を選んでください。'));
    box.replaceChildren(...parts);
  }
  document.addEventListener('pin-changed', renderPin);
  document.addEventListener('tab-selected', (e) => { if (e.detail === 'gomi') renderPin(); });
  renderPin();

  const saved = load();
  const prev = towns.find((t) => t.town === saved);
  if (prev) select(prev, { persist: false });
}
