"""変換スクリプトのテスト。実行: python3 -m unittest discover -s scripts/tests"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import convert as c  # noqa: E402

RAW = Path(__file__).resolve().parents[2] / "data" / "raw"


class DecodeTest(unittest.TestCase):
    def test_cp932(self):
        text, enc, bom = c.decode_bytes("名称,緯度\n三条,37.6".encode("cp932"))
        self.assertEqual(enc, "cp932")
        self.assertIn("三条", text)
        self.assertFalse(bom)

    def test_utf8_bom(self):
        text, enc, bom = c.decode_bytes("﻿名称".encode("utf-8"))
        self.assertEqual(enc, "utf-8-sig")
        self.assertTrue(bom)
        self.assertEqual(text, "名称")

    def test_utf8_plain(self):
        text, enc, bom = c.decode_bytes("名称,緯度".encode("utf-8"))
        self.assertEqual(text, "名称,緯度")
        self.assertFalse(bom)


class ParseTest(unittest.TestCase):
    def test_two_row_header(self):
        header, recs = c.parse_rows("項目No.,1,2\n項目名,名称,緯度\n,A,37.6\n")
        self.assertEqual(header, ["項目名", "名称", "緯度"])
        self.assertEqual(recs[0]["名称"], "A")

    def test_single_header_and_trailing_empty_columns(self):
        header, recs = c.parse_rows("name,latitude,,\nA,37.6,,\n,,,\n")
        self.assertEqual(header, ["name", "latitude"])
        self.assertEqual(len(recs), 1)

    def test_fullwidth_digits(self):
        self.assertEqual(c.clean(" 三条市１丁目２３ "), "三条市1丁目23")


class CoordTest(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(c.parse_coord("37.636", "138.96")[0], (37.636, 138.96))

    def test_missing(self):
        for v in ("", "-", "－"):
            self.assertEqual(c.parse_coord(v, v), (None, "座標なし"))

    def test_out_of_range(self):
        self.assertEqual(c.parse_coord("35.7", "139.6")[1], "三条市周辺の範囲外")
        self.assertEqual(c.parse_coord("40.66", "140.56")[1], "三条市周辺の範囲外")

    def test_southern_sanjo_is_kept(self):
        self.assertIsNotNone(c.parse_coord("37.45", "139.12")[0])

    def test_swapped_is_rejected(self):
        self.assertIsNone(c.parse_coord("138.96", "37.63")[0])

    def test_malformed_not_guessed(self):
        coord, reason = c.parse_coord("37.65852218473639,", "138.95")
        self.assertIsNone(coord)
        self.assertIn("形式不正", reason)

    def test_fullwidth(self):
        self.assertIsNotNone(c.parse_coord("３７.６", "１３８.９６")[0])


class MuniTest(unittest.TestCase):
    def test_neighbor_is_inside(self):
        key = c.coord_key(37.5297, 138.9136)
        coord, reason = c.parse_coord("37.5297", "138.9136", {key: "15211"})  # 見附市
        self.assertIsNotNone(coord)
        self.assertIsNone(reason)

    def test_non_neighbor_in_bbox_is_flagged(self):
        key = c.coord_key(37.45, 138.80)
        coord, reason = c.parse_coord("37.45", "138.80", {key: "15208"})  # 小千谷市
        self.assertIsNone(coord)
        self.assertIn("隣接自治体の範囲外", reason)

    def test_outside_japan_code_is_flagged(self):
        key = c.coord_key(37.5, 139.0)
        coord, reason = c.parse_coord("37.5", "139.0", {key: ""})
        self.assertIsNone(coord)

    def test_fallback_to_bbox_without_cache(self):
        self.assertIsNotNone(c.parse_coord("37.6", "138.9", {})[0])
        self.assertEqual(c.parse_coord("35.7", "139.6", {})[1], "三条市周辺の範囲外")


class GeocodeTest(unittest.TestCase):
    def test_query_cleaning(self):
        self.assertEqual(c.geocode_query("新潟県三条市本町三丁目(三条市歴史民俗産業資料館)ほか"), "新潟県三条市本町三丁目")
        self.assertEqual(c.geocode_query("新潟県三条市如法寺地内"), "新潟県三条市如法寺")
        self.assertEqual(c.geocode_query("新潟県三条市帯織ほか"), "新潟県三条市帯織")
        self.assertEqual(c.geocode_query("新潟県三条市八幡町など"), "新潟県三条市八幡町")

    def test_unlocatable(self):
        self.assertIsNone(c.geocode_query("新潟県三条市内"))
        self.assertIsNone(c.geocode_query("新潟県三条市"))
        self.assertIsNone(c.geocode_query("新潟県燕市吉田"))

    def test_layer_uses_cache_and_marks_approx(self):
        csv_text = ("項目No.,1\n項目名,NO,名称,文化財分類,種類,住所,所有者等,文化財指定日,概要,説明,備考\n"
                    ",1,A像,有形文化財,彫刻,新潟県三条市中新,寺,1950/8/29,国指定,国1,-\n"
                    ",2,B,記念物,史跡,新潟県三条市内,市,1950/8/29,市指定,市1,-\n"
                    ",3,C,記念物,史跡,新潟県三条市不明町,市,1950/8/29,市指定,市2,-\n")
        cache = {"新潟県三条市中新": {"lon": 138.994003, "lat": 37.610512, "title": "新潟県三条市中新"}}
        feats, total, excl = c.convert_layer("heritage", csv_text, None, cache)
        self.assertEqual((total, len(feats), len(excl)), (3, 1, 2))
        self.assertTrue(feats[0]["properties"]["approx"])
        self.assertEqual(feats[0]["geometry"]["coordinates"], [138.994003, 37.610512])
        self.assertEqual(sorted(e["reason"] for e in excl),
                         sorted(["住所が町丁目まで絞れない", "住所から位置を特定できない"]))


class DistrictsTest(unittest.TestCase):
    def setUp(self):
        import districts
        self.d = districts

    def test_normalize(self):
        n = self.d.normalize_name
        self.assertEqual(n("本町1丁目"), n("本町一丁目"))
        self.assertEqual(n("東裏館３丁目"), "東裏館三丁目")
        self.assertEqual(n("石上10丁目"), "石上十丁目")
        self.assertEqual(n("牛ケ島"), n("牛ヶ島"))

    def test_rings_outer_and_hole(self):
        outer = [(0, 0), (0, 10), (10, 10), (10, 0), (0, 0)]          # 時計回り
        hole = [(2, 2), (8, 2), (8, 8), (2, 8), (2, 2)]               # 反時計回り
        polys = self.d.rings_to_polygons([outer, hole, [(20, 0), (20, 1), (21, 1), (21, 0), (20, 0)]])
        self.assertEqual(len(polys), 2)
        self.assertEqual(len(polys[0]), 2)

    def test_build_with_alias_merge_and_unmatched(self):
        sq = [[(0, 0), (0, 1), (1, 1), (1, 0), (0, 0)]]
        areas = {
            self.d.normalize_name("本町一丁目"): {"polygons": [sq], "area_m2": 50000.0},
            self.d.normalize_name("北野新田"): {"polygons": [sq, sq], "area_m2": 200000.0},
        }
        recs = [
            {"行政区コード": "", "行政区名": "総数", "世帯数": "10", "人口(総数)": "300", "人口(男)": "1", "人口(女)": "1"},
            {"行政区コード": "1001", "行政区名": "本町1丁目", "世帯数": "75", "人口(総数)": "137", "人口(男)": "68", "人口(女)": "69"},
            {"行政区コード": "65000", "行政区名": "北野", "世帯数": "14", "人口(総数)": "43", "人口(男)": "19", "人口(女)": "24"},
            {"行政区コード": "9", "行政区名": "どこか", "世帯数": "1", "人口(総数)": "5", "人口(男)": "2", "人口(女)": "3"},
        ]
        feats, unmatched, unused = self.d.build_districts(recs, areas, {"北野": ["北野新田"]})
        self.assertEqual([f["properties"]["name"] for f in feats], ["本町1丁目", "北野"])
        self.assertEqual(feats[0]["properties"]["density"], 2740.0)   # 137 / 0.05km2
        self.assertEqual(feats[1]["properties"]["matched_as"], "北野新田")
        self.assertEqual(len(feats[1]["geometry"]["coordinates"]), 2)
        self.assertEqual([u["name"] for u in unmatched], ["どこか"])
        self.assertEqual(unused, [])

    @unittest.skipUnless(c.RAW_DIR.joinpath("boundary", "r2ka15204_shape.zip").exists(), "境界データがありません")
    def test_real_data(self):
        text, _, _ = c.decode_bytes((c.RAW_DIR / "000114894.csv").read_bytes())
        _, recs = c.parse_rows(text)
        import json
        aliases = json.loads(self.d.ALIASES_PATH.read_text(encoding="utf-8"))
        feats, unmatched, _ = self.d.build_districts(recs, self.d.load_areas(), aliases)
        self.assertGreaterEqual(len(feats), 240)
        self.assertEqual(len(feats) + len(unmatched), 254)
        for f in feats:
            for poly in f["geometry"]["coordinates"]:
                for ring in poly:
                    for x, y in ring:
                        self.assertTrue(138.5 < x < 139.5 and 37.3 < y < 37.9)


class WarekiTest(unittest.TestCase):
    def test_convert(self):
        self.assertEqual(c.wareki_to_iso("R7.4.7"), "2025-04-07")
        self.assertEqual(c.wareki_to_iso("R8.3.28"), "2026-03-28")
        self.assertEqual(c.wareki_to_iso("令和7年10月10日"), "2025-10-10")

    def test_invalid(self):
        self.assertIsNone(c.wareki_to_iso("不明"))
        self.assertIsNone(c.wareki_to_iso("R7.13.1"))


class LayerTest(unittest.TestCase):
    def test_toilet_format(self):
        csv_text = ("category,name,latitude,longitude,address\n"
                    "三条市上野原,公衆トイレ,37.621033,139.003894,三条市上野原 大崎山公園脇\n")
        feats, total, excl = c.convert_layer("toilet", csv_text)
        self.assertEqual((total, len(feats), len(excl)), (1, 1, 0))
        self.assertEqual(feats[0]["properties"]["name"], "公衆トイレ")
        self.assertEqual(feats[0]["geometry"]["coordinates"], [139.003894, 37.621033])

    def test_missing_rows_are_reported_not_output(self):
        csv_text = ("項目No.,1\n項目名,地区,緯度,経度,月日,時間,痕跡／目撃／事故,山間部／居住区,種別\n"
                    ",広手,37.5,138.98,R7.4.7,午後１時頃,痕跡,山間部,クマ\n"
                    ",荒沢,-,-,R7.5.23,午前9時頃,痕跡,山間部,クマ\n")
        feats, total, excl = c.convert_layer("bear", csv_text)
        self.assertEqual((total, len(feats), len(excl)), (2, 1, 1))
        self.assertEqual(excl[0]["reason"], "座標なし")
        self.assertEqual(feats[0]["properties"]["date"], "2025-04-07")

    def test_care_grouping(self):
        head = "項目名,介護サービス事業所名称,実施サービス,住所,緯度,経度,電話番号,備考\n"
        csv_text = ("項目No.,1\n" + head +
                    ",あすも,訪問看護,東裏館,37.6,138.96,-,-\n"
                    ",あすも,居宅介護支援,東裏館,37.6,138.96,-,-\n"
                    ",別施設,訪問介護,旭町,37.61,138.97,-,-\n")
        feats, total, _ = c.convert_layer("care", csv_text)
        self.assertEqual((total, len(feats)), (3, 2))
        self.assertEqual(feats[0]["properties"]["services"], ["訪問看護", "居宅介護支援"])

    def test_unsafe_url_dropped(self):
        csv_text = ("項目No.,1\n項目名,名称,種別,住所,緯度,経度,電話番号,URL\n"
                    ",A,B,addr,37.6,138.96,-,javascript:alert(1)\n")
        feats, _, _ = c.convert_layer("childcare", csv_text)
        self.assertNotIn("url", feats[0]["properties"])


@unittest.skipUnless((RAW / "000114890.csv").exists(), "data/raw がありません")
class RealDataTest(unittest.TestCase):
    def test_all_layers_convert_and_in_range(self):
        for layer_id, spec in c.LAYERS.items():
            text, _, _ = c.decode_bytes((RAW / spec["file"]).read_bytes())
            feats, total, excl = c.convert_layer(layer_id, text, None, c.load_geocode_cache())
            self.assertGreater(len(feats), 0, layer_id)
            if not spec.get("group"):
                self.assertEqual(len(feats) + len(excl), total, layer_id)
            for f in feats:
                lon, lat = f["geometry"]["coordinates"]
                self.assertTrue(c.LAT_RANGE[0] <= lat <= c.LAT_RANGE[1], layer_id)
                self.assertTrue(c.LON_RANGE[0] <= lon <= c.LON_RANGE[1], layer_id)

    def test_idempotent_json(self):
        text, _, _ = c.decode_bytes((RAW / "000114890.csv").read_bytes())
        a = json.dumps(c.convert_layer("shelter", text)[0], sort_keys=True)
        b = json.dumps(c.convert_layer("shelter", text)[0], sort_keys=True)
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
