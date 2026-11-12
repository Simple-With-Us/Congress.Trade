# Member face pack

Our own repository of member portraits: one square, head-focused 256px WebP per
person under `app/public/assets/member-photos/`, plus a `manifest.json` that
records where each original came from, under what licence, and a ready-to-use
attribution caption.

## Why it exists

Before this, `filers.photo_url` was a hotlink to
`unitedstates.github.io/images/congress/450x550/{bioguide}.jpg`.  That is a good
public-domain source, but it left three problems on the live site:

| Problem | Effect |
| --- | --- |
| Only covers people with a bioguide | Every executive-branch filer — cabinet secretaries, agency heads, Senate-confirmed nominees — had no photo at all |
| Some stored bioguides 404 upstream | The dashboard's `onerror="this.remove()"` hid the breakage instead of reporting it |
| Framing is head **and torso** | In a circular row avatar the face lands small and off-centre |

The pack fixes all three, and it costs about 2.4 MB in the repo for ~340 faces.

## Running it

```bash
python3 -m venv .venv
.venv/bin/pip install -r scripts/member-photos/requirements.txt

# Rebuild everything from the live member list.
.venv/bin/python scripts/member-photos/build_face_pack.py \
    --contact-sheet /tmp/faces.png

# One person, or one branch.
.venv/bin/python scripts/member-photos/build_face_pack.py --keys B001300
.venv/bin/python scripts/member-photos/build_face_pack.py --only executive
```

Re-run it whenever new members show up in `/api/members`; the congressional
bioguide set is derived from that response, so nothing has to be listed by hand.

**Always look at the contact sheet.**  It is the only cheap way to catch a
detector that quietly framed somebody's chin.  Faces cropped without a face
detection are prefixed `!` on the sheet and listed in the run output.

## Sources and licences

**Policy (owner decision, 2026-08): the licence check is a RECORD, not a gate.**
Public domain is no longer required to ship a face — a non-free portrait's real
exposure is a DMCA takedown to Apple (which pulls the app), not a lawsuit, and
that risk is accepted. What is *not* negotiable:

1. **A licence must still be recorded.** `facepack.is_public_domain_licence`
   still runs on every candidate and the result is still written to
   `manifest.json` (`licence`, `licenceTier`) — it just no longer rejects.
   The only thing that drops a candidate on licence grounds now is having
   **no** recognisable licence at all (rare: Commons requires one to host a
   file). A gap stays cheaper than a face nobody can attribute.
2. **Public domain is still preferred where it exists.**
   `facepack.licence_tier` ranks every admitted candidate 0 (public domain) ..
   1 (plain-attribution CC BY) .. 2 (CC BY-SA) .. 3 (everything else, incl.
   NC/ND-restricted combinations), and `discover_commons.py` sorts by that
   before score, so widening the net never bumps a clean image in favour of an
   encumbered one for the same person.
3. **Attribution is always captured, never optional.** Every entry — PD or
   not — gets `licence`, `attribution` (the author/Artist) and
   `attributionCaption` (a frozen "Author — Licence, via Site" string). That
   data is free to capture at discovery time and expensive to reconstruct
   later if a page gets re-edited or a file gets renamed on Commons.
4. **Attribution *display* is a separate, flagged decision, default OFF.**
   `manifest.json`'s `attributionDisplayEnabled` (and
   `memberPhotoPack.ts`'s `visibleAttributionCaption()`) gate whether the
   captured caption is surfaced at all. Today that flag drives exactly one
   thing: the `x-photo-attribution` response header on pack-served photos.
   No visible credit line exists in the web UI or the SwiftUI clients yet —
   see [Attribution display flag](#attribution-display-flag) for what the
   flag does and does not cover.
5. **The identity bar does not move.** Widening licence never widens who
   counts as "the right person" — see Cropping/contact-sheet below. A wrong
   face is a worse product bug than an unattributed one; an unlicensed-but-
   correct face is now an accepted, recorded trade-off.

Where each face comes from:

* **Congress** — `unitedstates/images`, public domain, keyed by bioguide.
  Nothing to curate; the script resolves these automatically.
* **Executive, and bioguides upstream does not carry** — curated in
  `sources.json`.  Each entry names the Wikimedia Commons file, the direct
  source URL, the verified licence, the attribution and (frozen at discovery
  time) the attribution caption.
* **Filer-id aliases** — `sources.json`'s `filerIdAliases` maps a filer id that
  will never carry its own bioguide-shaped `photoUrl` (a duplicate identity
  extracted under a legal-name variant, e.g. a `MANUAL-*` Senate-side inject of
  someone already packed under their common name) onto the bioguide that
  already has the image. Reuses the byte-identical file; nothing new to
  download or licence.

`discover_commons.py` produces `sources.json` candidate entries. It searches
Commons, then asks the API for `extmetadata.LicenseShortName` /
`Artist` / `UsageTerms` and records — never discards — whatever it finds:

```bash
.venv/bin/python scripts/member-photos/discover_commons.py \
    --names-file names.txt --json /tmp/candidates.json

# Describe one exact file (never hand-write an upload.wikimedia.org URL —
# the path contains an MD5 shard you cannot derive from the file name).
.venv/bin/python scripts/member-photos/discover_commons.py \
    --file "File:ED Sec Linda McMahon (cropped).jpg"
```

Candidates are scored for identity first, independent of licence: the file
title must contain the subject's surname, and group shots, landscape framing
and hearing screengrabs are pushed down. Licence only breaks ties between
identity-plausible candidates (point 2 above). **The licence and identity
checks are both automated; only the identity check needs a human.** Review the
candidate list, then verify the built faces on the contact sheet.

If a person has no candidate with a recorded licence at all, or no candidate
anyone is confident is actually them, leave them out and record why in the
`unresolved` block of `sources.json`. A gap is cheaper than a wrong or
unattributable face on a public site.

## Attribution display flag

`manifest.json` always carries `attributionDisplayEnabled` (boolean,
top-level) and, per face, `attributionCaption` (string, always populated).
Capture and display are deliberately decoupled:

```bash
# Flip the flag. Patches manifest.json in place — no network calls, no
# re-crop, no re-source. Safe to run any time; the images never move.
.venv/bin/python scripts/member-photos/build_face_pack.py \
    --set-attribution-display on
.venv/bin/python scripts/member-photos/build_face_pack.py \
    --set-attribution-display off
```

On the serving side, `memberPhotoPack.ts` exposes `attributionDisplayEnabled()`
and `visibleAttributionCaption(face)` — the latter returns `null` while the
flag is off, and the caption once it's on.

**What the flag actually reaches today — be precise about this.** Its one live
consumer is `tryLocalMemberPhoto`: with the flag ON, every pack-served photo
comes back with an `x-photo-attribution` response header carrying that face's
credit line; with it OFF, the header is absent. That is the complete list.
There is **no visible caption** under any avatar — not in the dashboard HTML,
not in any `/api/client/v1/*` payload, not in the SwiftUI clients. Attribution
is *recorded* for every face and *served as a header*; it is not *displayed*.

So flipping the flag is not, on its own, a complete answer to a takedown
request. It is the lever that makes what we serve self-describing, and it is
the single switch a future credit-line UI hooks into. Two limits worth stating
plainly:

* **Building the visible surface is still work.** When someone adds a credit
  line under an avatar, it must call `visibleAttributionCaption()` rather than
  reading `face.attributionCaption` directly — that is what keeps one flag
  governing every surface instead of an audit per call site.
* **Caching delays the flip.** Pack images are served with a one-year
  `max-age`, so a flag flip changes the origin immediately but reaches
  already-cached clients only as their copies expire.

An actual takedown for a specific face is still handled the direct way: drop
the entry from `sources.json`, rebuild, and the face is gone.

## Cropping

`facepack.head_crop_box` derives a square from the detected face box, reserving
`0.62` face-heights of headroom above and `0.85` below.  When the image is too
small for the ideal square, both reservations shrink by the same factor so the
face keeps its relative position.

Face detection (OpenCV Haar cascade) is **optional**.  Without it — or when
detection fails — the crop falls back to a top-anchored square covering 72% of
the image height, which is safe for a standard studio portrait.  The fallback is
deliberately loose: a bad detection should degrade to "slightly wide", never to
"top of head missing".

## Serving

`app/src/enrichment/memberPhotoPack.ts` reads the manifest once per process and
serves `GET /api/photos/member?key=…`:

1. the committed pack (one-year cache — faces only change on redeploy),
2. for a bioguide-shaped key, the upstream public-domain CDN (one-day cache),
3. otherwise a short-cached `204` — not a `404`, so a miss does not error in the
   browser console.

`runPhotoEnrichment` (`app/src/admin/routes.ts`) writes the **absolute** pack URL
into `filers.photo_url` for anyone the pack covers, and fills executive filers by
filer id.  Absolute, because `photo_url` is handed to the SwiftUI clients as-is
and a path-only value would not resolve there.
