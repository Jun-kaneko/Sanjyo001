#!/usr/bin/env python3
"""三条市オープンデータ CSV → GeoJSON 変換スクリプト。

- 文字コードを自動判定して UTF-8 に統一する（CP932 / UTF-8 / BOM付きUTF-8）
- 2行ヘッダー（項目No.行＋項目名行）と、公衆トイレの別形式ヘッダーを吸収する
- 座標のない行・範囲外の行は出力せず、除外理由を変換ログに残す（推測補完はしない）
- 同じ入力から常に同じ出力になる（冪等）。取得日は data/raw/fetch-log.json から読む

使い方: python3 scripts/convert.py
"""
import csv
import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT_DIR = ROOT / "public" / "data"
DOCS_DIR = ROOT / "docs"

SOURCE_BASE = "https://www.city.sanjo.niigata.jp/material/files/group/3/"

# 三条市を含むやや広めの範囲。市南部（下田地区など）の実在地点を落とさないよう余裕を持たせる
LAT_RANGE = (37.40, 37.80)
LON_RANGE = (138.75, 139.30)

# 座標の妥当性は「三条市および隣接自治体の内側にあるか」で判定する。
# 自治体コードは国土地理院の逆ジオコーダ（scripts/lookup_muni.py が data/geo/muni-cache.json に保存）で得る。
# 隣接自治体は Wikipedia「三条市」の隣接欄に基づく（田上町は地理的隣接のため追加。田上町のコードは API では未実測）。
ALLOWED_MUNI = {
    "15204": "三条市",
    "15106": "新潟市南区",
    "15202": "長岡市",
    "15213": "燕市",
    "15218": "五泉市",
    "15225": "魚沼市",
    "15211": "見附市",
    "15209": "加茂市",
    "15385": "阿賀町",
    "15342": "田上町",
    "07367": "只見町",
}
MUNI_CACHE_PATH = ROOT / "data" / "geo" / "muni-cache.json"
GEOCODE_CACHE_PATH = ROOT / "data" / "geo" / "geocode-cache.json"
CITY_PREFIX = "新潟県三条市"

MISSING_VALUES = {"", "-", "－", "ー", "―"}
_FULLWIDTH_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")

# 取り込み対象。キー: レイヤーID
# name/address/phone/url/sub は元の列名、details は ポップアップに出す (表示名, 列名) の並び
LAYERS = {
    "shelter": dict(
        file="000114890.csv", label="指定緊急避難場所",
        name="避難所名", address="住所", phone="電話番号", sub="種別",
        details=[("地区", "地区"), ("豪雨時の使用", "災害ごとの使用可否(豪雨)"),
                 ("震災時の使用", "災害ごとの使用可否(震災)"),
                 ("トイレ(洋式)", "トイレの状況(洋式)"),
                 ("トイレ(多目的)", "トイレの状況(多目的)"),
                 ("トイレ(オストメイト)", "トイレの状況(オストメイト)")]),
    "aed": dict(
        file="000097977.csv", label="AED（民間施設を除く）",
        name="施設", address="住所", phone="電話番号", sub="種別", details=[]),
    "toilet": dict(
        file="000114892.csv", label="公衆トイレ",
        name="name", address="address", sub="category", details=[]),
    "medical": dict(
        file="000104490.csv", label="医療機関",
        name="名称", address="住所", phone="電話番号", sub="医療機関の種類", url="URL",
        details=[("診療科目", "診療科目"), ("診療曜日", "診療曜日"),
                 ("診療開始", "診療開始時間"), ("診療終了", "診療終了時間"),
                 ("特記事項", "診療日時特記事項")]),
    "childcare": dict(
        file="000104489.csv", label="子育て支援施設",
        name="名称", address="住所", phone="電話番号", sub="種別", url="URL", details=[]),
    "station": dict(
        file="000114891.csv", label="駅・バス停留所",
        name="名称", address="住所", sub="分類", details=[]),
    "drt": dict(
        file="DRT_bus_stop_list.csv", label="デマンド交通停留所",
        name="名称", address="住所", sub="分類", details=[]),
    "school": dict(
        file="000114889.csv", label="小・中学校",
        name="名称", address="住所", phone="連絡先電話番号", sub="分類", url="url", details=[]),
    "public": dict(
        file="000104488.csv", label="公共施設",
        name="名称", address="住所", phone="電話番号", sub="分類", url="url",
        details=[("営業日", "営業日"), ("営業時間", "営業時間"), ("その他", "その他")]),
    "tourism": dict(
        file="000098250.csv", label="観光施設",
        name="名称", address="住所", phone="電話番号", sub="分類", url="url",
        details=[("アクセス", "アクセス方法")]),
    "care": dict(
        file="000114888.csv", label="介護サービス施設",
        name="介護サービス事業所名称", address="住所", phone="電話番号",
        services="実施サービス", details=[("備考", "備考")], group=True),
    "wifi": dict(
        file="000104492.csv", label="公衆無線LANアクセスポイント",
        name="施設", address="住所", phone="電話番号", url="url", details=[]),
    "exchange": dict(
        file="000114887.csv", label="交流施設・アトリエ付滞在型施設",
        name="場所名称", address="住所", phone="連絡先電話番号", sub="分類", url="URL",
        details=[("備考", "備考")]),
    "hydrant": dict(
        file="000105134.csv", label="消火栓",
        name="種別", address="住所",
        details=[("管径", "管径(mm)"), ("管理番号", "管理番号"), ("備考", "備考")]),
    "tank": dict(
        file="000121011.csv", label="防火水槽",
        name="種別", address="住所",
        details=[("容量(立方m)", "容量(立方m)"), ("管理番号", "管理番号"), ("備考", "備考")]),
    # 座標がなく住所が町丁目までの文化財。住所を国土地理院の住所検索で代表点に変換して配置する
    # （scripts/lookup_geocode.py が data/geo/geocode-cache.json に保存。位置は「目安」）
    "heritage": dict(
        file="000102416.csv", label="文化財（位置は町丁目の目安）",
        name="名称", address="住所", sub="種類", geocode=True,
        details=[("分類", "文化財分類"), ("指定区分", "概要"), ("指定番号等", "説明"),
                 ("所有者等", "所有者等"), ("指定日", "文化財指定日"), ("備考", "備考")]),
    "bear": dict(
        file="000102428.csv", label="クマ出没箇所",
        name="地区", sub="種別",
        details=[("月日", "月日"), ("時間", "時間"), ("状況", "痕跡／目撃／事故"),
                 ("場所", "山間部／居住区")], bear=True),
}


# ---------- 低レベル関数（テスト対象） ----------

def decode_bytes(data):
    """バイト列を文字列にする。(文字列, エンコーディング名, BOM有無) を返す。"""
    bom = data.startswith(b"\xef\xbb\xbf")
    for enc in ("utf-8-sig", "cp932"):
        try:
            return data.decode(enc), enc, bom
        except UnicodeDecodeError:
            continue
    raise ValueError("文字コードを判定できません（UTF-8 / CP932 以外）")


def clean(value):
    """前後の空白を除き、全角数字を半角にする。"""
    return (value or "").strip().translate(_FULLWIDTH_DIGITS)


def parse_rows(text):
    """CSV 文字列を (ヘッダー, 行辞書のリスト) にする。2行ヘッダーを自動検出する。"""
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        raise ValueError("空のCSVです")
    first = rows[0][0] if rows[0] else ""
    if first.startswith("項目") and len(rows) > 1:
        header, body = rows[1], rows[2:]
    else:
        header, body = rows[0], rows[1:]
    while header and header[-1].strip() == "":
        header.pop()
    header = [h.strip() for h in header]
    records = []
    for r in body:
        if not any(c.strip() for c in r):
            continue
        r = (r + [""] * len(header))[: len(header)]
        records.append(dict(zip(header, (clean(c) for c in r))))
    return header, records


def coord_key(lat, lon):
    return f"{lat:.6f},{lon:.6f}"


def geocode_query(address):
    """住所から検索用の文字列を作る。町丁目より細かく絞れない住所は None。

    括弧内の補足と「ほか」「など」「地内」は除く。「三条市内」のように地点を絞れないものは対象外。"""
    a = clean(address)
    a = re.sub(r"[（(].*?[）)]", "", a)
    a = re.sub(r"(ほか|など|地内)$", "", a).strip()
    if not a.startswith(CITY_PREFIX):
        return None
    rest = a[len(CITY_PREFIX):]
    if len(rest) < 2 or rest == "内":
        return None
    return a


def load_geocode_cache(path=GEOCODE_CACHE_PATH):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def load_muni_cache(path=MUNI_CACHE_PATH):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def parse_coord(lat_raw, lon_raw, muni=None):
    """緯度経度の文字列を検証して (lat, lon) を返す。不正なら (None, 理由)。

    muni: {"緯度,経度": 自治体コード} のキャッシュ。ある座標は自治体で判定し、
    無い座標は従来の矩形範囲で判定する。"""
    lat_s, lon_s = clean(lat_raw), clean(lon_raw)
    if lat_s in MISSING_VALUES or lon_s in MISSING_VALUES:
        return None, "座標なし"
    try:
        lat, lon = float(lat_s), float(lon_s)
    except ValueError:
        return None, f"座標の形式不正 ({lat_s!r}, {lon_s!r})"
    code = (muni or {}).get(coord_key(lat, lon))
    if code is not None:
        if code in ALLOWED_MUNI:
            return (lat, lon), None
        return None, f"三条市・隣接自治体の範囲外（自治体コード {code or '不明'}）"
    if not (LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LON_RANGE[0] <= lon <= LON_RANGE[1]):
        return None, "三条市周辺の範囲外"
    return (lat, lon), None


def wareki_to_iso(text):
    """'R7.4.7' や '令和7年4月7日' を '2025-04-07' にする。変換できなければ None。"""
    s = clean(text)
    m = re.fullmatch(r"R(\d+)\.(\d+)\.(\d+)", s) or \
        re.fullmatch(r"令和(\d+)年(\d+)月(\d+)日", s)
    if not m:
        return None
    y, mo, d = (int(g) for g in m.groups())
    year = 2018 + y
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return None
    return f"{year:04d}-{mo:02d}-{d:02d}"


def usable(value):
    return clean(value) not in MISSING_VALUES


def safe_url(value):
    v = clean(value)
    return v if re.match(r"https?://", v) else ""


# ---------- レイヤー変換 ----------

def build_feature(spec, rec, coord):
    props = {"name": clean(rec.get(spec["name"], ""))}
    if spec.get("bear"):
        props["name"] = props["name"] + " のクマ出没"
        iso = wareki_to_iso(rec.get("月日", ""))
        if iso:
            props["date"] = iso
    for key in ("address", "phone", "sub"):
        col = spec.get(key)
        if col and usable(rec.get(col, "")):
            props[key] = clean(rec[col])
    col = spec.get("url")
    if col and safe_url(rec.get(col, "")):
        props["url"] = safe_url(rec[col])
    details = [[label, clean(rec[col])] for label, col in spec["details"]
               if col in rec and usable(rec[col])]
    if details:
        props["details"] = details
    lat, lon = coord
    return {"type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
            "properties": props}


def convert_layer(layer_id, text, muni=None, geocodes=None):
    """CSV 文字列を変換し (features, 件数, 除外リスト) を返す。"""
    spec = LAYERS[layer_id]
    _, records = parse_rows(text)
    if spec.get("geocode"):
        return convert_geocoded(spec, records, geocodes or {})
    lat_col = "latitude" if "latitude" in (records[0] if records else {}) else "緯度"
    lon_col = "longitude" if lat_col == "latitude" else "経度"
    features, excluded = [], []
    groups = {}
    for i, rec in enumerate(records, start=1):
        coord, reason = parse_coord(rec.get(lat_col, ""), rec.get(lon_col, ""), muni)
        label = clean(rec.get(spec["name"], ""))
        if coord is None:
            excluded.append({"row": i, "name": label, "reason": reason,
                             "lat": rec.get(lat_col, ""), "lon": rec.get(lon_col, ""),
                             "address": clean(rec.get(spec.get("address", ""), ""))})
            continue
        if spec.get("group"):
            key = (label, coord)
            if key in groups:
                groups[key]["services"].append(clean(rec.get(spec["services"], "")))
                continue
            feat = build_feature(spec, rec, coord)
            groups[key] = {"feature": feat, "services": [clean(rec.get(spec["services"], ""))]}
            features.append(feat)
        else:
            features.append(build_feature(spec, rec, coord))
    if spec.get("group"):
        for g in groups.values():
            services = []
            for s in g["services"]:
                if s and s not in services:
                    services.append(s)
            if services:
                g["feature"]["properties"]["services"] = services
    return features, len(records), excluded


def convert_geocoded(spec, records, geocodes):
    """座標のないデータを、住所の代表点（geocodes: 検索文字列 -> {lon, lat, title}）に配置する。"""
    features, excluded = [], []
    for i, rec in enumerate(records, start=1):
        label = clean(rec.get(spec["name"], ""))
        addr = clean(rec.get(spec["address"], ""))
        q = geocode_query(addr)
        hit = geocodes.get(q) if q else None
        if not hit:
            reason = "住所が町丁目まで絞れない" if not q else "住所から位置を特定できない"
            excluded.append({"row": i, "name": label, "reason": reason, "lat": "", "lon": "",
                             "address": addr})
            continue
        feat = build_feature(spec, rec, (hit["lat"], hit["lon"]))
        feat["properties"]["approx"] = True
        feat["properties"]["located"] = hit.get("title", q)
        features.append(feat)
    return features, len(records), excluded


# ---------- 出力 ----------

def dump_json(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":")) + "\n", encoding="utf-8")


def write_docs(all_excluded, log_lines):
    DOCS_DIR.mkdir(exist_ok=True)
    lines = ["# 座標の異常候補（三条市への報告用）", "",
             "`scripts/convert.py` が自動生成します（手編集しないでください）。",
             "座標が三条市および隣接自治体（" + "・".join(ALLOWED_MUNI.values()) + "）の外にある行、"
             "形式不正の行を載せています（自治体は国土地理院の逆ジオコーダで判定。未判定の座標は"
             f"北緯{LAT_RANGE[0]}〜{LAT_RANGE[1]} / 東経{LON_RANGE[0]}〜{LON_RANGE[1]} の矩形で判定）。"
             "これらの行は地図に出していません。クマ出没の「座標なし」は件数が多いため集計のみ載せます。",
             "", "| データ | 行 | 名称/地区 | 緯度 | 経度 | 住所 | 理由 |",
             "|---|---|---|---|---|---|---|"]
    for layer_id, items in all_excluded.items():
        for e in items:
            if layer_id == "bear" and e["reason"] == "座標なし":
                continue
            lines.append("| {} | {} | {} | {} | {} | {} | {} |".format(
                LAYERS[layer_id]["label"], e["row"], e["name"], e["lat"], e["lon"],
                e["address"], e["reason"]))
    (DOCS_DIR / "coord-issues.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (DOCS_DIR / "convert-log.md").write_text(
        "# 変換ログ\n\n`scripts/convert.py` が自動生成します。\n\n"
        "| レイヤー | 入力行 | 出力 | 除外 | 内訳 |\n|---|---|---|---|---|\n"
        + "\n".join(log_lines) + "\n", encoding="utf-8")


def main():
    fetch_log_path = RAW_DIR / "fetch-log.json"
    fetch_log = json.loads(fetch_log_path.read_text(encoding="utf-8")) if fetch_log_path.exists() else {}
    muni = load_muni_cache()
    geocodes = load_geocode_cache()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest, all_excluded, log_lines = {}, {}, []
    status = 0
    for layer_id, spec in LAYERS.items():
        path = RAW_DIR / spec["file"]
        if not path.exists():
            print(f"[ERROR] {path} がありません", file=sys.stderr)
            status = 1
            continue
        text, enc, _ = decode_bytes(path.read_bytes())
        features, total, excluded = convert_layer(layer_id, text, muni, geocodes)
        dump_json(OUT_DIR / f"{layer_id}.geojson",
                  {"type": "FeatureCollection", "features": features})
        reasons = {}
        for e in excluded:
            reasons[e["reason"].split(" (")[0]] = reasons.get(e["reason"].split(" (")[0], 0) + 1
        breakdown = "、".join(f"{k} {v}" for k, v in sorted(reasons.items())) or "-"
        print(f"{layer_id:10s} {spec['file']:24s} {enc:10s} 入力{total:5d} 出力{len(features):5d} 除外{len(excluded):4d}")
        log_lines.append(f"| {spec['label']} | {total} | {len(features)} | {len(excluded)} | {breakdown} |")
        all_excluded[layer_id] = excluded
        entry = {"label": spec["label"], "count": len(features), "excluded": len(excluded),
                 "source": SOURCE_BASE + spec["file"],
                 "fetchedAt": fetch_log.get(spec["file"], {}).get("fetchedAt")}
        if spec.get("bear"):
            dates = sorted(f["properties"]["date"] for f in features if "date" in f["properties"])
            entry["dateRange"] = [dates[0], dates[-1]] if dates else None
            entry["totalReports"] = total
        manifest[layer_id] = entry
    dump_json(OUT_DIR / "manifest.json", manifest)
    write_docs(all_excluded, log_lines)
    return status


if __name__ == "__main__":
    sys.exit(main())
