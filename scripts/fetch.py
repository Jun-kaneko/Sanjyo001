#!/usr/bin/env python3
"""三条市オープンデータ CSV の取得。

- 取得・検証に成功したファイルだけを data/raw/ に置き換える（失敗時は既存を残す）
- 内容が変わったファイルだけ取得日を更新する（data/raw/fetch-log.json）
- 1つでも失敗したら終了コード 1（GitHub Actions で通知に使う）

使い方: python3 scripts/fetch.py
"""
import hashlib
import json
import sys
import time
import urllib.request
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from convert import LAYERS, RAW_DIR, SOURCE_BASE, decode_bytes, parse_rows  # noqa: E402

USER_AGENT = "sanjo-uchinochikaku-map/1.0 (open data fetch; weekly)"
MIN_BYTES = 200


def download(url, retries=3):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as r:
                if r.status != 200:
                    raise RuntimeError(f"HTTP {r.status}")
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"取得失敗: {url}: {last}")


def validate(data, spec):
    if len(data) < MIN_BYTES:
        raise ValueError(f"ファイルが小さすぎます ({len(data)} bytes)")
    text, _, _ = decode_bytes(data)
    header, records = parse_rows(text)
    # 座標のないデータ（geocode 指定）は住所列で検証する
    needed = [spec["address"]] if spec.get("geocode") else None
    if needed:
        if not all(n in header for n in needed):
            raise ValueError(f"{needed} の列が見つかりません")
    elif not any(h in header for h in ("緯度", "latitude")):
        raise ValueError("緯度列が見つかりません")
    if not records:
        raise ValueError("データ行がありません")


def main():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    log_path = RAW_DIR / "fetch-log.json"
    log = json.loads(log_path.read_text(encoding="utf-8")) if log_path.exists() else {}
    today = date.today().isoformat()
    failures = []
    for layer_id, spec in LAYERS.items():
        name = spec["file"]
        url = SOURCE_BASE + name
        try:
            data = download(url)
            validate(data, spec)
        except Exception as e:  # noqa: BLE001
            failures.append(f"{name}: {e}")
            print(f"[FAIL] {name}: {e}", file=sys.stderr)
            continue
        digest = hashlib.sha256(data).hexdigest()
        if log.get(name, {}).get("sha256") == digest:
            print(f"[SAME] {name}")
            continue
        (RAW_DIR / name).write_bytes(data)
        log[name] = {"sha256": digest, "fetchedAt": today}
        print(f"[NEW ] {name}")
    log_path.write_text(json.dumps(log, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
                        encoding="utf-8")
    if failures:
        print("取得に失敗したファイル:\n  " + "\n  ".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
