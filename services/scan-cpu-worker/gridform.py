"""Hand-delivered House PTR grid reader.

Fits the printed column rules, template-matches x marks, and leaves a row
with no single type mark untyped. The thresholds match
app/src/extraction/houseGridForm.ts. Text OCR stays on the worker's existing
CPU backend. This module does not call a vision model.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

COLUMN_TEMPLATES: Tuple[Tuple[int, ...], ...] = (
    (217, 328, 865, 959, 1016, 1113, 1212, 1336, 1503, 1677, 1788, 1898, 1992, 2083, 2175, 2285, 2391, 2509, 2739, 2854, 3122),
    (216, 327, 834, 930, 984, 1079, 1171, 1290, 1469, 1655, 1757, 1862, 1956, 2045, 2137, 2245, 2344, 2458, 2679, 2797, 3046),
    (219, 331, 861, 955, 1010, 1105, 1202, 1321, 1481, 1648, 1758, 1859, 1948, 2036, 2125, 2233, 2336, 2453, 2668, 2783, 3033),
    (278, 395, 939, 1037, 1093, 1195, 1300, 1426, 1604, 1777, 1892, 2009, 2104, 2200, 2296, 2405, 2517, 2645, 2771, 2893, 3023),
)

# Purchase, sale, exchange, capital gains, partial. Printed header order.
TYPE_P, TYPE_S, TYPE_E, TYPE_CG, TYPE_PARTIAL = 2, 3, 4, 5, 6
AMOUNT_COLUMNS: Tuple[Tuple[int, str, Optional[int], Optional[int]], ...] = (
    (9, "A", 1001, 15000),
    (10, "B", 15001, 50000),
    (11, "C", 50001, 100000),
    (12, "D", 100001, 250000),
    (13, "E", 250001, 500000),
    (14, "F", 500001, 1000000),
    (15, "G", 1000001, 5000000),
    (16, "H", 5000001, 25000000),
    (17, "I", 25000001, 50000000),
    (18, "J", 50000001, None),
    (19, "K", None, None),
)
MARK_SCORE_MIN = 0.45
MARK_AMBIGUITY_GAP = 0.08
GRID_MIN_INLIERS = 14
GRID_STRONG_MARK = 0.55
DATE_RE = re.compile(r"^\D{0,2}(\d{1,2})\s*[/l1I|]\s*(\d{1,2})\s*[/l1I|]\s*(\d{2,4})\D{0,3}$")


@dataclass
class ColumnFit:
    scale: float
    offset: float
    xs: List[int]
    inliers: int


@dataclass
class ClassifiedMarks:
    tx_type: Optional[str]
    partial: bool
    cap_gains: bool
    amount_min: Optional[int]
    amount_max: Optional[int]
    amount_letter: Optional[str]
    type_reason: str
    amount_reason: str
    type_score: float
    amount_score: float


@dataclass
class GridRow:
    asset_name: str
    owner: Optional[str]
    tx_type: str
    tx_date: Optional[str]
    notif_date: Optional[str]
    amount_min: Optional[int]
    amount_max: Optional[int]
    confidence: float
    raw_text: str
    note: str
    warnings: List[str] = field(default_factory=list)
    cap_gains: bool = False
    is_option: bool = False
    ticker: Optional[str] = None


@dataclass
class OcrBox:
    x0: int
    y0: int
    x1: int
    y1: int
    text: str
    conf: float


# Printed checkbox x at X_GLYPH_REFERENCE_SCALE of the column templates.
X_GLYPH = (
    "#....#.",
    "##..##.",
    "######.",
    ".####..",
    ".####..",
    ".####..",
    ".#####.",
    "##..###",
    "#...###",
    ".....#.",
)
X_GLYPH_REFERENCE_SCALE = 0.667


def canonical_x_template() -> np.ndarray:
    height, width = len(X_GLYPH), len(X_GLYPH[0])
    image = np.full((height, width), 255, np.uint8)
    for y, row in enumerate(X_GLYPH):
        for x, ch in enumerate(row):
            if ch == "#":
                image[y, x] = 0
    return image


def x_template_for_fit(fit_scale: float) -> np.ndarray:
    clamped = min(1.4, max(0.45, fit_scale))
    factor = clamped / X_GLYPH_REFERENCE_SCALE
    src = canonical_x_template()
    width = max(3, int(round(src.shape[1] * factor)))
    height = max(3, int(round(src.shape[0] * factor)))
    return cv2.resize(src, (width, height), interpolation=cv2.INTER_NEAREST)


def fit_column_lines(detected: Sequence[int], min_scale: float = 0.5) -> Optional[ColumnFit]:
    """Same pair search as houseGridForm.ts fitColumnLines.

    Every detected pair is still scored against every template pair. The
    inlier count is the same sum, evaluated in array chunks so a dense page
    does not spend seconds in the Python interpreter. Scale stays in
    [min_scale, 1.4], matching the TypeScript bounds.
    """
    if len(detected) < 4:
        return None
    det = np.asarray([float(v) for v in detected], dtype=np.float64)
    n_det = int(det.shape[0])
    best: Optional[Tuple[int, float, float, float, Tuple[int, ...]]] = None
    pair_i, pair_j = np.triu_indices(n_det, 1)
    for template in COLUMN_TEMPLATES:
        tmpl = np.asarray(template, dtype=np.float64)
        n_tpl = int(tmpl.shape[0])
        left, right = np.triu_indices(n_tpl, 1)
        denom = tmpl[right] - tmpl[left]
        keep = denom != 0
        left, denom = left[keep], denom[keep]
        if denom.size == 0:
            continue
        span = det[pair_j] - det[pair_i]
        scale = span[:, None] / denom[None, :]
        offset = det[pair_i][:, None] - scale * tmpl[left][None, :]
        valid = (scale >= min_scale) & (scale <= 1.4)
        flat_scale = np.ascontiguousarray(scale[valid])
        flat_offset = np.ascontiguousarray(offset[valid])
        hypothesis_count = int(flat_scale.shape[0])
        if hypothesis_count == 0:
            continue
        for start in range(0, hypothesis_count, 4096):
            end = min(hypothesis_count, start + 4096)
            sc = flat_scale[start:end]
            off = flat_offset[start:end]
            nearest = np.full((end - start, n_det), np.inf, dtype=np.float64)
            for value in tmpl:
                predicted = off + sc * value
                nearest = np.minimum(nearest, np.abs(det[None, :] - predicted[:, None]))
            mask = nearest < 12
            inliers = mask.sum(axis=1)
            err = (nearest * mask).sum(axis=1)
            for index in range(end - start):
                count = int(inliers[index])
                error = float(err[index])
                if best is None or count > best[0] or (count == best[0] and error < best[1]):
                    best = (count, error, float(sc[index]), float(off[index]), template)
    if best is None or best[0] < 8:
        return None
    _count, _error, scale, offset, template = best
    xs = [int(round(offset + scale * value)) for value in template]
    return ColumnFit(scale, offset, xs, best[0])


def _best(scores: Sequence[float], indexes: Sequence[int]) -> Optional[Tuple[int, float, float]]:
    index = -1
    score = 0.0
    second = 0.0
    for i in indexes:
        value = scores[i] if i < len(scores) else 0.0
        if value > score:
            second = score
            score = value
            index = i
        elif value > second:
            second = value
    if index < 0 or score < MARK_SCORE_MIN:
        return None
    return index, score, second


def classify_mark_scores(scores: Sequence[float]) -> ClassifiedMarks:
    type_hit = _best(scores, (TYPE_P - 2, TYPE_S - 2, TYPE_E - 2))
    partial_score = scores[TYPE_PARTIAL - 2] if len(scores) > TYPE_PARTIAL - 2 else 0.0
    cg_score = scores[TYPE_CG - 2] if len(scores) > TYPE_CG - 2 else 0.0
    tx_type: Optional[str] = None
    type_reason = "unmarked"
    type_score = 0.0
    if type_hit and type_hit[1] - type_hit[2] >= MARK_AMBIGUITY_GAP:
        column = type_hit[0] + 2
        tx_type = {TYPE_P: "B", TYPE_S: "S", TYPE_E: "E"}[column]
        type_reason = "ok"
        type_score = type_hit[1]
    elif type_hit:
        type_reason = "ambiguous"
        type_score = type_hit[1]
    partial = partial_score >= MARK_SCORE_MIN
    if partial and tx_type in ("B", "E"):
        type_reason = "ambiguous"
        tx_type = None
    elif partial and tx_type is None and type_reason == "unmarked":
        tx_type = "S"
        type_reason = "ok"
        type_score = partial_score
    elif partial and tx_type == "S":
        type_score = max(type_score, partial_score)

    amount_indexes = tuple(column[0] - 2 for column in AMOUNT_COLUMNS)
    amount_hit = _best(scores, amount_indexes)
    amount_min = amount_max = None
    amount_letter = None
    amount_reason = "unmarked"
    amount_score = 0.0
    if amount_hit and amount_hit[1] - amount_hit[2] >= MARK_AMBIGUITY_GAP:
        column = next(item for item in AMOUNT_COLUMNS if item[0] - 2 == amount_hit[0])
        amount_score = amount_hit[1]
        amount_letter = column[1]
        if column[1] == "K":
            amount_reason = "column_k"
        else:
            amount_min, amount_max = column[2], column[3]
            amount_reason = "ok"
    elif amount_hit:
        amount_reason = "ambiguous"
        amount_score = amount_hit[1]
    return ClassifiedMarks(
        tx_type, partial and tx_type == "S", cg_score >= MARK_SCORE_MIN,
        amount_min, amount_max, amount_letter, type_reason, amount_reason,
        type_score, amount_score,
    )


def detect_vertical_lines(gray: np.ndarray, y0: int, y1: int, min_fraction: float = 0.18) -> List[int]:
    """Thin vertical rules. Broken rules still count; wide text blobs do not."""
    top, bot = max(0, y0), min(gray.shape[0], max(y0 + 1, y1))
    band = gray[top:bot]
    if band.size == 0:
        return []
    dark = band < 180
    cov = dark.mean(axis=0)
    idx = np.where(cov > min_fraction)[0]
    groups: List[List[int]] = []
    for x in idx.tolist():
        if groups and x - groups[-1][-1] <= 6:
            groups[-1].append(x)
        else:
            groups.append([x])
    scored: List[Tuple[float, int]] = []
    for group in groups:
        if len(group) > 12:
            continue
        center = int(round(sum(group) / len(group)))
        scored.append((float(cov[group].mean()), center))
    scored.sort(reverse=True)
    return sorted(center for _, center in scored[:28])


def _cluster(values: Sequence[int], gap: int) -> List[int]:
    groups: List[List[int]] = []
    for value in values:
        if groups and value - groups[-1][-1] <= gap:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [int(round(sum(group) / len(group))) for group in groups]


def _median(values: Sequence[float]) -> float:
    if not values:
        return 64.0
    ordered = sorted(values)
    return float(ordered[len(ordered) // 2])


def row_bands(gray: np.ndarray, xs: Sequence[int]) -> Tuple[List[Tuple[int, int]], int]:
    """Amount-column rules. A stable pitch fills faint multi-row gaps.

    Pages with no section bar keep the original one-gap fill so a synthetic
    grid is unchanged. The section-bar count lets the cover page, which has
    rules and no trust bar, be skipped by the caller.
    """
    if len(xs) < 12:
        return [], 0
    x0, x1 = int(xs[7]), int(xs[-1])
    x0, x1 = max(0, x0), min(gray.shape[1], max(x0 + 1, x1))
    if x1 <= x0:
        return [], 0
    strip = gray[:, x0:x1]
    dark = strip < 200
    cov = dark.mean(axis=1)
    idx = np.where(cov > 0.22)[0]
    groups: List[List[int]] = []
    for y in idx.tolist():
        if groups and y - groups[-1][-1] <= 3:
            groups[-1].append(y)
        else:
            groups.append([y])
    rules: List[int] = []
    bars: List[Tuple[int, int]] = []
    bar_bottoms: List[int] = []
    for group in groups:
        if len(group) <= 5:
            rules.append(int(round(sum(group) / len(group))))
        elif len(group) >= 12:
            bars.append((group[0], group[-1]))
            bar_bottoms.append(group[-1])
    if len(rules) < 3 and not bar_bottoms:
        return [], 0
    first_bar = min(bar_bottoms) if bar_bottoms else None
    data_rules = sorted(rule for rule in rules if first_bar is None or rule > first_bar + 4)
    raw_gaps = [b - a for a, b in zip(data_rules, data_rules[1:])]
    small_gaps = [gap for gap in raw_gaps if 32 <= gap <= 70]
    can_subdivide = len(small_gaps) >= 2 and first_bar is not None
    pitch = _median(small_gaps) if can_subdivide else _median([gap for gap in raw_gaps if 24 <= gap <= 140])
    edges = list(data_rules)
    if can_subdivide and first_bar is not None and data_rules:
        for a, b in zip(data_rules, data_rules[1:]):
            gap = b - a
            slots = round(gap / pitch) if pitch else 1
            if 2 <= slots <= 8 and abs(gap - slots * pitch) <= pitch * 0.42:
                for k in range(1, slots):
                    edges.append(int(round(a + (k * gap) / slots)))
        span = data_rules[0] - first_bar
        slots = round(span / pitch) if pitch else 1
        if 1 <= slots <= 6 and abs(span - slots * pitch) <= pitch * 0.45:
            edges.append(first_bar + 4)
            for k in range(1, slots):
                edges.append(int(round(first_bar + (k * span) / slots)))
    else:
        if len(data_rules) < 2 and first_bar is None:
            return [], len(bar_bottoms)
        for a, b in zip(data_rules, data_rules[1:]):
            gap = b - a
            if pitch * 1.6 < gap < pitch * 2.5:
                edges.append(int(round(a + gap / 2)))
        if first_bar is not None:
            for bottom in bar_bottoms:
                nxt = min((edge for edge in edges if edge > bottom + 8), default=None)
                if nxt is not None and abs(nxt - bottom - pitch) <= pitch * 0.45:
                    edges.append(bottom + 1)
    # A row rule that touches a trust bar is absorbed into the bar. Keep the
    # one-pitch rows above and below it when the asset column still has ink.
    if pitch > 0 and bars:
        asset_left = int(xs[1]) + 6
        asset_right = int(xs[2]) - 6

        def _inked_row(y0: int, y1: int) -> bool:
            if asset_right - asset_left < 8 or y1 - y0 < 8:
                return False
            asset = gray[y0 + 4:y1 - 2, asset_left:asset_right:2]
            block = gray[y0:y1:2, x0:x1:4]
            if asset.size == 0 or float((asset < 160).mean()) < 0.035:
                return False
            if block.size and float((block < 150).mean()) > 0.45:
                return False
            return True

        for top, bottom in bars:
            prev = [rule for rule in data_rules if rule < top]
            nxt = [rule for rule in data_rules if rule > bottom]
            if prev:
                gap = top - prev[-1]
                if pitch * 0.75 <= gap <= pitch * 1.35 and _inked_row(prev[-1], top):
                    edges.append(top)
            if nxt:
                gap = nxt[0] - bottom
                if pitch * 0.75 <= gap <= pitch * 1.35 and _inked_row(bottom, nxt[0]):
                    edges.append(bottom + 1)
    sorted_edges = sorted({edge for edge in edges if first_bar is None or edge >= first_bar})
    bands: List[Tuple[int, int]] = []
    for top, bot in zip(sorted_edges, sorted_edges[1:]):
        height = bot - top
        if height < pitch * 0.55 or height > pitch * 1.8:
            continue
        # Rule detection above uses <200. Band solidity matches the TS DARK=150
        # scorer so a gray halo is not counted as a filled row.
        sample = strip[top + 2:bot - 2:2, ::4] < 150
        if sample.size and float(sample.mean()) > 0.45:
            continue
        bands.append((top, bot))
    if can_subdivide and bands:
        asset_left = int(xs[1]) + 6
        asset_right = int(xs[2]) - 6
        cursor = bands[-1][1]
        for _extra in range(4):
            nxt = int(round(cursor + pitch))
            if nxt > gray.shape[0] * 0.92 or asset_right - asset_left < 8:
                break
            asset = gray[cursor + 4:nxt - 2, asset_left:asset_right:2]
            block = gray[cursor:nxt:2, x0:x1:4]
            if asset.size == 0 or float((asset < 160).mean()) < 0.035:
                break
            if block.size and float((block < 150).mean()) > 0.45:
                break
            bands.append((cursor, nxt))
            cursor = nxt
    return bands, len(bar_bottoms)


def _parse_date(text: str) -> Optional[str]:
    match = DATE_RE.match(re.sub(r"\s+", "", text))
    if not match:
        return None
    month, day, year = int(match.group(1)), int(match.group(2)), int(match.group(3))
    if year < 100:
        year += 2000
    # "10" is often read as 16, 20, 30, or 40. Those months cannot exist, so keep the day.
    if month in (16, 18, 19, 20, 30, 40):
        month = 10
    if not (1 <= month <= 12 and 1 <= day <= 31 and 1990 <= year <= 2100):
        return None
    try:
        from datetime import datetime
        datetime(year, month, day)
    except ValueError:
        return None
    return f"{year:04d}-{month:02d}-{day:02d}"


def _owner(text: str) -> Optional[str]:
    token = re.sub(r"[^A-Z]", " ", text.upper())
    if re.search(r"\b(JT|JOINT)\b", token):
        return "joint"
    if re.search(r"\b(SP|SPOUSE)\b", token):
        return "spouse"
    if re.search(r"\b(DC|DEPENDENT)\b", token):
        return "dependent"
    if re.search(r"\bSELF\b", token):
        return "self"
    letters = re.sub(r"[^A-Z]", "", token)
    if len(letters) < 2 or len(letters) > 3:
        return None
    if letters in {"OC", "PC", "DO", "OD", "QC", "CG", "CD", "BC", "CC", "HC"}:
        return "dependent"
    if letters in {"SD", "SF", "PS"}:
        return "spouse"
    if letters in {"JI", "IT", "JF", "TJ"}:
        return "joint"
    return None


def _match_cell(cell: np.ndarray, template: np.ndarray) -> float:
    if cell.size == 0 or cell.shape[0] < 3 or cell.shape[1] < 3:
        return 0.0
    tmpl = template
    if cell.shape[0] < template.shape[0] or cell.shape[1] < template.shape[1]:
        factor = min(cell.shape[1] / template.shape[1], cell.shape[0] / template.shape[0]) * 0.9
        if factor < 0.3:
            return 0.0
        tmpl = cv2.resize(template, (max(3, int(template.shape[1] * factor)), max(3, int(template.shape[0] * factor))))
    result = cv2.matchTemplate(cell, tmpl, cv2.TM_CCOEFF_NORMED)
    if result.size == 0:
        return 0.0
    score = float(result.max())
    return 0.0 if not np.isfinite(score) else score


# Longest form words peel first. Equal lengths keep the source order.
_FORM_WORDS = tuple(sorted((
    "CORPORATION", "INCORPORATED", "INTERNATIONAL", "HOLDINGS", "COMPANIES",
    "PERPETUAL", "WHOLESALE", "COMMON", "COMPANY", "LIMITED", "SYSTEMS",
    "INDEX", "LINKED", "CLASS", "STOCK", "TRUST", "SHARE",
    "CORP", "INC", "LLC", "PLC", "CMN", "LTD", "FUND", "LINE", "HLDG",
    "USD", "US", "CO",
), key=len, reverse=True))
_FORM_PREFIXES = frozenset({"LLC", "PLC", "LINKED"})
_FORM_LEXICON = (
    "SEMICONDUCTOR", "HOLDINGS", "INCORPORATED", "TECHNOLOGY", "PHARMACEUTICALS",
    "COMMUNICATIONS", "UNSPONSORED", "CORPORATION", "INTERNATIONAL", "DIAGNOSTICS",
    "WHOLESALE", "MATERIALS", "ENTERPRISES", "INSTRUMENTS", "LABORATORIES",
)
_FORM_TOKEN_MAP = {
    "CMIN": "CMN",
    "CIMIN": "CMN",
    "CMMN": "CMN",
    "ICMN": "CMN",
    "CMI": "CMN",
    "CMM": "CMN",
    "CMNN": "CMN",
    "CMA": "CMN",
    "CRN": "CMN",
    "CHN": "CMN",
    "CIN": "CMN",
    "CNN": "CMN",
    "MIN": "CMN",
    "CIMN": "CMN",
    "CHIN": "CMN",
    "CHAN": "CMN",
    "HLDGCO": "HLDG CO",
    "PLE": "PLC",
    "PLO": "PLC",
    "HOLOINGS": "HOLDINGS",
    "HOLDNGS": "HOLDINGS",
    "CLASSA": "CLASS A",
    "CLASSB": "CLASS B",
}
_CO_REMAINDER_DENY = frozenset({"COST", "COCA", "TACO", "LOCO", "ARCO", "PEPSI", "DISCO", "GEICO"})
_COMPANY_TAIL = re.compile(r"^(CORPORATION|COMPANY|INCORPORATED|HOLDINGS|LIMITED|INC|CORP|PLC|LLC|CO)$")


def _edit_distance_at_most_1(left: str, right: str) -> bool:
    if abs(len(left) - len(right)) > 1:
        return False
    i = 0
    j = 0
    edits = 0
    while i < len(left) and j < len(right):
        if left[i] == right[j]:
            i += 1
            j += 1
            continue
        edits += 1
        if edits > 1:
            return False
        if len(left) == len(right):
            i += 1
            j += 1
        elif len(left) > len(right):
            i += 1
        else:
            j += 1
    if i < len(left) or j < len(right):
        edits += 1
    return edits <= 1


def _correct_form_word(token: str) -> str:
    if len(token) < 8 or token in _FORM_LEXICON:
        return token
    hits = [word for word in _FORM_LEXICON if _edit_distance_at_most_1(token, word)]
    return hits[0] if len(hits) == 1 else token


def _repair_index_token(token: str) -> Optional[List[str]]:
    if re.fullmatch(r"S[QR8]?PS?[O0]{1,3}D?INDEX", token):
        return ["S&P", "500", "INDEX"]
    if re.fullmatch(r"(?:SOO|SOD|S00|5OO)INDE[XK]", token):
        return ["500", "INDEX"]
    if re.fullmatch(r"(?:SOO|S00|5OO)", token):
        return ["500"]
    if re.fullmatch(r"(?:SRP|SQP|S8P)", token):
        return ["S&P"]
    return None


def _split_form_token(token: str) -> List[str]:
    if re.search(r"[()]", token):
        return [token]
    trimmed = re.sub(r"^[^A-Za-z0-9&]+|[^A-Za-z0-9&]+$", "", token)
    if not trimmed or not re.fullmatch(r"[A-Za-z0-9&]+", trimmed):
        return [token]
    upper = trimmed.upper()
    mapped = _FORM_TOKEN_MAP.get(upper)
    if mapped:
        return mapped.split(" ")
    index = _repair_index_token(upper)
    if index:
        return index
    if re.fullmatch(r"CLASS[ABC]", upper):
        return ["CLASS", upper[5:]]
    prefixes: List[str] = []
    suffixes: List[str] = []
    rest = upper
    for _guard in range(8):
        if len(rest) < 3:
            break
        peeled = False
        for word in _FORM_WORDS:
            if rest == word:
                prefixes.append(_FORM_TOKEN_MAP.get(word, word))
                rest = ""
                peeled = True
                break
            min_remainder = 4 if word in {"LINE", "FUND", "US", "CO"} else 3
            prefix_ok = word in _FORM_PREFIXES and rest.startswith(word) and len(rest) >= len(word) + min_remainder
            suffix_ok = rest.endswith(word) and len(rest) >= len(word) + min_remainder
            if not prefix_ok and not suffix_ok:
                continue
            if suffix_ok and rest[:-len(word)] in _CO_REMAINDER_DENY:
                continue
            piece = _FORM_TOKEN_MAP.get(word, word)
            if prefix_ok:
                prefixes.append(piece)
                rest = rest[len(word):]
            else:
                suffixes.insert(0, piece)
                rest = rest[:-len(word)]
            peeled = True
            break
        if not peeled:
            break
    if rest:
        prefixes.append(_FORM_TOKEN_MAP.get(rest, _correct_form_word(rest)))
    pieces = prefixes + suffixes
    if len(pieces) == 1 and pieces[0] == upper:
        return [token]
    return pieces


def clean_grid_asset_name(text: str) -> str:
    """Same form-word splits as houseGridForm.ts cleanGridAssetName."""
    tokens = [token for token in re.sub(r"[|`\u00b4\u2018\u2019_]+", " ", text).split() if token]
    words: List[str] = []
    for token_index, token in enumerate(tokens):
        for piece in _split_form_token(token):
            if piece == "SA" and words and words[-1] == "CLASS":
                words.append("A")
                continue
            if piece == "SB" and words and words[-1] == "CLASS":
                words.append("B")
                continue
            previous = words[-1] if words else ""
            if piece == "NC" and re.fullmatch(r"[A-Z]{4,}", previous):
                words.append("INC")
                continue
            if piece in {"MN", "CM", "CAN"} and _COMPANY_TAIL.fullmatch(previous):
                words.append("CMN")
                continue
            nxt = tokens[token_index + 1].upper() if token_index + 1 < len(tokens) else ""
            if piece == "SP" and re.match(r"(?:500|SOO|SOD|S00)", nxt):
                words.append("S&P")
                continue
            if words and words[-1] == piece:
                continue
            if len(piece) == 1 and not re.fullmatch(r"[A-Z]", piece):
                continue
            words.append(piece)
    return re.sub(r"\s+", " ", " ".join(words)).strip()


def reading_order(boxes: Sequence[OcrBox]) -> str:
    """Group words into lines the way houseGridForm.ts readingOrder does."""
    ordered = sorted(boxes, key=lambda box: (box.y0, box.x0))
    lines: List[List[OcrBox]] = []
    for box in ordered:
        cy = (box.y0 + box.y1) / 2
        if not lines:
            lines.append([box])
            continue
        line = lines[-1]
        line_y = sum((entry.y0 + entry.y1) / 2 for entry in line) / len(line)
        if abs(cy - line_y) > 8:
            lines.append([box])
        else:
            line.append(box)
    parts: List[str] = []
    for line in lines:
        text = " ".join(
            box.text.strip()
            for box in sorted(line, key=lambda box: box.x0)
            if box.text.strip()
        )
        if text:
            parts.append(text)
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


def asset_text(boxes: Sequence[OcrBox], xs: Sequence[int]) -> Tuple[str, float]:
    left = xs[1] - 8
    right = xs[2] - 4
    hits = [box for box in boxes if left <= box.x0 < right and box.text.strip()]
    if not hits:
        return "", 0.0
    conf = sum(box.conf for box in hits) / len(hits)
    return reading_order(hits), conf


def row_confidence(marks: ClassifiedMarks, asset_conf: float, has_date: bool, asset: str) -> float:
    """Same weights as houseGridForm.ts confidenceFor, including the asset term."""
    if marks.type_reason != "ok":
        return 0.35
    strong = (
        marks.type_score >= GRID_STRONG_MARK
        and marks.amount_reason == "ok"
        and marks.amount_score >= GRID_STRONG_MARK
        and has_date
        and len(asset.strip()) >= 4
        and asset_conf >= 0.45
    )
    if strong:
        return 0.97
    asset_term = 0.08 * min(1.0, asset_conf) if len(asset.strip()) >= 4 else 0.0
    return min(
        0.9,
        0.42
        + min(0.2, marks.type_score * 0.2)
        + (0.12 if marks.amount_reason == "ok" else 0.0)
        + (0.08 if has_date else 0.0)
        + asset_term,
    )


def read_grid_page(gray: np.ndarray, boxes: Sequence[OcrBox], page: int = 1) -> Optional[List[GridRow]]:
    if gray.ndim == 3:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)
    height = gray.shape[0]
    detected = detect_vertical_lines(gray, int(height * 0.28), int(height * 0.92))
    fit = fit_column_lines(detected)
    if fit is None or fit.inliers < GRID_MIN_INLIERS:
        fit = fit_column_lines(
            detect_vertical_lines(gray, int(height * 0.05), int(height * 0.72), 0.15),
            0.42,
        )
    if fit is None or fit.inliers < GRID_MIN_INLIERS or len(fit.xs) < 21:
        return None
    template = x_template_for_fit(fit.scale)
    xs = fit.xs
    bands, section_bars = row_bands(gray, xs)
    # The cover prints a sample grid under the filer block and has no trust bar.
    if section_bars == 0:
        x0, x1 = int(xs[7]), int(xs[-1])
        limit = int(height * 0.15)
        if x1 - x0 >= 20 and limit > 0:
            early = gray[:limit, max(0, x0):min(gray.shape[1], x1)]
            if early.size and float((early < 200).mean(axis=1).max()) > 0.22:
                return []
    rows: List[GridRow] = []
    for top, bot in bands:
        scores: List[float] = []
        for column in range(2, 20):
            if column in (7, 8):
                scores.append(0.0)
                continue
            cell = gray[top + 2:bot - 2, xs[column] + 4:xs[column + 1] - 4]
            scores.append(_match_cell(cell, template))
        marks = classify_mark_scores(scores)
        in_band = [box for box in boxes if top <= (box.y0 + box.y1) / 2 <= bot]
        asset, asset_conf = asset_text(in_band, xs)
        owners = [owner for owner in (_owner(box.text) for box in in_band if box.x1 <= xs[1] + 12) if owner]
        trade_left, trade_right, notif_right = xs[7], xs[8], xs[9]
        trade_date: Optional[str] = None
        notif_date: Optional[str] = None
        for box in in_band:
            iso = _parse_date(box.text)
            if not iso:
                continue
            cx = (box.x0 + box.x1) / 2
            # The left date column is the trade. A missed word stays empty.
            if trade_left - 8 <= cx < trade_right:
                if trade_date is None:
                    trade_date = iso
            elif trade_right <= cx <= notif_right + 8:
                if notif_date is None:
                    notif_date = iso
        if trade_date and notif_date and trade_date[:4] == f"{int(notif_date[:4]) - 1:04d}":
            snapped = f"{notif_date[:4]}-{trade_date[5:]}"
            if snapped <= notif_date:
                trade_date = snapped
        has_mark = marks.type_reason != "unmarked" or marks.amount_reason != "unmarked" or marks.cap_gains
        if not asset and not has_mark:
            continue
        notes = [f"grid page {page}"]
        if marks.partial:
            notes.append("partial transaction box marked")
        if marks.type_reason == "unmarked":
            notes.append("transaction type was not marked")
        if marks.type_reason == "ambiguous":
            notes.append("transaction type marks were ambiguous")
        if marks.amount_reason == "unmarked":
            notes.append("no amount box marked")
        if marks.amount_reason == "ambiguous":
            notes.append("amount marks were ambiguous")
        if marks.amount_reason == "column_k":
            notes.append("amount column K marked")
        warnings = ["grid_type_unmarked"] if marks.type_reason != "ok" or marks.tx_type is None else []
        confidence = row_confidence(marks, asset_conf, trade_date is not None, asset)
        ticker = None
        found = re.search(r"\(([A-Z]{1,5})\)", asset)
        bare = re.search(r"^(.*\S)[ \t]{2,}([A-Z]{2,5})[ \t]*$", asset)
        ticker_deny = {
            "INC", "CMN", "LLC", "PLC", "CORP", "CO", "ETF", "LTD", "USD", "USD0", "ADR",
            "COM", "FUND", "CLASS", "HLDG", "STOCK", "TRUST", "THE", "AND", "NEW", "CL",
            "COMMON", "SHARES", "INDEX", "LINKED", "COMPANY",
        }
        if found:
            ticker = found.group(1)
        elif bare and bare.group(2) not in ticker_deny:
            ticker = bare.group(2)
            asset = bare.group(1)
        cleaned = clean_grid_asset_name(asset)
        rows.append(GridRow(
            asset_name=cleaned or asset or f"(unreadable asset p{page})",
            owner=owners[0] if owners else None,
            tx_type=marks.tx_type or "",
            tx_date=trade_date,
            notif_date=notif_date,
            amount_min=marks.amount_min,
            amount_max=marks.amount_max,
            confidence=confidence,
            raw_text=f"{asset or '(unreadable)'} | type {marks.tx_type or 'unmarked'} | amt {marks.amount_letter or 'blank'}",
            note="; ".join(notes),
            warnings=warnings,
            cap_gains=marks.cap_gains,
            is_option=asset.upper().startswith(("PUT/", "CALL/")),
            ticker=ticker,
        ))
    return rows
