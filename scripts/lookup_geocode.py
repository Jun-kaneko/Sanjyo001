#!/usr/bin/env python3
"""座標のないデータ（文化財）の住所を、国土地理院の住所検索APIで代表点に変換して保存する。

- 結果は data/geo/geocode-cache.json（検索文字列 -> {lon, lat, title}、特定できなければ null）
- 結果の title が「新潟県三条市」で始まり、市名より細かい地名を含むものだけを採用する
- 調べ済みの住所は再問い合わせしない。通信失敗は保存せず次回に再試行する
- 位置は町丁目などの代表点で、施設の正確な位置ではない（画面にも明記する）

使い方: python3 scripts/lookup_geocode.py
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from convert import (CITY_PREFIX, GEOCODE_CACHE_PATH, LAYERS, RAW_DIR, decode_bytes,  # noqa: E402
                     geocode_query, parse_rows)

API = "https://msearch.gsi.go.jp/address-search/AddressSearch?q="
USER_AGENT = "sanjo-uchinochikaku-map/1.0 (open data geocode)"


def query(q):
    req = urllib.request.Request(API + urllib.parse.quote(q), headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as r:
        results = json.loads(r.read().decode("utf-8"))
    for f in results:
        title = f["properties"]["title"]
        if title.startswith(CITY_PREFIX) and len(title) > len(CITY_PREFIX):
            lon, lat = f["geometry"]["coordinates"]
            return {"lon": round(lon, 6), "lat": round(lat, 6), "title": title}
    return None


def main():
    cache = json.loads(GEOCODE_CACHE_PATH.read_text(encoding="utf-8")) if GEOCODE_CACHE_PATH.exists() else {}
    queries = set()
    for spec in LAYERS.values():
        if not spec.get("geocode"):
            continue
        text, _, _ = decode_bytes((RAW_DIR / spec["file"]).read_bytes())
        _, records = parse_rows(text)
        for rec in records:
            q = geocode_query(rec.get(spec["address"], ""))
            if q:
                queries.add(q)
    todo = sorted(q for q in queries if q not in cache)
    print(f"問い合わせ対象: {len(todo)} 件（キャッシュ済み {len(cache)} 件）")
    failed = 0
    for q in todo:
        try:
            cache[q] = query(q)
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"[FAIL] {q}: {e}", file=sys.stderr)
        time.sleep(0.2)
    GEOCODE_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    GEOCODE_CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, sort_keys=True, indent=1) + "\n",
                                  encoding="utf-8")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
