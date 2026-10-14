#!/usr/bin/env python3
"""全データの座標について、国土地理院の逆ジオコーダで自治体コードを調べて保存する。

- 結果は data/geo/muni-cache.json（"緯度,経度" -> 自治体コード）。調べ済みの座標は再問い合わせしない
- 日本国外・海上など自治体が得られない座標は空文字として保存する
- 通信に失敗した座標は保存せず、次回に再試行する（convert.py は矩形範囲で判定を続ける）
- 位置情報として送るのは公開オープンデータの施設座標のみで、利用者の入力は含まない

使い方: python3 scripts/lookup_muni.py
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from convert import (LAYERS, MUNI_CACHE_PATH, RAW_DIR, coord_key, decode_bytes,  # noqa: E402
                     parse_rows, clean)

API = "https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat={lat}&lon={lon}"
USER_AGENT = "sanjo-uchinochikaku-map/1.0 (open data check)"


def collect_coords():
    keys = {}
    for spec in LAYERS.values():
        text, _, _ = decode_bytes((RAW_DIR / spec["file"]).read_bytes())
        _, records = parse_rows(text)
        for rec in records:
            lat_s = clean(rec.get("緯度", rec.get("latitude", "")))
            lon_s = clean(rec.get("経度", rec.get("longitude", "")))
            try:
                lat, lon = float(lat_s), float(lon_s)
            except ValueError:
                continue
            keys[coord_key(lat, lon)] = (lat, lon)
    return keys


def lookup(lat, lon):
    req = urllib.request.Request(API.format(lat=lat, lon=lon), headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as r:
        body = json.loads(r.read().decode("utf-8"))
    return (body.get("results") or {}).get("muniCd", "")


def main():
    cache = json.loads(MUNI_CACHE_PATH.read_text(encoding="utf-8")) if MUNI_CACHE_PATH.exists() else {}
    todo = [(k, v) for k, v in sorted(collect_coords().items()) if k not in cache]
    print(f"問い合わせ対象: {len(todo)} 件（キャッシュ済み {len(cache)} 件）")
    failed = 0
    for i, (key, (lat, lon)) in enumerate(todo, start=1):
        try:
            cache[key] = lookup(lat, lon)
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"[FAIL] {key}: {e}", file=sys.stderr)
            if failed >= 20:
                print("失敗が多いため中断します", file=sys.stderr)
                break
        if i % 200 == 0:
            print(f"  {i}/{len(todo)}")
        time.sleep(0.1)
    MUNI_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    MUNI_CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, sort_keys=True, indent=0) + "\n",
                               encoding="utf-8")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
