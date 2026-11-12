#!/usr/bin/env python3
"""Find official portraits for executive-branch filers, on Wikimedia Commons.

Congressional members are covered by ``unitedstates/images``.  Cabinet
secretaries, agency heads and Senate-confirmed nominees are not in any
bioguide-keyed set, so their portraits have to be sourced individually.

This script searches Wikimedia Commons, then **verifies the licence through the
Commons API** (``extmetadata.LicenseShortName`` / ``UsageTerms`` / ``Artist``).
The licence check is a RECORD, not a gate: every candidate's licence, author and
a ready-to-use attribution caption are captured (see ``facepack.format_attribution``)
regardless of what the licence is, because that data is free to capture now and
expensive to reconstruct later.  The only thing that drops a candidate outright is
having no recognisable licence at all -- Commons requires every hosted file to
carry one, so this is rare in practice.

What the licence DOES still do is rank: among candidates that plausibly show the
right person, public domain is preferred, then plain-attribution Creative Commons,
then share-alike, then everything else (``facepack.licence_tier``).  Widening the
net must never cause a licence-encumbered image to be chosen over a clean one that
exists for the same person.

Candidates are *scored* for identity first, independent of licence:

* the file title must contain the subject's surname (so a fuzzy search hit on
  somebody else is rejected outright), and
* an "official portrait" title, a government-agency author and a larger image
  all push a candidate up.

The output is a candidate list for ``sources.json`` — **review it before
committing**.  Automated search plus a licence check is enough to guarantee the
licence; it is not enough to guarantee the right face, which is what
``build_face_pack.py --contact-sheet`` is for.

Usage
-----
    .venv/bin/python scripts/member-photos/discover_commons.py --names-file names.txt
    .venv/bin/python scripts/member-photos/discover_commons.py "Pete Hegseth" "Pam Bondi"
    .venv/bin/python scripts/member-photos/discover_commons.py --names-file names.txt --json out.json
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import facepack as fp  # noqa: E402

API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "CongressTrade-FacePack/1.0 (+https://congress.trade)"

# Author strings that indicate an official government photographer/office.
GOV_AUTHOR = re.compile(
    r"(white house|department of|u\.?s\.?\s|united states|federal|executive office|"
    r"office of|agency|administration|treasury|pentagon|congress|senate|navy|army|air force)",
    re.I,
)


def api(params: dict) -> dict:
    query = urllib.parse.urlencode({**params, "format": "json", "formatversion": 2})
    req = urllib.request.Request(f"{API}?{query}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def strip_tracking(url: str | None) -> str | None:
    """Commons imageinfo URLs carry utm_* analytics params; the file is the same without them."""
    if not url:
        return url
    parsed = urllib.parse.urlsplit(url)
    kept = [(k, v) for k, v in urllib.parse.parse_qsl(parsed.query) if not k.startswith("utm_")]
    return urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(kept)))


def strip_html(value: str | None) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", value or "")).strip()


def fold(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value or "")
    return "".join(c for c in folded if not unicodedata.combining(c)).lower()


def score(title: str, meta: dict, surname: str, given: str) -> int:
    """Rank a candidate. Higher is better; negative means reject."""
    t = fold(title)
    if fold(surname) not in t:
        return -1  # wrong person, or at least unprovable — drop it
    points = 0
    if fold(given) and fold(given) in t:
        points += 25
    if "official portrait" in t:
        points += 40
    elif "official" in t or "portrait" in t:
        points += 15
    if "(cropped)" in t:
        points += 10  # already head-focused upstream
    if GOV_AUTHOR.search(strip_html(meta.get("artist"))):
        points += 20
    # Prefer something big enough to crop from, but do not reward absurd sizes.
    width, height = meta.get("width") or 0, meta.get("height") or 0
    if min(width, height) >= 600:
        points += 20
    elif min(width, height) >= 350:
        points += 8
    else:
        points -= 15
    if height >= width:
        points += 10  # portrait orientation
    else:
        points -= 30  # landscape almost always means a scene, not a headshot
    # Screengrabs from hearings are legitimate but a poor face source.
    if re.search(r"\d{4}-\d{2}-\d{2}", t) or "hearing" in t:
        points -= 25
    # Group/event shots: another person's name in the title means the subject is
    # not alone in frame, and face detection would happily pick the wrong one.
    if re.search(r"\b(and|with|alongside)\b", t) or "unveil" in t or "ceremony" in t:
        points -= 60
    return points


def describe(titles: list[str]) -> list[dict]:
    """Licence + direct URL for exact Commons file titles (for manual overrides).

    Never hand-write an ``upload.wikimedia.org`` URL: the path contains an MD5
    shard that cannot be derived from the file name. Ask the API for it.
    """
    info = api(
        {
            "action": "query",
            "prop": "imageinfo",
            "iiprop": "url|extmetadata|size",
            "titles": "|".join(titles),
        }
    )
    out = []
    for page in info.get("query", {}).get("pages", []):
        images = page.get("imageinfo") or []
        if not images:
            out.append({"title": page.get("title"), "error": "missing on Commons"})
            continue
        ii = images[0]
        em = ii.get("extmetadata") or {}
        licence = strip_html((em.get("LicenseShortName") or {}).get("value"))
        attribution = strip_html((em.get("Artist") or {}).get("value")) or None
        source_page = ii.get("descriptionurl")
        out.append(
            {
                "title": page.get("title"),
                "licence": licence,
                "licenceTier": fp.licence_tier(licence),
                "publicDomain": fp.is_public_domain_licence(licence),
                "attribution": attribution,
                "attributionCaption": fp.format_attribution(licence, attribution, source_page),
                "sourceUrl": strip_tracking(ii.get("url")),
                "sourcePage": source_page,
                "width": ii.get("width"),
                "height": ii.get("height"),
            }
        )
    return out


def candidates_for(name: str, limit: int = 8) -> list[dict]:
    parts = [p for p in name.replace(".", " ").split() if len(p) > 1]
    given = parts[0] if parts else ""
    surname = parts[-1] if parts else name
    found = api(
        {
            "action": "query",
            "list": "search",
            "srsearch": f"{name} official portrait filetype:bitmap",
            "srnamespace": 6,
            "srlimit": limit,
        }
    )
    titles = [hit["title"] for hit in found.get("query", {}).get("search", [])]
    if not titles:
        return []
    info = api(
        {
            "action": "query",
            "prop": "imageinfo",
            "iiprop": "url|extmetadata|size",
            "titles": "|".join(titles),
        }
    )
    out = []
    for page in info.get("query", {}).get("pages", []):
        images = page.get("imageinfo") or []
        if not images:
            continue
        ii = images[0]
        em = ii.get("extmetadata") or {}
        licence = strip_html((em.get("LicenseShortName") or {}).get("value"))
        meta = {
            "artist": (em.get("Artist") or {}).get("value"),
            "width": ii.get("width"),
            "height": ii.get("height"),
        }
        title = page.get("title", "")
        rank = score(title, meta, surname, given)
        attribution = strip_html(meta["artist"]) or None
        credit = strip_html((em.get("Credit") or {}).get("value")) or None
        source_page = ii.get("descriptionurl")
        out.append(
            {
                "title": title,
                "score": rank,
                "licence": licence,
                "licenceTier": fp.licence_tier(licence),
                "usageTerms": strip_html((em.get("UsageTerms") or {}).get("value")),
                "attribution": attribution,
                "credit": credit,
                "attributionCaption": fp.format_attribution(licence, attribution or credit, source_page),
                "sourceUrl": strip_tracking(ii.get("url")),
                "sourcePage": source_page,
                "width": ii.get("width"),
                "height": ii.get("height"),
                "publicDomain": fp.is_public_domain_licence(licence),
            }
        )
    # Identity score only here -- this is the full candidate list (including
    # rejects) printed for operator review, not the selection order.
    return sorted(out, key=lambda c: -c["score"])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("names", nargs="*", help="Person names to search for.")
    ap.add_argument("--names-file", type=Path, help="One name per line (blank lines / # comments ignored).")
    ap.add_argument("--json", type=Path, help="Write sources.json-shaped candidate entries here.")
    ap.add_argument("--show", type=int, default=3, help="Candidates to print per person.")
    ap.add_argument("--sleep", type=float, default=0.4)
    ap.add_argument(
        "--file",
        action="append",
        default=[],
        metavar="TITLE",
        help='Describe an exact Commons file ("File:Foo.jpg") instead of searching.',
    )
    args = ap.parse_args()

    if args.file:
        for row in describe(args.file):
            print(json.dumps(row, indent=2))
        return 0

    names = list(args.names)
    if args.names_file:
        for line in args.names_file.read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                names.append(line)
    if not names:
        ap.error("no names given")

    chosen, unresolved = [], []
    for name in names:
        try:
            cands = candidates_for(name)
        except Exception as exc:  # noqa: BLE001 - keep going, report at the end
            print(f"### {name}\n    ERROR {exc}")
            unresolved.append((name, str(exc)))
            continue
        # Identity gates (score >= 0); licence no longer does. Sort what
        # remains by (licenceTier, -score) so a public-domain candidate always
        # wins over a same-or-lower-scored non-free one for the same person.
        usable = sorted(
            (c for c in cands if c["score"] >= 0 and c["licence"]),
            key=lambda c: (c["licenceTier"], -c["score"]),
        )
        print(f"### {name}")
        if not usable:
            rejected = [f"{c['title']} [{c['licence'] or 'no licence'}]" for c in cands[: args.show]]
            print("    NO CANDIDATE — leaving a gap")
            for r in rejected:
                print(f"      rejected: {r}")
            unresolved.append((name, "no usable candidate (right person + a recorded licence)"))
            continue
        for c in usable[: args.show]:
            pd_flag = "PD " if c["publicDomain"] else f"T{c['licenceTier']} "
            print(f"    {c['score']:>4}  {pd_flag}{c['title']}  [{c['licence']}]  {c['width']}x{c['height']}")
        best = usable[0]
        if not best["publicDomain"]:
            print(f"    note: best candidate is NOT public domain ({best['licence']}) — recorded, not gated")
        chosen.append(
            {
                "key": fp.slugify(name),
                "name": name,
                "filerIds": [],
                "commonsFile": best["title"],
                "sourceUrl": best["sourceUrl"],
                "sourcePage": best["sourcePage"],
                "licence": best["licence"],
                "attribution": best["attribution"] or best["credit"],
                "attributionCaption": best["attributionCaption"],
            }
        )
        time.sleep(args.sleep)

    non_pd_chosen = [c for c in chosen if fp.licence_tier(c["licence"]) != 0]
    print(f"\n{len(chosen)} candidates, {len(unresolved)} unresolved")
    if non_pd_chosen:
        print(f"  {len(non_pd_chosen)} of those are NOT public domain (attribution captured, display stays off by default):")
        for c in non_pd_chosen:
            print(f"    {c['name']}: {c['licence']}")
    for name, why in unresolved:
        print(f"  UNRESOLVED {name}: {why}")
    if args.json:
        args.json.write_text(json.dumps({"executives": chosen}, indent=2) + "\n", encoding="utf-8")
        print(f"\nwrote {args.json} — REVIEW before merging into sources.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
