#!/usr/bin/env python3
"""Unit tests for vision-worker cascade helpers. No network."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import worker  # noqa: E402


WAGNER_PTR = {
    "transactions": [
        {
            "owner": "joint",
            "asset": "Dallas TX ISD 5% 2/15/2031",
            "ticker": None,
            "txType": "P",
            "txDate": "2025-01-21",
            "notifDate": "2025-01-22",
            "amountMin": 100001,
            "amountMax": 250000,
            "bracket": "D",
            "note": None,
        },
        {
            "owner": "joint",
            "asset": "Pecos Barstow Toyah TX 4% 2/15/2030",
            "ticker": None,
            "txType": "P",
            "txDate": "2025-01-21",
            "notifDate": "2025-01-22",
            "amountMin": 100001,
            "amountMax": 250000,
            "bracket": "D",
            "note": "first word on the scan can read as Pecis",
        },
    ]
}


class CascadeHelpersTest(unittest.TestCase):
    def test_default_cascade_is_qwen_then_gemini_then_grok(self):
        previous = worker.OPENROUTER_CASCADE_MODELS
        previous_model = worker.OPENROUTER_MODEL
        try:
            worker.OPENROUTER_CASCADE_MODELS = worker.DEFAULT_CASCADE_MODELS
            worker.OPENROUTER_MODEL = "x-ai/grok-4.6"
            models = worker.cascade_model_list()
            self.assertEqual(models[0], "qwen/qwen3-vl-8b-instruct")
            self.assertEqual(models[1], "qwen/qwen3-vl-30b-a3b-instruct")
            self.assertIn("google/gemini-3.8-flash", models)
            self.assertEqual(models[-1], "x-ai/grok-4.6")
            self.assertEqual(len(models), len(set(models)))
        finally:
            worker.OPENROUTER_CASCADE_MODELS = previous
            worker.OPENROUTER_MODEL = previous_model

    def test_cascade_env_override_dedupes_and_appends_grok(self):
        previous = worker.OPENROUTER_CASCADE_MODELS
        try:
            worker.OPENROUTER_CASCADE_MODELS = "qwen/qwen3-vl-8b-instruct, x-ai/grok-4.6, qwen/qwen3-vl-8b-instruct"
            models = worker.cascade_model_list()
            self.assertEqual(models, ["qwen/qwen3-vl-8b-instruct", "x-ai/grok-4.6"])
        finally:
            worker.OPENROUTER_CASCADE_MODELS = previous

    def test_qwen_uses_page_images_grok_and_gemini_do_not(self):
        self.assertTrue(worker.model_uses_page_images("qwen/qwen3-vl-8b-instruct"))
        self.assertTrue(worker.model_uses_page_images("qwen/qwen3-vl-30b-a3b-instruct"))
        self.assertFalse(worker.model_uses_page_images("x-ai/grok-4.6"))
        self.assertFalse(worker.model_uses_page_images("google/gemini-3.8-flash"))

    def test_truncated_qwen_hit_is_not_terminal(self):
        # 10-page PTR, Qwen only receives OPENROUTER_CASCADE_MAX_PAGES (8).
        # Accepting that hit would publish at 0.97 and lock pages 9-10 out.
        self.assertFalse(
            worker.cascade_hit_is_terminal("qwen/qwen3-vl-8b-instruct", 10, 10),
        )
        self.assertFalse(
            worker.cascade_hit_is_terminal("qwen/qwen3-vl-8b-instruct", 20, 12),
        )
        self.assertTrue(
            worker.cascade_hit_is_terminal("qwen/qwen3-vl-8b-instruct", 2, 2),
        )
        self.assertTrue(
            worker.cascade_hit_is_terminal("qwen/qwen3-vl-8b-instruct", 8, 8),
        )
        self.assertTrue(
            worker.cascade_hit_is_terminal("google/gemini-3.8-flash", 20, 12),
        )
        self.assertTrue(
            worker.cascade_hit_is_terminal("x-ai/grok-4.6", 20, 12),
        )

    def test_extractor_label_is_stable(self):
        self.assertEqual(
            worker.extractor_label_for_model("qwen/qwen3-vl-8b-instruct"),
            "openrouter_qwen_qwen3_vl_8b_instruct",
        )


class TruncatedCascadeTest(unittest.TestCase):
    def test_transcribe_continues_past_truncated_qwen_to_pdf_native(self):
        previous_key = worker.OPENROUTER_API_KEY
        previous_engine = worker.VISION_ENGINE
        previous_cascade = worker.OPENROUTER_CASCADE_MODELS
        previous_model = worker.OPENROUTER_MODEL
        called: list[str] = []

        def fake_openrouter(_pdf, _pages, _filing, model, _work_dir):
            called.append(model)
            if worker.model_uses_page_images(model):
                return [{"assetName": "Dallas TX ISD 5% 2/15/2031", "txType": "P"}]
            if "gemini" in model:
                return [
                    {"assetName": "Dallas TX ISD 5% 2/15/2031", "txType": "P"},
                    {"assetName": "page-10 bond", "txType": "P"},
                ]
            return None

        worker.OPENROUTER_API_KEY = "test-key"
        worker.VISION_ENGINE = "openrouter"
        worker.OPENROUTER_CASCADE_MODELS = worker.DEFAULT_CASCADE_MODELS
        worker.OPENROUTER_MODEL = "x-ai/grok-4.6"
        original = worker.transcribe_with_openrouter
        worker.transcribe_with_openrouter = fake_openrouter
        try:
            rows, label = worker.transcribe(
                "/tmp/filing.pdf",
                [f"/tmp/page-{i}.png" for i in range(10)],
                {"doc_id": "wagner-long", "chamber": "house", "filed_date": "2025-02-14"},
                "/tmp",
                total_pages=10,
            )
        finally:
            worker.transcribe_with_openrouter = original
            worker.OPENROUTER_API_KEY = previous_key
            worker.VISION_ENGINE = previous_engine
            worker.OPENROUTER_CASCADE_MODELS = previous_cascade
            worker.OPENROUTER_MODEL = previous_model

        self.assertEqual(called[0], "qwen/qwen3-vl-8b-instruct")
        self.assertEqual(called[1], "qwen/qwen3-vl-30b-a3b-instruct")
        self.assertIn("google/gemini-3.8-flash", called)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]["assetName"], "page-10 bond")
        self.assertEqual(label, worker.extractor_label_for_model("google/gemini-3.8-flash"))

    def test_short_qwen_hit_stays_terminal(self):
        previous_key = worker.OPENROUTER_API_KEY
        previous_engine = worker.VISION_ENGINE
        previous_cascade = worker.OPENROUTER_CASCADE_MODELS
        called: list[str] = []

        def fake_openrouter(_pdf, _pages, _filing, model, _work_dir):
            called.append(model)
            return [{"assetName": "Dallas TX ISD 5% 2/15/2031", "txType": "P"}]

        worker.OPENROUTER_API_KEY = "test-key"
        worker.VISION_ENGINE = "openrouter"
        worker.OPENROUTER_CASCADE_MODELS = worker.DEFAULT_CASCADE_MODELS
        original = worker.transcribe_with_openrouter
        worker.transcribe_with_openrouter = fake_openrouter
        try:
            rows, label = worker.transcribe(
                "/tmp/filing.pdf",
                ["/tmp/page-1.png", "/tmp/page-2.png"],
                {"doc_id": "wagner-short", "chamber": "house"},
                "/tmp",
                total_pages=2,
            )
        finally:
            worker.transcribe_with_openrouter = original
            worker.OPENROUTER_API_KEY = previous_key
            worker.VISION_ENGINE = previous_engine
            worker.OPENROUTER_CASCADE_MODELS = previous_cascade

        self.assertEqual(called, ["qwen/qwen3-vl-8b-instruct"])
        self.assertEqual(len(rows), 1)
        self.assertEqual(label, worker.extractor_label_for_model("qwen/qwen3-vl-8b-instruct"))


class TruncatedLocalCliTest(unittest.TestCase):
    def test_truncated_local_cli_continues_to_pdf_native(self):
        previous_key = worker.OPENROUTER_API_KEY
        previous_engine = worker.VISION_ENGINE
        previous_cascade = worker.OPENROUTER_CASCADE_MODELS
        previous_model = worker.OPENROUTER_MODEL
        called: list[str] = []

        def fake_cli(_pages, _filing):
            return [{"assetName": "page-1 stock", "txType": "P"}]

        def fake_openrouter(_pdf, _pages, _filing, model, _work_dir):
            called.append(model)
            if worker.model_uses_page_images(model):
                return [{"assetName": "should-not-run", "txType": "P"}]
            return [
                {"assetName": "page-1 stock", "txType": "P"},
                {"assetName": "page-20 stock", "txType": "P"},
            ]

        worker.OPENROUTER_API_KEY = "test-key"
        worker.VISION_ENGINE = "auto"
        worker.OPENROUTER_CASCADE_MODELS = worker.DEFAULT_CASCADE_MODELS
        worker.OPENROUTER_MODEL = "x-ai/grok-4.6"
        original_cli = worker.transcribe_with_local_cli
        original_or = worker.transcribe_with_openrouter
        worker.transcribe_with_local_cli = fake_cli
        worker.transcribe_with_openrouter = fake_openrouter
        try:
            rows, label = worker.transcribe(
                "/tmp/filing.pdf",
                [f"/tmp/page-{i}.png" for i in range(12)],
                {"doc_id": "long-ptr", "chamber": "house", "filed_date": "2025-02-14"},
                "/tmp",
                total_pages=20,
            )
        finally:
            worker.transcribe_with_local_cli = original_cli
            worker.transcribe_with_openrouter = original_or
            worker.OPENROUTER_API_KEY = previous_key
            worker.VISION_ENGINE = previous_engine
            worker.OPENROUTER_CASCADE_MODELS = previous_cascade
            worker.OPENROUTER_MODEL = previous_model

        self.assertEqual(called[0], "google/gemini-3.8-flash")
        self.assertNotIn("qwen/qwen3-vl-8b-instruct", called)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]["assetName"], "page-20 stock")
        self.assertEqual(label, worker.extractor_label_for_model("google/gemini-3.8-flash"))

    def test_complete_local_cli_stays_terminal(self):
        previous_key = worker.OPENROUTER_API_KEY
        previous_engine = worker.VISION_ENGINE
        called: list[str] = []

        def fake_cli(_pages, _filing):
            return [{"assetName": "Dallas TX ISD 5% 2/15/2031", "txType": "P"}]

        def fake_openrouter(_pdf, _pages, _filing, model, _work_dir):
            called.append(model)
            return [{"assetName": "should-not-run", "txType": "P"}]

        worker.OPENROUTER_API_KEY = "test-key"
        worker.VISION_ENGINE = "auto"
        original_cli = worker.transcribe_with_local_cli
        original_or = worker.transcribe_with_openrouter
        worker.transcribe_with_local_cli = fake_cli
        worker.transcribe_with_openrouter = fake_openrouter
        try:
            rows, label = worker.transcribe(
                "/tmp/filing.pdf",
                [f"/tmp/page-{i}.png" for i in range(8)],
                {"doc_id": "short-ptr", "chamber": "house"},
                "/tmp",
                total_pages=8,
            )
        finally:
            worker.transcribe_with_local_cli = original_cli
            worker.transcribe_with_openrouter = original_or
            worker.OPENROUTER_API_KEY = previous_key
            worker.VISION_ENGINE = previous_engine

        self.assertEqual(called, [])
        self.assertEqual(len(rows), 1)
        self.assertEqual(label, "local_grok_cli_v1")

    def test_local_cli_engine_keeps_truncated_hit(self):
        previous_engine = worker.VISION_ENGINE
        called: list[str] = []

        def fake_cli(_pages, _filing):
            return [{"assetName": "page-1 stock", "txType": "P"}]

        def fake_openrouter(_pdf, _pages, _filing, model, _work_dir):
            called.append(model)
            return [{"assetName": "should-not-run", "txType": "P"}]

        worker.VISION_ENGINE = "local_cli"
        original_cli = worker.transcribe_with_local_cli
        original_or = worker.transcribe_with_openrouter
        worker.transcribe_with_local_cli = fake_cli
        worker.transcribe_with_openrouter = fake_openrouter
        try:
            rows, label = worker.transcribe(
                "/tmp/filing.pdf",
                [f"/tmp/page-{i}.png" for i in range(12)],
                {"doc_id": "local-only", "chamber": "house"},
                "/tmp",
                total_pages=20,
            )
        finally:
            worker.transcribe_with_local_cli = original_cli
            worker.transcribe_with_openrouter = original_or
            worker.VISION_ENGINE = previous_engine

        self.assertEqual(called, [])
        self.assertEqual(len(rows), 1)
        self.assertEqual(label, "local_grok_cli_v1")

    def test_auto_skips_local_cli_when_over_max_pages(self):
        previous_key = worker.OPENROUTER_API_KEY
        previous_engine = worker.VISION_ENGINE
        previous_cascade = worker.OPENROUTER_CASCADE_MODELS
        previous_model = worker.OPENROUTER_MODEL
        called: list[str] = []
        cli_called = {"n": 0}

        def fake_cli(_pages, _filing):
            cli_called["n"] += 1
            return [{"assetName": "should-not-run", "txType": "P"}]

        def fake_openrouter(_pdf, _pages, _filing, model, _work_dir):
            called.append(model)
            if worker.model_uses_page_images(model):
                return [{"assetName": "qwen-truncated", "txType": "P"}]
            return [{"assetName": "page-20 stock", "txType": "P"}]

        worker.OPENROUTER_API_KEY = "test-key"
        worker.VISION_ENGINE = "auto"
        worker.OPENROUTER_CASCADE_MODELS = worker.DEFAULT_CASCADE_MODELS
        worker.OPENROUTER_MODEL = "x-ai/grok-4.6"
        original_cli = worker.transcribe_with_local_cli
        original_or = worker.transcribe_with_openrouter
        worker.transcribe_with_local_cli = fake_cli
        worker.transcribe_with_openrouter = fake_openrouter
        try:
            rows, label = worker.transcribe(
                "/tmp/filing.pdf",
                [f"/tmp/page-{i}.png" for i in range(12)],
                {"doc_id": "khanna-24p", "chamber": "house"},
                "/tmp",
                total_pages=24,
            )
        finally:
            worker.transcribe_with_local_cli = original_cli
            worker.transcribe_with_openrouter = original_or
            worker.OPENROUTER_API_KEY = previous_key
            worker.VISION_ENGINE = previous_engine
            worker.OPENROUTER_CASCADE_MODELS = previous_cascade
            worker.OPENROUTER_MODEL = previous_model

        self.assertEqual(cli_called["n"], 0)
        self.assertEqual(called[0], "google/gemini-3.8-flash")
        self.assertNotIn("qwen/qwen3-vl-8b-instruct", called)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["assetName"], "page-20 stock")
        self.assertEqual(label, worker.extractor_label_for_model("google/gemini-3.8-flash"))

    def test_pdf_native_chunk_miss_is_not_terminal(self):
        calls = {"n": 0}

        def fake_split(_pdf, _work, _n):
            return ["/tmp/chunk-00.pdf", "/tmp/chunk-01.pdf", "/tmp/chunk-02.pdf"]

        def fake_one(_pdf, _pages, _filing, _model, _work, prompt_extra=""):
            calls["n"] += 1
            if calls["n"] == 2:
                return None
            return [{"assetName": f"chunk-{calls['n']} stock", "txType": "P"}]

        original_split = worker.split_pdf_chunks
        original_one = worker.transcribe_openrouter_one
        original_pdfinfo = worker.pdfinfo_pages
        worker.split_pdf_chunks = fake_split
        worker.transcribe_openrouter_one = fake_one
        worker.pdfinfo_pages = lambda _p: 10
        try:
            rows = worker.transcribe_pdf_native_chunked(
                "/tmp/filing.pdf",
                {"doc_id": "khanna-24p", "chamber": "house"},
                "google/gemini-3.8-flash",
                "/tmp",
                24,
            )
        finally:
            worker.split_pdf_chunks = original_split
            worker.transcribe_openrouter_one = original_one
            worker.pdfinfo_pages = original_pdfinfo

        self.assertIsNone(rows)
        self.assertEqual(calls["n"], 2)

    def test_pdf_native_empty_cover_chunk_still_merges(self):
        calls = {"n": 0}

        def fake_split(_pdf, _work, _n):
            return ["/tmp/chunk-00.pdf", "/tmp/chunk-01.pdf"]

        def fake_one(_pdf, _pages, _filing, _model, _work, prompt_extra=""):
            calls["n"] += 1
            if calls["n"] == 1:
                return []
            return [{"assetName": "page-20 stock", "txType": "P"}]

        original_split = worker.split_pdf_chunks
        original_one = worker.transcribe_openrouter_one
        original_pdfinfo = worker.pdfinfo_pages
        worker.split_pdf_chunks = fake_split
        worker.transcribe_openrouter_one = fake_one
        worker.pdfinfo_pages = lambda _p: 10
        try:
            rows = worker.transcribe_pdf_native_chunked(
                "/tmp/filing.pdf",
                {"doc_id": "khanna-cover", "chamber": "house"},
                "google/gemini-3.8-flash",
                "/tmp",
                20,
            )
        finally:
            worker.split_pdf_chunks = original_split
            worker.transcribe_openrouter_one = original_one
            worker.pdfinfo_pages = original_pdfinfo

        self.assertIsNotNone(rows)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["assetName"], "page-20 stock")
        self.assertEqual(calls["n"], 2)


class ParseAndValidateTest(unittest.TestCase):
    def test_wagner_ptr_gold_two_joint_muni_purchases(self):
        blob = json.dumps(WAGNER_PTR)
        parsed = worker.parse_model_json("Here you go\n" + blob)
        rows = worker.rows_from_parsed(parsed)
        self.assertIsNotNone(rows)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["assetName"], "Dallas TX ISD 5% 2/15/2031")
        self.assertEqual(rows[0]["txType"], "P")
        self.assertEqual(rows[0]["owner"], "joint")
        self.assertEqual(rows[0]["amountMin"], 100001)
        self.assertEqual(rows[0]["amountMax"], 250000)
        self.assertEqual(rows[1]["assetName"], "Pecos Barstow Toyah TX 4% 2/15/2030")
        self.assertEqual(rows[1]["txDate"], "2025-01-21")
        self.assertEqual(rows[1]["description"], "first word on the scan can read as Pecis")

    def test_zero_rows_without_norows_is_a_miss(self):
        miss = worker.rows_or_miss({"transactions": []}, "test")
        self.assertIsNone(miss)
        empty = worker.rows_or_miss({"transactions": [], "noRows": True}, "test")
        self.assertEqual(empty, [])

    def test_openrouter_qwen_content_is_images_not_pdf(self):
        with tempfile.TemporaryDirectory() as td:
            page = os.path.join(td, "page-1.png")
            import struct
            import zlib

            def png_chunk(tag: bytes, data: bytes) -> bytes:
                crc = zlib.crc32(tag + data) & 0xFFFFFFFF
                return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

            raw = b"\x00\x00\x00\x00"
            Path(page).write_bytes(
                b"\x89PNG\r\n\x1a\n"
                + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
                + png_chunk(b"IDAT", zlib.compress(raw))
                + png_chunk(b"IEND", b"")
            )
            parts = worker.openrouter_user_content(
                "transcribe",
                os.path.join(td, "missing.pdf"),
                [page],
                "qwen/qwen3-vl-8b-instruct",
                td,
            )
            self.assertIsNotNone(parts)
            kinds = [p.get("type") for p in parts]
            self.assertIn("image_url", kinds)
            self.assertNotIn("file", kinds)
            self.assertEqual(parts[-1]["type"], "text")


class UprightRotateTest(unittest.TestCase):
    def _png(self, path: str, width: int, height: int) -> str:
        from PIL import Image
        Image.new("RGB", (width, height), (240, 240, 240)).save(path)
        return path

    def test_landscape_page_stays_unrotated(self):
        with tempfile.TemporaryDirectory() as td:
            page = self._png(os.path.join(td, "page-1.png"), 40, 20)
            self.assertEqual(worker.choose_upright_cw_degrees(page, score_fn=lambda _p: 9), 0)

    def test_portrait_prefers_the_higher_tesseract_score(self):
        with tempfile.TemporaryDirectory() as td:
            page = self._png(os.path.join(td, "page-1.png"), 20, 40)

            def score(path: str) -> int:
                return 5 if path.endswith(".rot90.png") else 1

            self.assertEqual(worker.choose_upright_cw_degrees(page, score_fn=score), 90)

    def test_portrait_prefers_unrotated_when_it_scores_highest(self):
        with tempfile.TemporaryDirectory() as td:
            page = self._png(os.path.join(td, "page-1.png"), 20, 40)

            def score(path: str) -> int:
                return 0 if ".rot" in os.path.basename(path) else 4

            self.assertEqual(worker.choose_upright_cw_degrees(page, score_fn=score), 0)

    def test_portrait_stays_put_when_ocr_is_silent(self):
        with tempfile.TemporaryDirectory() as td:
            page = self._png(os.path.join(td, "page-1.png"), 20, 40)
            self.assertEqual(worker.choose_upright_cw_degrees(page, score_fn=lambda _p: 0), 0)

    def test_upright_pages_leaves_silent_portrait_alone(self):
        with tempfile.TemporaryDirectory() as td:
            pages = [
                self._png(os.path.join(td, "page-1.png"), 20, 40),
                self._png(os.path.join(td, "page-2.png"), 20, 40),
            ]
            worker.upright_pages(pages, score_fn=lambda _p: 0)
            from PIL import Image
            for path in pages:
                with Image.open(path) as im:
                    self.assertEqual(im.size, (20, 40))

    def test_landscape_sibling_is_not_rotated_when_cover_spins(self):
        with tempfile.TemporaryDirectory() as td:
            cover = self._png(os.path.join(td, "page-1.png"), 20, 40)
            grid = self._png(os.path.join(td, "page-2.png"), 40, 20)

            def score(path: str) -> int:
                return 6 if path.endswith(".rot270.png") else 0

            worker.upright_pages([cover, grid], score_fn=score)
            from PIL import Image
            with Image.open(cover) as im:
                self.assertEqual(im.size, (40, 20))
            with Image.open(grid) as im:
                self.assertEqual(im.size, (40, 20))

    def test_write_upright_pdf_includes_pages_past_cli_cap(self):
        with tempfile.TemporaryDirectory() as td:
            pages = [
                self._png(os.path.join(td, "page-1.png"), 20, 40),
                self._png(os.path.join(td, "page-2.png"), 20, 40),
                self._png(os.path.join(td, "page-13.png"), 20, 40),
            ]
            dest = os.path.join(td, "upright.pdf")
            written = worker.write_upright_pdf(pages, dest)
            self.assertEqual(written, dest)
            with open(dest, "rb") as f:
                magic = f.read(5)
            self.assertEqual(magic, b"%PDF-")
            self.assertGreater(os.path.getsize(dest), 200)

    def test_native_cascade_prefers_upright_rebuild(self):
        with tempfile.TemporaryDirectory() as td:
            original = os.path.join(td, "filing.pdf")
            upright = os.path.join(td, "upright.pdf")
            Path(original).write_bytes(b"%PDF-1.4 sideways")
            Path(upright).write_bytes(b"%PDF-1.4 upright-pages")
            self.assertEqual(worker.native_cascade_pdf(original, upright), upright)
            self.assertEqual(worker.native_cascade_pdf(original, None), original)
            self.assertEqual(
                worker.native_cascade_pdf(original, os.path.join(td, "missing.pdf")),
                original,
            )


class IsolatedGrokCliTest(unittest.TestCase):
    def test_turns_scale_with_page_count(self):
        previous = worker.GROK_CLI_MAX_TURNS
        try:
            worker.GROK_CLI_MAX_TURNS = 16
            self.assertEqual(worker.grok_cli_max_turns(1), 16)
            self.assertEqual(worker.grok_cli_max_turns(4), 16)
            self.assertEqual(worker.grok_cli_max_turns(8), 20)
            self.assertEqual(worker.grok_cli_max_turns(20), 32)
        finally:
            worker.GROK_CLI_MAX_TURNS = previous

    def test_clean_asset_strips_sell_and_ticker_parens(self):
        name, ticker = worker.clean_asset_name("Sell Vng Growth Index @ 473.42 (VUG)")
        self.assertEqual(name, "Vng Growth Index @ 473.42")
        self.assertEqual(ticker, "VUG")
        name, ticker = worker.clean_asset_name("Dallas TX ISD 5% 2/15/2031")
        self.assertEqual(name, "Dallas TX ISD 5% 2/15/2031")
        self.assertIsNone(ticker)

    def test_validate_rows_drops_handwritten_sell_prefix(self):
        rows = worker.validate_rows([{
            "owner": "self",
            "asset": "Sell Vng Growth Index @ 473.42",
            "txType": "S",
            "txDate": "2025-09-26",
            "amountMin": 1000,
            "amountMax": 15000,
            "bracket": "A",
        }])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["assetName"], "Vng Growth Index @ 473.42")
        self.assertEqual(rows[0]["txType"], "S")

    def test_validate_rows_keeps_short_ticker_after_verb_strip(self):
        """#2165 clean_asset_name + len<3 dropped Sell BA / Buy F / S GE."""
        rows = worker.validate_rows([
            {
                "owner": "self",
                "asset": "Sell BA",
                "txType": "S",
                "txDate": "2025-09-26",
                "amountMin": 1001,
                "amountMax": 15000,
            },
            {
                "owner": "self",
                "asset": "Buy F",
                "txType": "P",
                "txDate": "2025-09-26",
                "amountMin": 1001,
                "amountMax": 15000,
            },
            {
                "owner": "self",
                "asset": "S GE",
                "txType": "S",
                "txDate": "2025-09-26",
                "amountMin": 1001,
                "amountMax": 15000,
            },
        ])
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["assetName"], "BA")
        self.assertEqual(rows[0]["ticker"], "BA")
        self.assertEqual(rows[0]["txType"], "S")
        self.assertEqual(rows[1]["assetName"], "F")
        self.assertEqual(rows[1]["ticker"], "F")
        self.assertEqual(rows[2]["assetName"], "GE")
        self.assertEqual(rows[2]["ticker"], "GE")

    def test_local_cli_cmd_isolates_cwd_and_caps_reasoning(self):
        with tempfile.TemporaryDirectory() as td:
            previous_cwd = worker.GROK_CWD
            previous_effort = worker.GROK_CLI_REASONING_EFFORT
            try:
                worker.GROK_CWD = os.path.join(td, "grok-cwd")
                worker.GROK_CLI_REASONING_EFFORT = "medium"
                pages = [os.path.join(td, f"page-{i}.png") for i in range(1, 5)]
                cmd = worker.build_local_cli_cmd(
                    pages,
                    {"chamber": "house", "filed_date": "2025-10-16"},
                )
            finally:
                worker.GROK_CWD = previous_cwd
                worker.GROK_CLI_REASONING_EFFORT = previous_effort
            joined = " ".join(cmd)
            self.assertIn("--cwd", cmd)
            self.assertIn("--no-plan", cmd)
            self.assertIn("--reasoning-effort", cmd)
            self.assertIn("medium", cmd)
            self.assertIn("--json-schema", cmd)
            self.assertIn("--system-prompt-override", cmd)
            self.assertIn("--max-turns", cmd)
            turns = cmd[cmd.index("--max-turns") + 1]
            self.assertEqual(turns, "16")
            self.assertTrue(os.path.isdir(os.path.join(td, "grok-cwd")))
            self.assertNotIn("Congress.Trade", joined)

    def test_mark_doc_done_skips_later_polls(self):
        previous = worker.STATE_FILE
        with tempfile.TemporaryDirectory() as td:
            worker.STATE_FILE = os.path.join(td, "state.json")
            try:
                state = {"docs": {}}
                worker.mark_doc_done(state, "H-2025-9115689", "published")
                entry = state["docs"]["H-2025-9115689"]
                self.assertTrue(entry["completed"])
                self.assertTrue(entry["review_submitted"])
            finally:
                worker.STATE_FILE = previous


if __name__ == "__main__":
    unittest.main()
