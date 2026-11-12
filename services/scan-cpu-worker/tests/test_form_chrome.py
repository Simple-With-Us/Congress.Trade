"""Form-chrome letterhead filter for server_cpu OCR rows (no OCR deps)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from form_chrome import is_form_chrome_asset  # noqa: E402


def test_letterhead_is_form_chrome():
    assert is_form_chrome_asset(
        "Clerk of the House of Representatives + Legislative Resource Center * B81 Cannon Building"
    )
    assert is_form_chrome_asset("Legislative Resource Center")
    assert is_form_chrome_asset("Name: Hon. Dwight Evans Status: Member")


def test_real_assets_are_not_form_chrome():
    assert not is_form_chrome_asset("Apple Inc.")
    assert not is_form_chrome_asset("Berkshire Hathaway Inc. New")
    assert not is_form_chrome_asset(None)
    assert not is_form_chrome_asset("")
