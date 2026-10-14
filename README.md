# うちの近くマップ（三条市）

三条市のオープンデータを使い、自宅周辺の避難場所・AED・公衆トイレ・医療機関・子育て支援施設・停留所などを地図で確認できる静的Webツールです。**PCのブラウザでの利用を前提**としています（スマートフォン表示は対象外）。

> 本リポジトリ・サイトは、個人が三条市のオープンデータを加工して作成した**非公式**のもので、三条市が運営するものではありません。

> **この地図は参考情報です。** 避難時は必ず三条市の公式ハザードマップ・避難情報を確認してください。

## 機能

- 地図表示（初期表示は三条市役所付近）。国土地理院の標準地図タイル＋MapLibre GL JS
- 住所検索（国土地理院 住所検索API）と現在地ボタン。ピンはドラッグで動かせます
- 「うちの近く」パネル: ピンから半径内の施設を距離順に表示。タップで地図が移動しポップアップを開く
- カテゴリ別の表示切替（色＋形＋文字でアイコンを区別）
- クマ出没箇所の表示と期間での絞り込み（※最新ではなく、座標のある一部のみ）
- 洪水浸水想定区域（想定最大規模）・土砂災害警戒区域の重ね表示（国土地理院タイル）

## プライバシー

- 入力した住所は国土地理院の住所検索APIにのみ送信されます（画面にも明記）。
- 現在地・ピン位置・距離計算はブラウザ内で完結し、独自サーバーへの送信、ログ・アナリティクスへの記録は行いません。

## 開発

必要なもの: Node.js 20 以上、Python 3.9 以上（標準ライブラリのみ）

```bash
npm install
python3 scripts/fetch.py      # CSV を取得（data/raw/ に保存。失敗時は既存を保持）
python3 scripts/lookup_muni.py  # 座標の自治体コードを取得（data/geo/muni-cache.json。新しい座標だけ問い合わせ）
python3 scripts/convert.py    # CSV → GeoJSON（public/data/）。何度実行しても同じ結果
npm run dev                   # 開発サーバー
npm run build                 # dist/ に出力
npm test                      # 変換スクリプトのテスト
```

### データ変換の仕様（`scripts/convert.py`）

- 文字コードは自動判定（CP932 / UTF-8 / BOM付きUTF-8）。2行ヘッダーと公衆トイレの別形式に対応
- 全角数字は半角に統一
- 座標が「三条市および隣接自治体（新潟市南区・長岡市・燕市・五泉市・魚沼市・見附市・加茂市・阿賀町・田上町・只見町）」の外にある行、座標なし・形式不正の行は出力せず、`docs/convert-log.md` と `docs/coord-issues.md` に記録（推測補完はしない）
- 介護サービス施設は名称＋座標で集約し、サービス名を併記
- クマ出没の和暦日付（`R7.4.7`）は西暦（`2025-04-07`）へ変換
- 取得日は `data/raw/fetch-log.json` に記録。内容が変わったときだけ更新される

### ディレクトリ

```
data/raw/        取得したままのCSV（Shift_JIS）と fetch-log.json
public/data/     変換後 GeoJSON と manifest.json
scripts/         fetch.py / convert.py / tests/
src/             地図UI（main.js, layers.js, icons.js, geo.js, style.css）
docs/            data-report.md（調査）, coord-issues.md, convert-log.md
.github/workflows/  update-data.yml（週次更新）, deploy.yml（Pages公開）
```

## 公開（GitHub Pages）

リポジトリ: https://github.com/Jun-kaneko/Sanjyo001

1. Settings → Pages → Source を「GitHub Actions」にする
2. Settings → Actions → General → 「Allow GitHub Actions to create and approve pull requests」を有効にする（週次更新のPR作成に必要）
3. `main` に push すると `deploy.yml` が公開します（`https://jun-kaneko.github.io/Sanjyo001/`）

## データ更新

`update-data.yml` が毎週月曜に CSV を再取得し、差分があれば PR を作ります。取得に失敗したファイルは既存データを残し、Issue で通知します。

## 動作確認手順（PCブラウザ）

1. `npm run build && npm run preview` を実行し、表示された URL を開く（または Pages 公開後の URL）
2. **Chrome / Edge / Firefox / Safari の最新版**、画面幅1280px前後で次を確認する
   - 住所（例: 三条市旭町2-3-1）を検索 → ピンが置かれ、「うちの近く」に距離順で並ぶ
   - リストをクリック → 地図が移動しポップアップが開く
   - 「現在地」を押すと位置情報の許可を求められ、許可後にピンが置かれる
   - 「表示の切替」でカテゴリ・洪水タイル・クマ出没期間が切り替わる
3. キーボード（Tab / Shift+Tab / Enter / 矢印キー）でタブとリストを操作できることを確認する

## ライセンス・出典

- 出典: [三条市オープンデータ](https://www.city.sanjo.niigata.jp/soshiki/somubu/dxsuishinka/service/4773.html)（クリエイティブ・コモンズ 表示 2.1 日本）。三条市が公開するCSVを加工して掲載しています
- 地図: 地理院タイル（国土地理院）
- 災害情報: ハザードマップポータルサイト（国土地理院）

## 未確認事項

[docs/data-report.md](docs/data-report.md) の「未確認事項」を参照してください。
