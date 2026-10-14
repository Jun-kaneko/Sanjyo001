#!/usr/bin/env python3
"""行政区別の人口（三条市 000114894.csv）を国勢調査の小地域境界に結合して GeoJSON にする。

- 境界: e-Stat「令和2年国勢調査 小地域（町丁・字等）境界データ」三条市（data/raw/boundary/、JGD2000）
- 結合: 名称を正規化（NFKC・丁目の漢数字化・ケ→ヶ）して照合し、表記差は data/geo/district-aliases.json で補う
- 同名で複数の面になるものは結合し、面積を合算して人口密度を求める
- 面が見つからない行政区は地図に出さず、変換ログに記録する（位置の推測はしない）
"""
import io
import json
import re
import struct
import unicodedata
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BOUNDARY_ZIP = ROOT / "data" / "raw" / "boundary" / "r2ka15204_shape.zip"
ALIASES_PATH = ROOT / "data" / "geo" / "district-aliases.json"
POP_FILE = "000114894.csv"

_KANJI = "〇一二三四五六七八九"


# ---------- シェープファイル / DBF（標準ライブラリのみ） ----------

def read_dbf(data, encoding="cp932"):
    n = struct.unpack("<I", data[4:8])[0]
    head_len, rec_len = struct.unpack("<HH", data[8:12])
    fields, i = [], 32
    while data[i] != 0x0D:
        fields.append((data[i:i + 11].split(b"\x00")[0].decode("ascii"), data[i + 16]))
        i += 32
    out = []
    for k in range(n):
        rec = data[head_len + k * rec_len: head_len + (k + 1) * rec_len][1:]
        off, row = 0, {}
        for name, length in fields:
            row[name] = rec[off:off + length].decode(encoding, "replace").strip()
            off += length
        out.append(row)
    return out


def read_shp_polygons(data):
    """各レコードを [リング, ...]（リングは [(x, y), ...]）として返す。ポリゴン以外は空。"""
    records, pos, end = [], 100, len(data)
    while pos + 8 <= end:
        content_len = struct.unpack(">i", data[pos + 4:pos + 8])[0] * 2
        body = data[pos + 8:pos + 8 + content_len]
        pos += 8 + content_len
        shape_type = struct.unpack("<i", body[:4])[0]
        if shape_type not in (5, 15, 25):
            records.append([])
            continue
        num_parts, num_points = struct.unpack("<ii", body[36:44])
        parts = list(struct.unpack(f"<{num_parts}i", body[44:44 + 4 * num_parts]))
        p0 = 44 + 4 * num_parts
        pts = [struct.unpack("<dd", body[p0 + 16 * j:p0 + 16 * (j + 1)]) for j in range(num_points)]
        bounds = parts + [num_points]
        records.append([pts[bounds[k]:bounds[k + 1]] for k in range(num_parts)])
    return records


def ring_area(ring):
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1])) / 2


def rings_to_polygons(rings):
    """シェープのリング（外周=時計回り、穴=反時計回り）を GeoJSON の Polygon 座標のリストにする。"""
    polygons = []
    for ring in rings:
        if len(ring) < 4:
            continue
        if ring_area(ring) <= 0 or not polygons:  # 時計回り=外周（先頭が穴でも外周として扱う）
            polygons.append([ring])
        else:
            polygons[-1].append(ring)
    return polygons


# ---------- 名称の正規化と結合 ----------

def _kan(m):
    v = int(m.group(1))
    s = ""
    if v >= 10:
        s += ("" if v // 10 == 1 else _KANJI[v // 10]) + "十"
        v %= 10
    return s + (_KANJI[v] if v else "") + "丁目"


def normalize_name(name):
    s = unicodedata.normalize("NFKC", name or "").strip()
    s = re.sub(r"(\d+)丁目", _kan, s)
    return s.replace("ケ", "ヶ")


def to_int(text):
    t = (text or "").replace(",", "").strip()
    return int(t) if re.fullmatch(r"\d+", t) else None


def build_districts(pop_records, areas, aliases=None, round_digits=5):
    """pop_records: 行政区CSVの行（辞書）。areas: 正規化名 -> {"polygons": [...], "area_m2": float}。

    (features, unmatched行政区, 使われなかった面の名称) を返す。"""
    aliases = {normalize_name(k): [normalize_name(v) for v in vs]
               for k, vs in (aliases or {}).items() if not k.startswith("_")}
    features, unmatched, used = [], [], set()
    for rec in pop_records:
        if not rec.get("行政区コード"):
            continue  # 総数行
        name = rec["行政区名"]
        key = normalize_name(name)
        names = [key] if key in areas else [n for n in aliases.get(key, []) if n in areas]
        pop, men, women, hh = (to_int(rec.get(k)) for k in ("人口(総数)", "人口(男)", "人口(女)", "世帯数"))
        if not names or pop is None:
            unmatched.append({"code": rec["行政区コード"], "name": name, "population": pop, "households": hh})
            continue
        polygons, area = [], 0.0
        for n in names:
            polygons += areas[n]["polygons"]
            area += areas[n]["area_m2"]
            used.add(n)
        # 人口密度 = 人口 ÷ 結合した面の面積（水面などを含む国勢調査の区域面積）
        density = round(pop / (area / 1e6), 1) if area > 0 else None
        props = {"name": name, "code": rec["行政区コード"], "population": pop, "male": men,
                 "female": women, "households": hh,
                 "area_km2": round(area / 1e6, 3), "density": density,
                 "hh_size": round(pop / hh, 2) if hh else None}
        if names != [key]:
            props["matched_as"] = "・".join(names)
        coords = [[[[round(x, round_digits), round(y, round_digits)] for x, y in ring] for ring in poly]
                  for poly in polygons]
        features.append({"type": "Feature", "properties": props,
                         "geometry": {"type": "MultiPolygon", "coordinates": coords}})
    return features, unmatched, sorted(set(areas) - used)


def load_areas(zip_path=BOUNDARY_ZIP):
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        shp = z.read(next(n for n in names if n.endswith(".shp")))
        dbf = z.read(next(n for n in names if n.endswith(".dbf")))
    attrs, shapes = read_dbf(dbf), read_shp_polygons(shp)
    areas = {}
    for a, rings in zip(attrs, shapes):
        key = normalize_name(a["S_NAME"])
        item = areas.setdefault(key, {"polygons": [], "area_m2": 0.0})
        item["polygons"] += rings_to_polygons(rings)
        item["area_m2"] += float(a.get("AREA") or 0)
    return areas


def run(raw_dir, out_dir, fetch_log):
    """変換を実行して GeoJSON を書き出し、(manifest項目, 変換ログの行) を返す。"""
    from convert import clean, decode_bytes, dump_json, parse_rows  # 循環参照を避けるため遅延 import

    text, _, _ = decode_bytes((raw_dir / POP_FILE).read_bytes())
    _, records = parse_rows(text)
    aliases = json.loads(ALIASES_PATH.read_text(encoding="utf-8")) if ALIASES_PATH.exists() else {}
    features, unmatched, unused = build_districts(records, load_areas(), aliases)
    dump_json(out_dir / "districts.geojson", {"type": "FeatureCollection", "features": features})
    total = sum(f["properties"]["population"] for f in features)
    all_pop = sum(to_int(r["人口(総数)"]) or 0 for r in records if r.get("行政区コード"))
    entry = {
        "label": "行政区別人口（令和2年国勢調査の区域に配置）", "count": len(features),
        "excluded": len(unmatched), "source": "https://www.city.sanjo.niigata.jp/material/files/group/3/" + POP_FILE,
        "fetchedAt": fetch_log.get(POP_FILE, {}).get("fetchedAt"),
        "population": total, "populationAll": all_pop,
    }
    log = [
        f"| 行政区別人口 | {len(records) - 1} | {len(features)} | {len(unmatched)} | "
        f"面なし: {'、'.join(u['name'] for u in unmatched) or '-'}（人口 {all_pop - total:,} 人分）|",
    ]
    return entry, log, unmatched, unused
