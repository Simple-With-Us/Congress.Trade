#!/usr/bin/env python3
"""Build the Congress.Trade member face pack.

Downloads each member's public-domain source portrait, crops it to a square
head-and-shoulders face, writes a 256px WebP into
``app/public/assets/member-photos/`` and records source + licence for every
image in ``manifest.json``.

Re-runnable: existing faces are refreshed in place, and members that are not
in the input set are left alone (pass ``--prune`` to drop orphans).

Sources
-------
* **Congress** -- ``unitedstates/images`` (public domain, bioguide-keyed).  The
  bioguide set is derived from the live ``/api/members`` response: every member
  whose ``photoUrl`` already points at that CDN.  New members appear in the API,
  re-run this script, and they join the pack.
* **Executive** -- curated entries in ``sources.json``, each carrying the
  Commons file, direct source URL, licence and attribution that
  ``discover_commons.py`` verified.  A licence must be *recorded* to admit an
  entry, but it no longer has to be public domain -- see ``facepack.py`` for
  why, and ``facepack.licence_tier`` for how PD is still preferred when it is
  available.  An entry with no recorded licence at all is reported and
  skipped so the gap stays visible.
* **Filer aliases** -- ``sources.json``'s ``filerIdAliases`` maps a filer id
  with no bioguide of its own onto a bioguide that already has a photo in this
  run (duplicate identities under a legal-name variant, e.g. a Senate-side
  extraction using someone's full legal first name against a House filer
  already resolved by their common name). Reuses the existing image byte for
  byte; downloads nothing new.

Usage
-----
    python3 -m venv .venv
    .venv/bin/pip install -r scripts/member-photos/requirements.txt
    .venv/bin/python scripts/member-photos/build_face_pack.py
    .venv/bin/python scripts/member-photos/build_face_pack.py --contact-sheet /tmp/faces.png

    # Flip whether attributionCaption is surfaced (today: the x-photo-attribution
    # response header, not a visible caption). Patches the manifest in place --
    # no network calls, no re-crop, safe to run any time.
    .venv/bin/python scripts/member-photos/build_face_pack.py --set-attribution-display on

``--contact-sheet`` writes a labelled grid of every produced face.  Look at it.
It is the only cheap way to catch a detector that quietly framed somebody's
chin, and it is why the fallback crop is deliberately loose.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image, ImageDraw  # noqa: E402

import facepack as fp  # noqa: E402

USER_AGENT = "CongressTrade-FacePack/1.0 (+https://congress.trade)"
MEMBERS_URL = "https://congress.trade/api/members"
# `original` is the largest unitedstates/images size; cropping from it and
# downsampling to 256 beats cropping the already-downsampled 450x550.
CONGRESS_SOURCE = "https://unitedstates.github.io/images/congress/original/{bioguide}.jpg"
CONGRESS_FALLBACK = "https://unitedstates.github.io/images/congress/450x550/{bioguide}.jpg"
CONGRESS_LICENCE = "Public domain (CC0 1.0 Universal)"
CONGRESS_ATTRIBUTION = "unitedstates/images — public-domain congressional portraits"
CONGRESS_SOURCE_PAGE = "https://github.com/unitedstates/images"

BIOGUIDE_IN_URL = re.compile(r"/images/congress/[^/]+/([A-Z]\d{6})\.jpg", re.I)
# Once a bioguide is packed, `runPhotoEnrichment` rewrites `filers.photo_url`
# to point at our OWN pack route instead of the raw CDN (see
# memberPhotoPack.ts) -- so on a live run, most already-packed members no
# longer match BIOGUIDE_IN_URL at all. Recognise both shapes, or a rebuild
# against the live API only ever "discovers" the handful of brand-new members
# still pointing at the raw CDN, silently losing any newly-added filerId for
# everyone already packed (see also filerIdAliases below, which depends on
# this).
BIOGUIDE_IN_PACK_URL = re.compile(r"/api/photos/member\?key=([A-Z]\d{6})(?:$|&)", re.I)


# Wikimedia throttles hard (HTTP 429) and asks bots to self-limit. Keep a
# per-host floor between requests and back off on 429/5xx rather than burning
# through the run and leaving half the executives unfilled.
HOST_MIN_INTERVAL = {"upload.wikimedia.org": 1.2, "commons.wikimedia.org": 1.2}
_last_hit: dict[str, float] = {}


def fetch(url: str, timeout: int = 45, attempts: int = 4) -> bytes:
    host = urllib.parse.urlparse(url).netloc
    floor = HOST_MIN_INTERVAL.get(host, 0.0)
    delay = 2.0
    last: Exception | None = None
    for attempt in range(attempts):
        if floor:
            gap = time.monotonic() - _last_hit.get(host, 0.0)
            if gap < floor:
                time.sleep(floor - gap)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read()
        except urllib.error.HTTPError as exc:
            last = exc
            # 404 is a real answer ("no such portrait"); retrying wastes time.
            if exc.code not in (429, 500, 502, 503, 504):
                raise
        except (urllib.error.URLError, OSError) as exc:
            last = exc
        finally:
            _last_hit[host] = time.monotonic()
        if attempt < attempts - 1:
            time.sleep(delay)
            delay *= 2
    raise last if last else RuntimeError(f"fetch failed: {url}")


def load_members(members_url: str | None, members_json: Path | None) -> list[dict]:
    if members_json:
        return json.loads(members_json.read_text(encoding="utf-8")).get("members", [])
    raw = fetch(members_url or MEMBERS_URL)
    return json.loads(raw.decode("utf-8")).get("members", [])


def congress_targets(members: list[dict]) -> dict[str, dict]:
    """bioguide -> {name, filerIds} for every member already keyed to the CDN."""
    targets: dict[str, dict] = {}
    for m in members:
        url = m.get("photoUrl") or ""
        match = BIOGUIDE_IN_URL.search(url) or BIOGUIDE_IN_PACK_URL.search(url)
        if not match:
            continue
        bioguide = match.group(1).upper()
        entry = targets.setdefault(
            bioguide, {"name": m.get("fullName") or bioguide, "filerIds": []}
        )
        filer_id = m.get("filerId")
        if filer_id and filer_id not in entry["filerIds"]:
            entry["filerIds"].append(filer_id)
    return targets


def save_face(image: Image.Image, path: Path) -> bytes:
    buf = io.BytesIO()
    image.save(buf, "WEBP", quality=fp.WEBP_QUALITY, method=6)
    data = buf.getvalue()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def process(
    key: str,
    name: str,
    branch: str,
    urls: list[str],
    licence: str,
    attribution: str | None,
    source_page: str | None,
    pack_dir: Path,
    bioguide: str | None = None,
    filer_ids: list[str] | None = None,
    attribution_caption: str | None = None,
) -> tuple[fp.FaceEntry | None, str | None]:
    """Download the first URL that works, crop, write. Returns (entry, error).

    ``attribution_caption`` is passed through when a curated ``sources.json``
    entry already froze one at discovery time; omitted, ``FaceEntry`` computes
    it from ``licence``/``attribution``/``source_page`` instead.
    """
    last_error = None
    for url in urls:
        try:
            raw = fetch(url)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            continue
        try:
            image = Image.open(io.BytesIO(raw))
            image.load()
        except Exception as exc:  # noqa: BLE001 - any decode failure is a skip
            last_error = f"decode failed: {exc}"
            continue
        face, mode, _ = fp.render_face(image)
        data = save_face(face, pack_dir / f"{key}.webp")
        return (
            fp.FaceEntry(
                key=key,
                name=name,
                branch=branch,
                file=f"{key}.webp",
                source_url=url,
                source_page=source_page,
                licence=licence,
                attribution=attribution,
                attribution_caption=attribution_caption,
                crop_mode=mode,
                bytes=len(data),
                sha256=fp.sha256_bytes(data),
                bioguide=bioguide,
                filer_ids=filer_ids or [],
            ),
            None,
        )
    return None, last_error or "no source url"


def contact_sheet(entries: list[fp.FaceEntry], pack_dir: Path, out: Path, cols: int = 10) -> None:
    cell, label = 128, 16
    rows = (len(entries) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * (cell + label)), "white")
    draw = ImageDraw.Draw(sheet)
    for i, entry in enumerate(sorted(entries, key=lambda e: (e.crop_mode != "fallback", e.key))):
        row, col = divmod(i, cols)
        img = Image.open(pack_dir / entry.file).convert("RGB").resize((cell, cell), Image.LANCZOS)
        sheet.paste(img, (col * cell, row * (cell + label)))
        tag = entry.key if entry.crop_mode == "face" else f"!{entry.key}"
        draw.text((col * cell + 2, row * (cell + label) + cell + 2), tag[:20], fill="black")
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--members-url", default=MEMBERS_URL)
    ap.add_argument("--members-json", type=Path, help="Offline /api/members payload instead of a live fetch.")
    ap.add_argument("--sources", type=Path, default=fp.SOURCES_PATH)
    ap.add_argument("--pack-dir", type=Path, default=fp.PACK_DIR)
    ap.add_argument("--only", choices=["congress", "executive"], help="Rebuild one branch only.")
    ap.add_argument("--keys", nargs="*", help="Rebuild only these pack keys.")
    ap.add_argument("--prune", action="store_true", help="Delete pack files no longer in the input set.")
    ap.add_argument("--contact-sheet", type=Path, help="Write a labelled QA grid of every face here.")
    ap.add_argument("--sleep", type=float, default=0.15, help="Delay between source fetches.")
    ap.add_argument(
        "--set-attribution-display",
        choices=["on", "off"],
        help=(
            "Flip whether attributionCaption is surfaced and exit. ON means pack-served "
            "photos carry an x-photo-attribution response header; there is no visible "
            "caption anywhere yet. Patches manifest.json in place -- no network calls, "
            "no re-crop."
        ),
    )
    args = ap.parse_args()

    if args.set_attribution_display is not None:
        manifest_path = args.pack_dir / "manifest.json"
        current = fp.load_manifest(manifest_path)
        if not current.get("faces"):
            print(f"no manifest at {manifest_path} to patch — build the pack first", file=sys.stderr)
            return 1
        enabled = args.set_attribution_display == "on"
        entries = [
            fp.FaceEntry(
                key=f["key"], name=f["name"], branch=f["branch"], file=f["file"],
                source_url=f["sourceUrl"], source_page=f.get("sourcePage"), licence=f["licence"],
                attribution=f.get("attribution"), attribution_caption=f.get("attributionCaption"),
                crop_mode=f.get("cropMode", "face"), bytes=f["bytes"], sha256=f["sha256"],
                bioguide=f.get("bioguide"), filer_ids=f.get("filerIds", []),
            )
            for f in current["faces"]
        ]
        fp.write_manifest(entries, manifest_path, attribution_display=enabled)
        print(f"attributionDisplayEnabled -> {enabled} ({manifest_path}, no images touched)")
        return 0

    if not fp.face_detection_available():
        print(
            "note: OpenCV not installed — every crop will use the deterministic "
            "fallback framing. Install requirements.txt for face-centred crops.",
            file=sys.stderr,
        )

    sources = json.loads(args.sources.read_text(encoding="utf-8"))
    pack_dir: Path = args.pack_dir
    pack_dir.mkdir(parents=True, exist_ok=True)

    entries: list[fp.FaceEntry] = []
    skipped: list[tuple[str, str]] = []
    wanted = set(args.keys or [])

    # Bioguides unitedstates/images does not carry (newly seated members, and
    # historical bioguides that predate photography) get a curated source.
    # Licence must be RECORDED to admit an entry; it no longer has to be
    # public domain (facepack.py; PD is still preferred where available via
    # discover_commons.py's ranking, before anything reaches this file).
    overrides = {o["bioguide"]: o for o in sources.get("congressOverrides", [])}
    # Duplicate identities that will never carry their own bioguide-shaped
    # photoUrl (a MANUAL-* or otherwise-orphaned filer id that is provably the
    # same person as an already-resolved bioguide, e.g. extracted under a
    # legal-name variant). Reuses that bioguide's image; no new download.
    filer_id_aliases: dict[str, str] = sources.get("filerIdAliases", {})

    if args.only != "executive":
        members = load_members(args.members_url, args.members_json)
        targets = congress_targets(members)
        for bioguide, override in overrides.items():
            targets.setdefault(bioguide, {"name": override["name"], "filerIds": override.get("filerIds", [])})
        alias_hits = 0
        for alias_filer_id, bioguide in filer_id_aliases.items():
            target = targets.get(bioguide)
            if not target:
                print(f"note: filerIdAlias {alias_filer_id!r} -> {bioguide!r} but that bioguide has no target this run")
                continue
            if alias_filer_id not in target["filerIds"]:
                target["filerIds"].append(alias_filer_id)
                alias_hits += 1
        print(f"congress: {len(targets)} bioguides from {len(members)} members "
              f"({len(overrides)} curated overrides, {alias_hits} filer-id aliases)")
        for bioguide, meta in sorted(targets.items()):
            key = bioguide
            if wanted and key not in wanted:
                continue
            override = overrides.get(bioguide)
            if override:
                licence = (override.get("licence") or "").strip()
                if not licence:
                    skipped.append((key, "no licence recorded — leaving a gap"))
                    continue
                urls = [override["sourceUrl"]]
                attribution, source_page = override.get("attribution"), override.get("sourcePage")
                attribution_caption = override.get("attributionCaption")
            else:
                urls = [
                    CONGRESS_SOURCE.format(bioguide=bioguide),
                    CONGRESS_FALLBACK.format(bioguide=bioguide),
                ]
                licence, attribution, source_page = (
                    CONGRESS_LICENCE,
                    CONGRESS_ATTRIBUTION,
                    CONGRESS_SOURCE_PAGE,
                )
                attribution_caption = None
            entry, err = process(
                key=key,
                name=meta["name"],
                branch="congress",
                urls=urls,
                licence=licence,
                attribution=attribution,
                source_page=source_page,
                pack_dir=pack_dir,
                bioguide=bioguide,
                filer_ids=meta["filerIds"],
                attribution_caption=attribution_caption,
            )
            if entry:
                entries.append(entry)
            else:
                skipped.append((key, err or "unknown"))
            time.sleep(args.sleep)

    if args.only != "congress":
        execs = sources.get("executives", [])
        print(f"executive: {len(execs)} curated entries")
        for item in execs:
            key = item["key"]
            if wanted and key not in wanted:
                continue
            licence = (item.get("licence") or "").strip()
            if not licence:
                skipped.append((key, "no licence recorded — leaving a gap"))
                continue
            if not item.get("sourceUrl"):
                skipped.append((key, "no sourceUrl — left as a gap for the owner"))
                continue
            entry, err = process(
                key=key,
                name=item["name"],
                branch="executive",
                urls=[item["sourceUrl"]],
                licence=licence,
                attribution=item.get("attribution"),
                source_page=item.get("sourcePage"),
                pack_dir=pack_dir,
                filer_ids=item.get("filerIds", []),
                attribution_caption=item.get("attributionCaption"),
            )
            if entry:
                entries.append(entry)
            else:
                skipped.append((key, err or "unknown"))
            time.sleep(args.sleep)

    # Merge with anything already in the manifest that this run did not touch,
    # so `--only` / `--keys` runs never silently drop the other half.
    existing_manifest = fp.load_manifest(pack_dir / "manifest.json")
    existing = {f["key"]: f for f in existing_manifest.get("faces", [])}
    produced = {e.key for e in entries}
    merged = list(entries)
    for key, raw in existing.items():
        if key in produced:
            continue
        if not (pack_dir / raw["file"]).exists():
            continue
        merged.append(
            fp.FaceEntry(
                key=raw["key"],
                name=raw["name"],
                branch=raw["branch"],
                file=raw["file"],
                source_url=raw["sourceUrl"],
                source_page=raw.get("sourcePage"),
                licence=raw["licence"],
                attribution=raw.get("attribution"),
                attribution_caption=raw.get("attributionCaption"),
                crop_mode=raw.get("cropMode", "face"),
                bytes=raw["bytes"],
                sha256=raw["sha256"],
                bioguide=raw.get("bioguide"),
                filer_ids=raw.get("filerIds", []),
            )
        )

    if args.prune:
        keep = {e.file for e in merged}
        for path in pack_dir.glob("*.webp"):
            if path.name not in keep:
                path.unlink()
                print(f"pruned {path.name}")

    # A partial (`--only` / `--keys`) run must not silently reset the display
    # flag to its code default -- carry forward whatever is already on disk.
    attribution_display = existing_manifest.get("attributionDisplayEnabled", fp.ATTRIBUTION_DISPLAY_ENABLED)
    payload = fp.write_manifest(merged, pack_dir / "manifest.json", attribution_display=attribution_display)

    fallbacks = [e.key for e in merged if e.crop_mode == "fallback"]
    print(f"\nwrote {payload['count']} faces, {payload['totalBytes'] / 1e6:.2f} MB total")
    print(f"face-detected crops: {payload['count'] - len(fallbacks)}, fallback crops: {len(fallbacks)}")
    print(
        f"licence: {payload['count'] - payload['nonPublicDomainCount']} public domain, "
        f"{payload['nonPublicDomainCount']} not (attributionDisplayEnabled={payload['attributionDisplayEnabled']})"
    )
    if payload["nonPublicDomainCount"]:
        for e in sorted(merged, key=lambda e: e.key):
            if fp.licence_tier(e.licence) != 0:
                print(f"  non-PD: {e.key} ({e.name}) — {e.licence}")
    if fallbacks:
        print("  fallback (eyeball these on the contact sheet): " + ", ".join(sorted(fallbacks)))
    if skipped:
        print(f"\nskipped {len(skipped)} — these stay as gaps:")
        for key, why in skipped:
            print(f"  {key}: {why}")

    if args.contact_sheet:
        contact_sheet(merged, pack_dir, args.contact_sheet)
        print(f"\ncontact sheet: {args.contact_sheet}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
