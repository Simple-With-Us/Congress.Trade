"""Grid-form column fit and x-mark classification. No network, no OCR binary."""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gridform import (  # noqa: E402
    COLUMN_TEMPLATES,
    OFFICIAL_PTR_TEMPLATE,
    TYPE_P,
    TYPE_PARTIAL,
    TYPE_S,
    ClassifiedMarks,
    OcrBox,
    classify_mark_scores,
    clean_grid_asset_name,
    split_bare_ticker,
    expand_official_ptr_rules,
    fit_column_lines,
    fit_official_ptr_lines,
    read_grid_page,
    reading_order,
    row_bands,
    row_confidence,
    x_template_for_fit,
)


def test_fit_recovers_scaled_template():
    scale, offset = 0.72, 40
    detected = [int(round(offset + scale * value)) for value in COLUMN_TEMPLATES[0]]
    fit = fit_column_lines(detected)
    assert fit is not None
    assert fit.inliers == len(detected)
    assert 0.68 < fit.scale < 0.76


def test_unmarked_type_is_not_guessed():
    scores = [0.05] * 18
    scores[10 - 2] = 0.8
    marks = classify_mark_scores(scores)
    assert marks.tx_type is None
    assert marks.type_reason == "unmarked"
    assert marks.amount_letter == "B"


def test_tied_type_marks_stay_untyped():
    scores = [0.04] * 18
    scores[TYPE_P - 2] = 0.8
    scores[TYPE_S - 2] = 0.77
    marks = classify_mark_scores(scores)
    assert marks.tx_type is None
    assert marks.type_reason == "ambiguous"


def test_partial_sale_and_column_k():
    scores = [0.02] * 18
    scores[TYPE_PARTIAL - 2] = 0.9
    scores[19 - 2] = 0.88
    marks = classify_mark_scores(scores)
    assert marks.tx_type == "S"
    assert marks.partial is True
    assert marks.amount_reason == "column_k"
    assert marks.amount_min is None


def _stamp(gray: np.ndarray, glyph: np.ndarray, cx: int, cy: int) -> None:
    y0 = int(round(cy - glyph.shape[0] / 2))
    x0 = int(round(cx - glyph.shape[1] / 2))
    for y in range(glyph.shape[0]):
        for x in range(glyph.shape[1]):
            if glyph[y, x] < 128:
                dy, dx = y0 + y, x0 + x
                if 0 <= dy < gray.shape[0] and 0 <= dx < gray.shape[1]:
                    gray[dy, dx] = 0


def test_rendered_page_classifies_x_marks_and_refuses_empty_boxes():
    scale, offset = 0.72, 40.0
    xs = [int(round(offset + scale * value)) for value in COLUMN_TEMPLATES[0]]
    gray = np.full((900, xs[-1] + 30), 255, np.uint8)
    glyph = x_template_for_fit(scale)
    for x in xs:
        cv2.line(gray, (x, 160), (x, 780), 0, 2)
    rows = [
        (220, 300, "SP", "APPLE INC (AAPL)", "10/12/26", [TYPE_P, 9]),
        (460, 540, "SP", "WELLS FARGO FINANCE LLC", "10/15/26", [10]),
        (620, 700, "SP", "EXXON MOBIL CORP", "10/17/26", []),
    ]
    rules = {200, 760}
    boxes = []
    for y0, y1, owner, asset, tx_date, marks in rows:
        rules.add(y0)
        rules.add(y1)
        for column in range(2, 20):
            if column in (7, 8):
                continue
            cv2.rectangle(gray, (xs[column] + 6, y0 + 8), (xs[column + 1] - 6, y1 - 8), 0, 1)
        for column in marks:
            _stamp(gray, glyph, (xs[column] + xs[column + 1]) // 2, (y0 + y1) // 2)
        boxes.extend([
            OcrBox(xs[0] + 4, y0 + 20, xs[1] - 4, y0 + 40, owner, 0.95),
            OcrBox(xs[1] + 8, y0 + 16, xs[2] - 20, y0 + 40, asset, 0.92),
            OcrBox(xs[7] + 4, y0 + 18, xs[8] - 4, y0 + 42, tx_date, 0.9),
        ])
    for y in sorted(rules):
        cv2.line(gray, (xs[0], y), (xs[-1], y), 0, 1)

    read = read_grid_page(gray, boxes, page=2)
    assert read is not None
    by_name = {row.asset_name: row for row in read}
    assert by_name["APPLE INC (AAPL)"].tx_type == "B"
    assert by_name["APPLE INC (AAPL)"].amount_min == 1001
    assert by_name["APPLE INC (AAPL)"].warnings == []
    assert by_name["WELLS FARGO FINANCE LLC"].tx_type == ""
    assert "grid_type_unmarked" in by_name["WELLS FARGO FINANCE LLC"].warnings
    assert by_name["EXXON MOBIL CORP"].tx_type == ""
    assert "grid_type_unmarked" in by_name["EXXON MOBIL CORP"].warnings
    typed = sum(1 for row in read if row.tx_type in ("B", "S", "E"))
    held = sum(1 for row in read if "grid_type_unmarked" in row.warnings and row.tx_type == "")
    assert typed == 1
    assert held == 2
    assert typed + held == len(read)


def test_reading_order_and_form_splits_match_the_ts_cleaner():
    boxes = [
        OcrBox(80, 10, 120, 20, "INC", 0.9),
        OcrBox(10, 11, 70, 21, "WALMART", 0.9),
    ]
    assert reading_order(boxes) == "WALMART INC"
    assert clean_grid_asset_name("WALMARTINC CMN") == "WALMART INC CMN"
    assert clean_grid_asset_name("EATONCORPPLCCMN") == "EATON CORP PLC CMN"
    assert clean_grid_asset_name("WELLS FARGO FINANCE LLCLINKED TO SQPSODINDEX") == "WELLS FARGO FINANCE LLC LINKED TO S&P 500 INDEX"
    assert clean_grid_asset_name("SP 500 SP FUND") == "S&P 500 SP FUND"
    assert clean_grid_asset_name("SP FUND SP 500") == "SP FUND S&P 500"
    assert clean_grid_asset_name("PEPSICO INC CMN") == "PEPSICO INC CMN"


def test_fallback_confidence_includes_asset_text():
    marks = ClassifiedMarks("B", False, False, None, None, None, "ok", "unmarked", 0.5, 0.0)
    low = row_confidence(marks, 0.0, False, "APPLE INC")
    high = row_confidence(marks, 1.0, False, "APPLE INC")
    assert abs((high - low) - 0.08) < 1e-9
    assert row_confidence(marks, 0.5, False, "A") == low


def test_gray_halo_stays_under_the_150_band_cutoff():
    xs = [0, 40, 200, 260, 320, 380, 440, 500, 560, 620, 680, 740, 800]
    gray = np.full((300, 900), 255, np.uint8)
    for y in (40, 110, 180):
        gray[y, 500:800] = 0
    lattice = list(range(500, 800, 4))[:66]
    for y in range(300):
        if y in (40, 110, 180):
            continue
        gray[y, lattice] = 160
    bands, section_bars = row_bands(gray, xs)
    assert section_bars == 0
    assert len(bands) == 2


def test_official_ptr_fit_rejects_a_schedule_page():
    noisy = sorted([*OFFICIAL_PTR_TEMPLATE, 400, 510])
    fit = fit_official_ptr_lines(noisy)
    assert fit is not None
    assert fit.kind == "official"
    assert fit.inliers == len(OFFICIAL_PTR_TEMPLATE)
    expanded = expand_official_ptr_rules(OFFICIAL_PTR_TEMPLATE)
    assert fit.xs[9] == expanded[9]
    schedule = [int(round(value * 0.5)) for value in COLUMN_TEMPLATES[0]]
    assert fit_official_ptr_lines(schedule) is None
    shrunk = [int(round(value * 0.92)) for value in OFFICIAL_PTR_TEMPLATE]
    assert fit_official_ptr_lines(shrunk) is None
    assert clean_grid_asset_name("SPDR SER TR S&P AEROSPACE & DEFENSE") == "SPDR SER TR S&P AEROSPACE & DEFENSE"
    assert split_bare_ticker("US TREASURY NOTE", 1) == (None, "US TREASURY NOTE")
    assert split_bare_ticker("COCA COLA", 1) == (None, "COCA COLA")
    assert split_bare_ticker("SPDR Ser Tr S&P Aerospace & Defense XAR", 1) == (
        "XAR",
        "SPDR Ser Tr S&P Aerospace & Defense",
    )
