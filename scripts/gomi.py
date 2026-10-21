#!/usr/bin/env python3
"""三条市「ごみカレンダー」ページから、町名 → 地区 → PDF の対応表を作る（案A: PDFそのものは取り込まない）。

- 元ページ: 令和8年度ごみカレンダー（三条地域・栄地域・下田地域の町名一覧）
- 出力: public/data/gomi.json（町名・地区名・PDFのURL・取得日）。PDFの複製や内容の再構成はしない
- 年度が変わるとPDF名（R8…）や一覧が変わるため、週次更新で追従し、取得に失敗したら既存データを残す
"""
import html
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_PATH = ROOT / "data" / "raw" / "gomi" / "rows.json"
PAGE_URL = "https://www.city.sanjo.niigata.jp/soshiki/shimimbu/kankyoka/gomigenryo/gomi/gomikarennda/19980.html"
PDF_BASE = "https://www.city.sanjo.niigata.jp/material/files/group/14/"
USER_AGENT = "sanjo-uchinochikaku-map/1.0 (open data fetch; weekly)"
LOG_KEY = "gomi-calendar"

_AREAS = {"sanjo": "三条", "sakae": "栄", "shitada": "下田"}
# 元ページの「ニ」行が漢数字の「二」になっているため、カナに揃える
_KANA_FIX = {"二": "ニ", "力": "カ", "口": "ロ"}


def _text(fragment):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html.unescape(fragment))).strip()


def parse_page(page_html):
    """ページから (title, rows) を返す。rows は {kana, town, district_no, pdf} のリスト。"""
    title = _text(re.search(r"<title>(.*?)</title>", page_html, re.S).group(1)).split("／")[0]
    rows, seen = [], set()
    for tr in re.findall(r"<tr.*?</tr>", page_html, re.S):
        m = re.search(r'href="(?://www\.city\.sanjo\.niigata\.jp)?/material/files/group/14/([^"/]+\.pdf)"', tr)
        if not m:
            continue
        cells = [_text(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)]
        if len(cells) < 3:
            continue
        kana, town, no = cells[0], cells[1], re.split(r"[ (（]", cells[2])[0]
        key = (town, m.group(1))
        if key in seen:
            continue
        seen.add(key)
        rows.append({"kana": kana, "town": town, "district_no": no, "pdf": m.group(1)})
    return title, rows


def district_label(pdf):
    """PDF名（R8sanjo3.pdf など）から「三条3地区」のような表示名を作る。"""
    m = re.fullmatch(r"R\d+(sanjo|sakae|shitada)([A-Za-z0-9]+)\.pdf", pdf)
    if not m:
        return None
    return f"{_AREAS[m.group(1)]}{m.group(2)}地区"


def build(title, rows, fetched_at):
    towns, districts = [], {}
    for r in rows:
        label = district_label(r["pdf"])
        if label is None:
            continue  # 想定外のファイル名は載せない（誤案内を避ける）
        towns.append({"kana": _KANA_FIX.get(r["kana"], r["kana"]), "town": r["town"], "district": label, "pdf": r["pdf"]})
        districts.setdefault(label, r["pdf"])
    towns.sort(key=lambda t: (t["kana"], t["town"], t["pdf"]))
    return {
        "title": title, "source": PAGE_URL, "pdfBase": PDF_BASE, "fetchedAt": fetched_at,
        "districts": [{"label": k, "pdf": v} for k, v in sorted(districts.items())],
        "towns": towns,
    }


def fetch_rows():
    req = urllib.request.Request(PAGE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        page = r.read().decode("utf-8", "replace")
    title, rows = parse_page(page)
    if len(rows) < 100 or not any(x["pdf"].startswith("R") for x in rows):
        raise ValueError(f"想定外のページ構造です（町名 {len(rows)} 件）")
    return title, rows


def fetch_and_save(log, today):
    """取得して data/raw/gomi/rows.json に保存。内容が変わったときだけ取得日を更新する。"""
    title, rows = fetch_rows()
    payload = {"title": title, "rows": rows}
    new = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=1) + "\n"
    old = RAW_PATH.read_text(encoding="utf-8") if RAW_PATH.exists() else None
    if new != old:
        RAW_PATH.parent.mkdir(parents=True, exist_ok=True)
        RAW_PATH.write_text(new, encoding="utf-8")
        log[LOG_KEY] = {"fetchedAt": today}
        return "NEW"
    return "SAME"


def run(raw_path, out_dir, fetch_log):
    """data/raw/gomi/rows.json から public/data/gomi.json を作り、(manifest項目, ログ行) を返す。"""
    from convert import dump_json  # 循環参照を避けるため遅延 import
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    data = build(raw["title"], raw["rows"], fetch_log.get(LOG_KEY, {}).get("fetchedAt"))
    dump_json(out_dir / "gomi.json", data)
    entry = {"label": "ごみカレンダー（町名→地区→PDF）", "count": len(data["towns"]),
             "districts": len(data["districts"]), "source": PAGE_URL, "fetchedAt": data["fetchedAt"]}
    return entry, [f"| ごみカレンダーの町名 | {len(raw['rows'])} | {len(data['towns'])} | "
                   f"{len(raw['rows']) - len(data['towns'])} | 地区 {len(data['districts'])} 件 |"]
