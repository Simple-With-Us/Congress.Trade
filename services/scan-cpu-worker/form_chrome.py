"""PTR form-chrome (letterhead / column-header) detection.

Keep the regex in sync with looksLikeHeaderContaminatedAsset in
app/src/extraction/normalizer.ts.
"""
from __future__ import annotations

import re
from typing import Optional

_FORM_CHROME_RE = re.compile(
    r"(?:\bClerk of the House of Representatives\b|"
    r"\bLegislative Resource Center\b|"
    r"\bB-?81 Cannon Building\b|"
    r"\bCannon Building\b|"
    r"\bID Owner Asset Transaction Type\b|"
    r"\bTransaction Type Date Notification Date Amount\b|"
    r"\bPeriodic Transaction Report\b|"
    r"Name:\s*Hon\.|"
    r"Status:\s*Member|"
    r"State/District:)",
    re.IGNORECASE,
)


def is_form_chrome_asset(asset_name: Optional[str]) -> bool:
    """True when assetName is letterhead/header chrome, not a security."""
    if not asset_name:
        return False
    return bool(_FORM_CHROME_RE.search(asset_name))
