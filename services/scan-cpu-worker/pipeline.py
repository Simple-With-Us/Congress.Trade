"""End-to-end CPU pipeline: PDF → pages → OCR + checkbox grid → ParsedTx list."""
from __future__ import annotations

import logging
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

from form_chrome import is_form_chrome_asset
from grid_ptr import BRACKET_RANGES, analyze_grid, row_bracket, row_type
from gridform import OcrBox, read_grid_page
from ocr_backends import OcrBackend, OcrPage, extract_dates, get_backend

logger = logging.getLogger("scan-cpu-worker.pipeline")

PTR_KEYWORDS = (
    "PERIODIC", "TRANSACTION", "HOUSE", "REPRESENTATIVES",
    "FULL ASSET", "AMOUNT", "Purchase", "Member", "FILER",
)


@dataclass
class ExtractedTx:
    ticker: Optional[str]
    assetName: str
    txType: str
    txDate: Optional[str]
    amountMin: Optional[int]
    amountMax: Optional[int]
    confidence: float
    rawText: str
    owner: Optional[str] = None
    notifDate: Optional[str] = None
    page: Optional[int] = None
    bracket: Optional[str] = None
    note: Optional[str] = None
    warnings: Optional[List[str]] = None
    capGainsOver200: bool = False
    isOption: bool = False

    def to_parsed_tx(self) -> Dict[str, Any]:
        # Matches ParsedTx shape expected by /ingest-local-vision
        out: Dict[str, Any] = {
            "ticker": self.ticker,
            "assetName": self.assetName,
            "txType": self.txType,
            "txDate": self.txDate,
            "amountMin": self.amountMin,
            "amountMax": self.amountMax,
            "confidence": self.confidence,
            "rawText": self.rawText,
            "isOption": self.isOption,
            "capGainsOver200": self.capGainsOver200,
        }
        if self.owner:
            out["owner"] = self.owner
        if self.notifDate:
            out["notifDate"] = self.notifDate
        if self.page is not None:
            out["page"] = self.page
        if self.note:
            out["note"] = self.note
            out["supplementalText"] = self.note
        if self.warnings:
            out["extractionWarnings"] = list(self.warnings)
        return out


def render_pdf_pages(pdf_path: str, out_dir: str, dpi: int = 200) -> List[str]:
    """Render PDF to PNG pages via pdftoppm. Returns sorted page paths."""
    prefix = os.path.join(out_dir, "page")
    cmd = ["pdftoppm", "-png", "-r", str(dpi), pdf_path, prefix]
    subprocess.run(cmd, check=True, capture_output=True)
    pages = sorted(Path(out_dir).glob("page-*.png"))
    if not pages:
        pages = sorted(Path(out_dir).glob("page*.png"))
    return [str(p) for p in pages]


def upright_bgr(image_bgr: np.ndarray, ocr: OcrBackend) -> Tuple[np.ndarray, int]:
    """Pick rotation that maximizes PTR keyword hits in OCR."""
    best = (image_bgr, 0, -1)
    for rot in (0, 90, 270, 180):
        if rot == 0:
            img = image_bgr
        else:
            # OpenCV rotate codes
            code = {
                90: cv2.ROTATE_90_COUNTERCLOCKWISE,
                180: cv2.ROTATE_180,
                270: cv2.ROTATE_90_CLOCKWISE,
            }[rot]
            img = cv2.rotate(image_bgr, code)
        # cheap keyword score via small top band OCR
        h = img.shape[0]
        band = img[0 : max(40, h // 5), :]
        try:
            page = ocr.run(band)
            text = page.full_text.upper()
        except Exception:
            text = ""
        score = sum(1 for k in PTR_KEYWORDS if k.upper() in text)
        if score > best[2]:
            best = (img, rot, score)
    return best[0], best[1]


def _normalize_date(s: str) -> Optional[str]:
    s = s.strip()
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
        try:
            d = datetime.strptime(s, fmt)
            if d.year < 100:
                d = d.replace(year=2000 + d.year)
            return d.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _asset_from_ocr_for_row(
    ocr_page,
    y0: int,
    y1: int,
    page_h: int,
    x_right: int,
    page_w: int,
) -> Tuple[str, float]:
    """Collect OCR lines whose vertical center falls in [y0,y1] and left of grid."""
    pieces = []
    confs = []
    y_mid_lo = y0 / page_h
    y_mid_hi = y1 / page_h
    x_max = x_right / page_w
    for line in ocr_page.lines:
        if not line.bbox:
            continue
        x, y, w, h = line.bbox
        cy = y + h / 2
        if y_mid_lo <= cy <= y_mid_hi and x < x_max:
            t = line.text.strip()
            if t and not re.fullmatch(r"[\d/.\-]+", t):
                pieces.append(t)
                confs.append(line.conf)
    if not pieces:
        return "", 0.0
    return " ".join(pieces), (sum(confs) / len(confs) if confs else 0.0)


def _boxes_from_ocr(page: OcrPage, width: int, height: int) -> List[OcrBox]:
    boxes: List[OcrBox] = []
    for line in page.lines:
        if not line.bbox:
            continue
        x, y, w, h = line.bbox
        boxes.append(OcrBox(
            x0=int(x * width),
            y0=int(y * height),
            x1=int((x + w) * width),
            y1=int((y + h) * height),
            text=line.text,
            conf=line.conf,
        ))
    return boxes


def _grid_rows_to_tx(rows: List, page_num: int) -> List[ExtractedTx]:
    out: List[ExtractedTx] = []
    for row in rows:
        out.append(ExtractedTx(
            ticker=row.ticker,
            assetName=row.asset_name[:200],
            txType=row.tx_type,
            txDate=row.tx_date,
            amountMin=row.amount_min,
            amountMax=row.amount_max,
            confidence=row.confidence,
            rawText=row.raw_text,
            owner=row.owner,
            notifDate=row.notif_date,
            page=page_num,
            note=row.note,
            warnings=row.warnings or None,
            capGainsOver200=row.cap_gains,
            isOption=row.is_option,
        ))
    return out


@dataclass
class PageExtract:
    rows: List[ExtractedTx]
    grid_form: bool


def extract_page_result(
    image_bgr: np.ndarray,
    *,
    page_num: int,
    ocr: OcrBackend,
    ink_thr: float = 0.10,
) -> PageExtract:
    upright, _rot = upright_bgr(image_bgr, ocr)
    ocr_page = ocr.run(upright)
    gray = cv2.cvtColor(upright, cv2.COLOR_BGR2GRAY) if upright.ndim == 3 else upright
    grid_rows = read_grid_page(
        gray,
        _boxes_from_ocr(ocr_page, gray.shape[1], gray.shape[0]),
        page_num,
    )
    if grid_rows is not None:
        return PageExtract(_grid_rows_to_tx(grid_rows, page_num), True)
    return PageExtract(
        _legacy_ink_rows(upright, ocr_page, page_num=page_num, ink_thr=ink_thr),
        False,
    )


def extract_page(
    image_bgr: np.ndarray,
    *,
    page_num: int,
    ocr: OcrBackend,
    ink_thr: float = 0.10,
) -> List[ExtractedTx]:
    return extract_page_result(image_bgr, page_num=page_num, ocr=ocr, ink_thr=ink_thr).rows


def _legacy_ink_rows(
    upright: np.ndarray,
    ocr_page: OcrPage,
    *,
    page_num: int,
    ink_thr: float,
) -> List[ExtractedTx]:
    grid = analyze_grid(upright, ink_thr=ink_thr)
    txs: List[ExtractedTx] = []

    asset_x_right = grid.cols[0] if grid.cols else int(grid.page_w * 0.35)

    for row in grid.rows:
        if not row.is_data or not row.marks:
            continue
        tx_type = row_type(row.marks)
        bracket = row_bracket(row.marks)
        if not tx_type and not bracket:
            continue
        warnings: List[str] = []
        if not tx_type:
            note_bits = ["transaction type was not marked"]
            warnings.append("grid_type_unmarked")
            tx_type = ""
        else:
            note_bits = []

        amount_min = amount_max = None
        if bracket and bracket in BRACKET_RANGES:
            amount_min, amount_max = BRACKET_RANGES[bracket]
        else:
            note_bits.append("amount box not checked")

        asset, asset_conf = _asset_from_ocr_for_row(
            ocr_page, row.y0, row.y1, grid.page_h, asset_x_right, grid.page_w,
        )
        # dates from OCR in date columns band
        date_text = ""
        for line in ocr_page.lines:
            if not line.bbox:
                continue
            x, y, w, h = line.bbox
            cy = y + h / 2
            if row.y0 / grid.page_h <= cy <= row.y1 / grid.page_h:
                date_text += " " + line.text
        dates = extract_dates(date_text)
        tx_date = _normalize_date(dates[0]) if dates else None
        notif_date = _normalize_date(dates[1]) if len(dates) > 1 else None

        # ticker in parentheses
        ticker = None
        m = re.search(r"\(([A-Z]{1,5})\)", asset)
        if m:
            ticker = m.group(1)

        # owner marks — SP/JT/DC live in leftmost owner column on paper forms;
        # we do not always have a separate owner grid; leave null for normalizer default.
        conf = 0.55
        if asset:
            conf += 0.15 * min(1.0, asset_conf)
        if tx_type and bracket:
            conf += 0.2
        if tx_date:
            conf += 0.1
        conf = min(0.95, conf)
        if warnings:
            conf = min(conf, 0.4)

        if not asset:
            asset = f"(unreadable asset p{page_num} y{row.y0})"
            note_bits.append("asset OCR empty")
            conf = min(conf, 0.45)

        txs.append(
            ExtractedTx(
                ticker=ticker,
                assetName=asset[:200],
                txType=tx_type,
                txDate=tx_date,
                amountMin=amount_min,
                amountMax=amount_max,
                confidence=conf,
                rawText=f"{asset} | marks={list(row.marks.keys())} | dates={dates}",
                notifDate=notif_date,
                page=page_num,
                bracket=bracket,
                note="; ".join(note_bits) if note_bits else None,
                warnings=warnings or None,
            )
        )
    return txs


@dataclass
class PdfExtract:
    rows: List[Dict[str, Any]]
    extractor: str
    grid_pages: int


def extract_pdf_detailed(
    pdf_path: str,
    *,
    dpi: int = 200,
    ocr_backend: Optional[str] = None,
    ink_thr: Optional[float] = None,
) -> PdfExtract:
    """Full PDF extraction. Grid-form pages replace the ink-ratio reader."""
    ocr = get_backend(ocr_backend)
    thr = float(ink_thr if ink_thr is not None else os.getenv("CHECKBOX_INK_RATIO", "0.10"))
    dpi = int(os.getenv("DPI", str(dpi)))

    with tempfile.TemporaryDirectory(prefix="scan_cpu_") as tmp:
        pages = render_pdf_pages(pdf_path, tmp, dpi=dpi)
        grid_tx: List[ExtractedTx] = []
        legacy_tx: List[ExtractedTx] = []
        grid_pages = 0
        for i, page_path in enumerate(pages, start=1):
            img = cv2.imread(page_path)
            if img is None:
                logger.warning("Failed to read page image %s", page_path)
                continue
            try:
                page = extract_page_result(img, page_num=i, ocr=ocr, ink_thr=thr)
            except Exception as e:
                logger.exception("Page %d extract failed: %s", i, e)
                continue
            if page.grid_form:
                grid_pages += 1
                grid_tx.extend(page.rows)
            else:
                legacy_tx.extend(page.rows)
        all_tx = grid_tx if grid_pages else legacy_tx
        before = len(all_tx)
        all_tx = [t for t in all_tx if not is_form_chrome_asset(t.assetName)]
        dropped = before - len(all_tx)
        if dropped:
            logger.info(
                "extract_pdf %s: dropped %d form-chrome row(s) (letterhead/header)",
                pdf_path, dropped,
            )
        extractor = "server_cpu_gridform" if grid_pages else "server_cpu_v1"
        logger.info(
            "extract_pdf %s: %d pages, %d grid pages, %d rows via %s",
            pdf_path, len(pages), grid_pages, len(all_tx), extractor,
        )
        return PdfExtract([t.to_parsed_tx() for t in all_tx], extractor, grid_pages)


def extract_pdf(
    pdf_path: str,
    *,
    dpi: int = 200,
    ocr_backend: Optional[str] = None,
    ink_thr: Optional[float] = None,
) -> List[Dict[str, Any]]:
    """Full PDF extraction → list of ParsedTx dicts."""
    return extract_pdf_detailed(
        pdf_path, dpi=dpi, ocr_backend=ocr_backend, ink_thr=ink_thr,
    ).rows
