"""Grid-form column fit and x-mark classification. No network, no OCR binary."""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gridform import (  # noqa: E402
    COLUMN_TEMPLATES,
    TYPE_P,
    TYPE_PARTIAL,
    TYPE_S,
    OcrBox,
    canonical_x_template,
    classify_mark_scores,
    fit_column_lines,
    read_grid_page,
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
    glyph = cv2.resize(
        canonical_x_template(),
        (max(3, int(round(19 * scale))), max(3, int(round(21 * scale)))),
    )
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
