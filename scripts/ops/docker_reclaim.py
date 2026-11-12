#!/usr/bin/env python3
"""Plan a safe Docker reclaim from `docker system df -v` plus inspect records.

The planner never runs Docker. The shell wrapper executes the action list
only when APPLY=1, and only after a second allowlist check.

Sizes in the report come from `docker system df -v`. Exact ages, Coolify
labels, and rollback images come from inspect records, because the verbose
table's relative timestamps are not safe enough to decide a prune.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path


class SnapshotError(Exception):
    """The collected Docker output is not safe to plan from."""


_SIZE_RE = re.compile(r"^([0-9]+(?:\.[0-9]+)?)([KMGT]I?B|B)$", re.IGNORECASE)
_SIZE_SCALE = {
    "B": 1,
    "KB": 1000,
    "MB": 1000**2,
    "GB": 1000**3,
    "TB": 1000**4,
    "KIB": 1024,
    "MIB": 1024**2,
    "GIB": 1024**3,
    "TIB": 1024**4,
}
_RELATIVE_RE = re.compile(
    r"^(?:about\s+)?(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$"
)
_RELATIVE_SECONDS = {
    "second": 1,
    "minute": 60,
    "hour": 3600,
    "day": 86400,
    "week": 7 * 86400,
    "month": 30 * 86400,
    "year": 365 * 86400,
}
_UNTIL_RE = re.compile(r"^[1-9][0-9]*h$")
_ANON_VOLUME_RE = re.compile(r"^[a-f0-9]{64}$")
_HEX_ID_RE = re.compile(r"^[0-9a-f]{64}$")
_UUID_REPO_RE = re.compile(
    r"(?:^|/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_APP_ID_LABELS = (
    "coolify.applicationId",
    "coolify.application_id",
    "coolify.applicationUuid",
    "coolify.serviceId",
    "coolify.serviceUuid",
    "coolify.uuid",
    "coolify.databaseId",
    "coolify.databaseUuid",
    "coolify.resourceId",
)
_APP_PART_LABELS = (
    "coolify.type",
    "coolify.projectName",
    "coolify.environmentName",
    "coolify.serviceName",
    "coolify.resourceName",
    "coolify.pullRequestId",
)
_VOLATILE_LABELS = frozenset({"coolify.managed", "coolify.version"})
_STOPPED_STATUSES = frozenset({"exited", "dead", "created"})
_LIVE_STATUSES = frozenset({"running", "paused", "restarting", "removing"})
_IMAGE_HEADERS = (
    "REPOSITORY",
    "TAG",
    "IMAGE ID",
    "CREATED",
    "SIZE",
    "SHARED SIZE",
    "UNIQUE SIZE",
    "CONTAINERS",
)
_CONTAINER_HEADERS = (
    "CONTAINER ID",
    "IMAGE",
    "COMMAND",
    "LOCAL VOLUMES",
    "SIZE",
    "CREATED",
    "STATUS",
    "NAMES",
)
_VOLUME_HEADERS = ("VOLUME NAME", "LINKS", "SIZE")
_CACHE_HEADERS = (
    "CACHE ID",
    "CACHE TYPE",
    "SIZE",
    "CREATED",
    "LAST USED",
    "USAGE",
    "SHARED",
)


@dataclass
class ImageRec:
    full_id: str
    created: datetime | None
    repo_tags: list[str]
    labels: dict[str, str]
    inspect_size: int
    unique_size: int
    df_containers: int | None
    repos: list[str] = field(default_factory=list)

    @property
    def dangling(self) -> bool:
        tags = [tag for tag in self.repo_tags if tag and tag != "<none>:<none>"]
        return not tags


@dataclass
class ContainerRec:
    full_id: str
    image_id: str
    name: str
    created: datetime | None
    status: str
    finished_at: datetime | None
    started_at: datetime | None
    labels: dict[str, str]
    df_status: str
    size: int


@dataclass
class VolumeRec:
    name: str
    labels: dict[str, str]
    links: int | None
    size: int
    in_df: bool


@dataclass
class CacheRec:
    cache_id: str
    size: int
    last_used: datetime | None


@dataclass(frozen=True)
class Action:
    kind: str
    value: str


@dataclass
class Plan:
    report: str
    actions: list[Action]


def parse_size(text: str) -> int:
    raw = text.strip().replace(" ", "")
    if not raw:
        raise SnapshotError("empty size")
    match = _SIZE_RE.match(raw)
    if not match:
        raise SnapshotError("unparsed size")
    number = float(match.group(1))
    unit = match.group(2).upper()
    return int(round(number * _SIZE_SCALE[unit]))


def human_size(nbytes: int) -> str:
    value = float(max(nbytes, 0))
    for unit in ("B", "kB", "MB", "GB", "TB"):
        if value < 1000 or unit == "TB":
            if unit == "B":
                return f"{int(value)}B"
            return f"{value:.1f}{unit}"
        value /= 1000.0
    return f"{int(value)}B"


def parse_time(value: object) -> datetime | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.startswith("0001-01-01"):
        return None
    if text.endswith(" UTC"):
        text = text[: -len(" UTC")].strip()
    if " +0000" in text and "T" not in text:
        text = text.replace(" +0000", "+00:00")
        text = text.replace(" ", "T", 1)
    text = text.replace("Z", "+00:00")
    if "." in text:
        head, tail = text.split(".", 1)
        digits: list[str] = []
        rest = tail
        while rest and rest[0].isdigit() and len(digits) < 6:
            digits.append(rest[0])
            rest = rest[1:]
        rest = rest.lstrip("0123456789")
        text = head + ("." + "".join(digits) if digits else "") + rest
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise SnapshotError("unparsed timestamp") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_relative(text: str, now: datetime) -> datetime | None:
    cleaned = " ".join(text.strip().lower().split())
    if cleaned in {"", "n/a", "na", "*"}:
        return None
    if cleaned == "less than a second ago":
        return now
    if cleaned == "about a minute ago":
        return now - timedelta(seconds=60)
    if cleaned == "about an hour ago":
        return now - timedelta(hours=1)
    match = _RELATIVE_RE.match(cleaned)
    if not match:
        return None
    seconds = int(match.group(1)) * _RELATIVE_SECONDS[match.group(2)]
    return now - timedelta(seconds=seconds)


def parse_until(text: str) -> timedelta:
    if not _UNTIL_RE.match(text):
        raise SnapshotError("build cache age must look like 72h")
    return timedelta(hours=int(text[:-1]))


def norm_id(value: object) -> str:
    text = str(value or "").strip().lower()
    if text.startswith("sha256:"):
        text = text[len("sha256:") :]
    return text


def coolify_map(labels: dict[str, str]) -> dict[str, str]:
    return {
        key: value
        for key, value in labels.items()
        if key.startswith("coolify.")
    }


def has_coolify(labels: dict[str, str]) -> bool:
    return any(key.startswith("coolify.") for key in labels)


def app_key(labels: dict[str, str]) -> str | None:
    coolify = coolify_map(labels)
    if not coolify:
        return None
    for key in _APP_ID_LABELS:
        value = coolify.get(key, "")
        if value:
            return f"{key}={value}"
    parts = [
        f"{key}={coolify[key]}"
        for key in _APP_PART_LABELS
        if coolify.get(key, "")
    ]
    if parts:
        return "|".join(parts)
    stable = sorted(
        f"{key}={value}"
        for key, value in coolify.items()
        if key not in _VOLATILE_LABELS and value
    )
    if stable:
        return "|".join(stable)
    return "coolify.unidentified"


def repo_of(tag: str) -> str:
    slash = tag.rfind("/")
    colon = tag.rfind(":")
    if colon > slash:
        return tag[:colon]
    return tag


def is_control_plane_container(name: str) -> bool:
    base = name.lstrip("/").strip().lower()
    return base == "coolify" or base.startswith("coolify-")


def is_control_plane_image(repos: list[str]) -> bool:
    for repo in repos:
        lowered = repo.lower()
        if "coollabsio/coolify" in lowered:
            return True
        leaf = lowered.rsplit("/", 1)[-1]
        if leaf == "coolify" or leaf.startswith("coolify-"):
            return True
    return False


def _labels_from(value: object) -> dict[str, str]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return {
            str(key): "" if item is None else str(item)
            for key, item in value.items()
            if isinstance(key, str)
        }
    if not isinstance(value, str):
        raise SnapshotError("labels were not a string or object")
    text = value.strip()
    if text in {"", "N/A", "map[]"}:
        return {}
    if text.startswith("map[") and text.endswith("]"):
        labels: dict[str, str] = {}
        for part in text[len("map[") : -1].split():
            if ":" not in part:
                continue
            key, raw = part.split(":", 1)
            if key:
                labels[key] = raw
        return labels
    labels = {}
    for part in text.split(","):
        if "=" not in part:
            continue
        key, raw = part.split("=", 1)
        key = key.strip()
        if key:
            labels[key] = raw.strip()
    return labels


def _column_starts(header: str, names: tuple[str, ...]) -> list[tuple[str, int]] | None:
    positions: list[tuple[str, int]] = []
    cursor = 0
    for name in names:
        found = header.find(name, cursor)
        if found < 0:
            return None
        positions.append((name, found))
        cursor = found + len(name)
    return positions


def _slice_row(line: str, positions: list[tuple[str, int]]) -> dict[str, str]:
    columns: dict[str, str] = {}
    for index, (name, start) in enumerate(positions):
        end = positions[index + 1][1] if index + 1 < len(positions) else len(line)
        if start >= len(line):
            columns[name] = ""
        else:
            columns[name] = line[start:min(end, len(line))].strip()
    return columns


def _lookup_header(
    header: str, candidates: tuple[tuple[str, ...], ...]
) -> list[tuple[str, int]] | None:
    for names in candidates:
        found = _column_starts(header, names)
        if found is not None:
            return found
    return None


def parse_df_verbose(text: str) -> dict[str, list[dict[str, str]]]:
    lines = [line.rstrip("\r") for line in text.splitlines()]
    sections = {"images": [], "containers": [], "volumes": [], "cache": []}
    index = 0
    while index < len(lines):
        title = lines[index].strip()
        if title.startswith("Images space usage"):
            kind = "images"
            headers = (_IMAGE_HEADERS, _IMAGE_HEADERS[:5] + ("CONTAINERS",))
        elif title.startswith("Containers space usage"):
            kind = "containers"
            headers = (_CONTAINER_HEADERS,)
        elif title.startswith("Local Volumes space usage"):
            kind = "volumes"
            headers = (_VOLUME_HEADERS,)
        elif title.startswith("Build cache usage"):
            kind = "cache"
            headers = (
                _CACHE_HEADERS,
                ("ID",) + _CACHE_HEADERS[1:],
            )
        else:
            index += 1
            continue
        index += 1
        while index < len(lines) and not lines[index].strip():
            index += 1
        if index >= len(lines):
            break
        positions = _lookup_header(lines[index], headers)
        if positions is None:
            raise SnapshotError(f"unparsed {kind} table")
        index += 1
        while index < len(lines) and lines[index].strip():
            row_title = lines[index].strip()
            if row_title.endswith("space usage:") or row_title.startswith("Build cache usage"):
                break
            sections[kind].append(_slice_row(lines[index], positions))
            index += 1
    if not sections["images"] and "REPOSITORY" not in text and "Images space usage" not in text:
        raise SnapshotError("docker system df -v had no images section")
    return sections


def _load_jsonl(path: Path) -> list[dict[str, object]]:
    if not path.is_file():
        raise SnapshotError(f"missing {path.name}")
    records: list[dict[str, object]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise SnapshotError(f"unparsed {path.name}") from exc
        if not isinstance(value, dict):
            raise SnapshotError(f"unparsed {path.name}")
        records.append(value)
    return records


def _require_text(path: Path) -> str:
    if not path.is_file():
        raise SnapshotError(f"missing {path.name}")
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        raise SnapshotError(f"empty {path.name}")
    return text


def _match_id(short: str, full_ids: list[str]) -> str:
    token = norm_id(short)
    if not token or not re.fullmatch(r"[0-9a-f]+", token):
        raise SnapshotError("unparsed object id")
    hits = [full for full in full_ids if full.startswith(token) or token.startswith(full)]
    if len(hits) != 1:
        raise SnapshotError("ambiguous object id")
    return hits[0]


def _assert_unique_prefixes(full_ids: list[str]) -> None:
    seen: dict[str, str] = {}
    for full in full_ids:
        prefix = full[:12]
        prior = seen.get(prefix)
        if prior is not None and prior != full:
            raise SnapshotError("ambiguous object id")
        seen[prefix] = full


def _image_repos(tags: list[str]) -> list[str]:
    repos: list[str] = []
    for tag in tags:
        if not tag or tag == "<none>:<none>":
            continue
        repo = repo_of(tag)
        if repo and repo not in repos:
            repos.append(repo)
    return repos


def _parse_links(value: str) -> int | None:
    text = value.strip()
    if not text or text.upper() == "N/A":
        return None
    if not re.fullmatch(r"\d+", text):
        return None
    return int(text)


def load_snapshot(input_dir: Path, now: datetime) -> tuple[str, list[ImageRec], list[ContainerRec], list[VolumeRec], list[CacheRec]]:
    summary = _require_text(input_dir / "df-summary.txt")
    verbose = parse_df_verbose(_require_text(input_dir / "df-verbose.txt"))
    image_rows = _load_jsonl(input_dir / "images.jsonl")
    container_rows = _load_jsonl(input_dir / "containers.jsonl")
    volume_rows = _load_jsonl(input_dir / "volumes.jsonl")

    images: list[ImageRec] = []
    for row in image_rows:
        full = norm_id(row.get("Id"))
        if not _HEX_ID_RE.fullmatch(full):
            raise SnapshotError("image id was not 64 hex characters")
        tags_raw = row.get("RepoTags")
        if tags_raw is None:
            tags: list[str] = []
        elif isinstance(tags_raw, list):
            tags = [str(tag) for tag in tags_raw if tag is not None]
        else:
            raise SnapshotError("image tags were not a list")
        size_raw = row.get("Size", 0)
        if not isinstance(size_raw, int):
            raise SnapshotError("image size was not an integer")
        images.append(
            ImageRec(
                full_id=full,
                created=parse_time(row.get("Created")),
                repo_tags=tags,
                labels=_labels_from(row.get("Labels")),
                inspect_size=size_raw,
                unique_size=size_raw,
                df_containers=None,
                repos=_image_repos(tags),
            )
        )
    _assert_unique_prefixes([image.full_id for image in images])
    image_ids = [image.full_id for image in images]
    images_by_id = {image.full_id: image for image in images}
    seen_images: set[str] = set()
    for row in verbose["images"]:
        matched = _match_id(row.get("IMAGE ID", ""), image_ids)
        if matched in seen_images:
            raise SnapshotError("duplicate image in docker system df -v")
        seen_images.add(matched)
        image = images_by_id[matched]
        if row.get("UNIQUE SIZE", ""):
            image.unique_size = parse_size(row["UNIQUE SIZE"])
        elif row.get("SIZE", ""):
            image.unique_size = parse_size(row["SIZE"])
        else:
            raise SnapshotError("image size was missing from docker system df -v")
        containers_text = row.get("CONTAINERS", "").strip()
        if containers_text:
            if not re.fullmatch(r"\d+", containers_text):
                raise SnapshotError("unparsed image container count")
            image.df_containers = int(containers_text)
    if len(seen_images) != len(images):
        raise SnapshotError("docker system df -v omitted an image")

    containers: list[ContainerRec] = []
    for row in container_rows:
        full = norm_id(row.get("Id"))
        image_id = norm_id(row.get("Image"))
        if not _HEX_ID_RE.fullmatch(full) or not _HEX_ID_RE.fullmatch(image_id):
            raise SnapshotError("container id was not 64 hex characters")
        status = str(row.get("Status") or "").strip().lower()
        if not status:
            raise SnapshotError("container status was empty")
        containers.append(
            ContainerRec(
                full_id=full,
                image_id=image_id,
                name=str(row.get("Name") or ""),
                created=parse_time(row.get("Created")),
                status=status,
                finished_at=parse_time(row.get("FinishedAt")),
                started_at=parse_time(row.get("StartedAt")),
                labels=_labels_from(row.get("Labels")),
                df_status="",
                size=0,
            )
        )
    _assert_unique_prefixes([container.full_id for container in containers])
    container_ids = [container.full_id for container in containers]
    containers_by_id = {container.full_id: container for container in containers}
    seen_containers: set[str] = set()
    for row in verbose["containers"]:
        matched = _match_id(row.get("CONTAINER ID", ""), container_ids)
        if matched in seen_containers:
            raise SnapshotError("duplicate container in docker system df -v")
        seen_containers.add(matched)
        container = containers_by_id[matched]
        container.df_status = row.get("STATUS", "")
        container.size = parse_size(row.get("SIZE", "") or "0B")
    if len(seen_containers) != len(containers):
        raise SnapshotError("docker system df -v omitted a container")

    volumes_by_name: dict[str, VolumeRec] = {}
    for row in volume_rows:
        name = str(row.get("Name") or "").strip()
        if not name:
            raise SnapshotError("volume name was empty")
        links = _parse_links(str(row.get("Links") or ""))
        volumes_by_name[name] = VolumeRec(
            name=name,
            labels=_labels_from(row.get("Labels")),
            links=links,
            size=0,
            in_df=False,
        )
    seen_volumes: set[str] = set()
    for row in verbose["volumes"]:
        name = row.get("VOLUME NAME", "").strip()
        if not name:
            raise SnapshotError("volume name was empty")
        if name in seen_volumes:
            raise SnapshotError("duplicate volume in docker system df -v")
        seen_volumes.add(name)
        if name not in volumes_by_name:
            raise SnapshotError("docker system df -v listed a volume inspect did not")
        volume = volumes_by_name[name]
        volume.in_df = True
        volume.size = parse_size(row.get("SIZE", "") or "0B")
        df_links = _parse_links(row.get("LINKS", ""))
        if df_links is None:
            volume.links = None
        elif volume.links is None:
            volume.links = df_links
        elif volume.links != df_links:
            volume.links = None

    cache: list[CacheRec] = []
    for row in verbose["cache"]:
        cache_id = (row.get("CACHE ID") or row.get("ID") or "").strip()
        last_used = parse_relative(row.get("LAST USED", ""), now)
        cache.append(
            CacheRec(
                cache_id=cache_id,
                size=parse_size(row.get("SIZE", "") or "0B"),
                last_used=last_used,
            )
        )
    return summary, images, containers, list(volumes_by_name.values()), cache


def _older_than(moment: datetime | None, now: datetime, days: int) -> bool:
    if moment is None:
        return False
    return moment < now - timedelta(days=days)


def _container_recent(container: ContainerRec, now: datetime, days: int) -> bool:
    if container.status in _LIVE_STATUSES:
        return True
    cutoff = now - timedelta(days=days)
    if container.finished_at is not None and container.finished_at >= cutoff:
        return True
    return False


def _df_status_is_live(status: str) -> bool:
    text = status.strip().lower()
    if text.startswith("restart") or text.startswith("paused") or text.startswith("removing"):
        return True
    return text.startswith("up") and not text.startswith("upper")


def _select_group(
    members: list[ImageRec], referenced: set[str]
) -> tuple[set[str], set[str]]:
    if not members:
        return set(), set()
    ordered = sorted(
        members,
        key=lambda image: (
            image.created or datetime.min.replace(tzinfo=timezone.utc),
            image.full_id,
        ),
        reverse=True,
    )
    keep = {image.full_id for image in ordered if image.created is None}
    previous: set[str] = set()
    in_use = [
        image
        for image in ordered
        if image.full_id in referenced and image.created is not None
    ]
    if not in_use:
        dated = [image for image in ordered if image.created is not None]
        for image in dated[:2]:
            keep.add(image.full_id)
        if len(dated) >= 2:
            previous.add(dated[1].full_id)
        elif dated:
            previous.add(dated[0].full_id)
        return keep, previous
    # Previous means the image immediately before the newest in-use image.
    # An older stopped container still keeps its own image through the
    # referenced-image rule, without pinning every generation in between.
    newest = max(in_use, key=lambda image: (image.created, image.full_id))
    for image in ordered:
        if image.created is not None and image.created >= newest.created:
            keep.add(image.full_id)
    older = [
        image
        for image in ordered
        if image.created is not None and image.created < newest.created
    ]
    if older:
        keep.add(older[0].full_id)
        previous.add(older[0].full_id)
    return keep, previous


def _uuid_repos(image: ImageRec) -> list[str]:
    return [repo.lower() for repo in image.repos if _UUID_REPO_RE.search(repo)]


def rollback_sets(
    images: list[ImageRec], containers: list[ContainerRec]
) -> tuple[set[str], set[str]]:
    by_id = {image.full_id: image for image in images}
    referenced = {container.image_id for container in containers if container.image_id in by_id}
    by_repo: dict[str, list[ImageRec]] = {}
    for image in images:
        for repo in _uuid_repos(image):
            by_repo.setdefault(repo, []).append(image)
    by_app: dict[str, list[ImageRec]] = {}
    for image in images:
        key = app_key(image.labels)
        if key:
            by_app.setdefault(key, []).append(image)
    for container in containers:
        key = app_key(container.labels)
        image = by_id.get(container.image_id)
        if not key or image is None:
            continue
        members = by_app.setdefault(key, [])
        if all(existing.full_id != image.full_id for existing in members):
            members.append(image)

    def expand(members: list[ImageRec]) -> list[ImageRec]:
        chosen = list(members)
        seen = {image.full_id for image in chosen}
        repos: set[str] = set()
        for image in members:
            repos.update(_uuid_repos(image))
        for repo in repos:
            for image in by_repo.get(repo, []):
                if image.full_id not in seen:
                    chosen.append(image)
                    seen.add(image.full_id)
        return chosen

    claimed: set[str] = set()
    keep: set[str] = set()
    previous: set[str] = set()
    for members in by_app.values():
        expanded = expand(members)
        claimed.update(image.full_id for image in expanded)
        group_keep, group_previous = _select_group(expanded, referenced)
        keep |= group_keep
        previous |= group_previous
    for members in by_repo.values():
        if any(image.full_id in claimed for image in members):
            continue
        group_keep, group_previous = _select_group(members, referenced)
        keep |= group_keep
        previous |= group_previous
    return keep, previous


def _count_line(name: str, count: int, nbytes: int) -> str:
    return f"{name} count={count} bytes={nbytes} human={human_size(nbytes)}"


def build_plan(
    *,
    summary: str,
    images: list[ImageRec],
    containers: list[ContainerRec],
    volumes: list[VolumeRec],
    cache: list[CacheRec],
    now: datetime,
    image_min_age_days: int,
    container_min_age_days: int,
    coolify_recent_days: int,
    build_cache_until: str,
    mode: str,
) -> Plan:
    if image_min_age_days < 1 or container_min_age_days < 1 or coolify_recent_days < 1:
        raise SnapshotError("age windows must be at least 1 day")
    if mode not in {"dry-run", "apply"}:
        raise SnapshotError("mode must be dry-run or apply")
    until = parse_until(build_cache_until)
    images_by_id = {image.full_id: image for image in images}
    for container in containers:
        if container.image_id not in images_by_id:
            raise SnapshotError("container image was not in the image list")
    referenced = {container.image_id for container in containers}
    for image in images:
        if image.df_containers is not None and image.df_containers > 0 and image.full_id not in referenced:
            raise SnapshotError("df -v says an image has containers that inspect did not list")
    live_apps: set[str] = set()
    for container in containers:
        key = app_key(container.labels)
        if key and _container_recent(container, now, coolify_recent_days):
            live_apps.add(key)
    rollback_keep, previous_ids = rollback_sets(images, containers)

    actions: list[Action] = []
    held_containers: list[str] = []
    prunable_containers: list[ContainerRec] = []
    for container in containers:
        reason = _container_hold_reason(
            container,
            now=now,
            min_age_days=container_min_age_days,
            live_apps=live_apps,
        )
        if reason is None:
            prunable_containers.append(container)
            actions.append(Action("container", container.full_id))
        else:
            held_containers.append(f"keep_container {container.full_id} reason={reason}")

    prunable_dangling: list[ImageRec] = []
    prunable_tagged: list[ImageRec] = []
    held_images: list[str] = []
    for image in images:
        reason = _image_hold_reason(
            image,
            now=now,
            min_age_days=image_min_age_days,
            referenced=referenced,
            rollback_keep=rollback_keep,
            previous_ids=previous_ids,
        )
        if reason is None:
            if image.dangling:
                prunable_dangling.append(image)
            else:
                prunable_tagged.append(image)
            actions.append(Action("image", image.full_id))
        else:
            held_images.append(f"keep_image {image.full_id} reason={reason}")

    prunable_volumes: list[VolumeRec] = []
    held_volumes: list[str] = []
    named_volumes = 0
    coolify_volumes = 0
    for volume in volumes:
        if not _ANON_VOLUME_RE.fullmatch(volume.name):
            named_volumes += 1
        if has_coolify(volume.labels):
            coolify_volumes += 1
        reason = _volume_hold_reason(volume)
        if reason is None:
            prunable_volumes.append(volume)
            actions.append(Action("volume", volume.name))
        else:
            held_volumes.append(f"skip_volume {volume.name} reason={reason}")

    prunable_cache = [
        item
        for item in cache
        if item.last_used is not None and item.last_used < now - until
    ]
    actions.append(Action("build-cache", build_cache_until))
    actions.sort(key=lambda action: (_ACTION_ORDER[action.kind], action.value))

    rollback_lines = [
        f"rollback_image {image_id}"
        for image_id in sorted(previous_ids)
    ]
    report = _render_report(
        mode=mode,
        now=now,
        summary=summary,
        image_min_age_days=image_min_age_days,
        container_min_age_days=container_min_age_days,
        coolify_recent_days=coolify_recent_days,
        build_cache_until=build_cache_until,
        prunable_cache=prunable_cache,
        prunable_dangling=prunable_dangling,
        prunable_tagged=prunable_tagged,
        prunable_containers=prunable_containers,
        prunable_volumes=prunable_volumes,
        held_images=held_images,
        held_containers=held_containers,
        held_volumes=held_volumes,
        rollback_lines=rollback_lines,
        named_volumes=named_volumes,
        coolify_volumes=coolify_volumes,
        live_apps=len(live_apps),
        actions=actions,
    )
    return Plan(report=report, actions=actions)


_ACTION_ORDER = {"container": 0, "image": 1, "volume": 2, "build-cache": 3}


def _container_hold_reason(
    container: ContainerRec,
    *,
    now: datetime,
    min_age_days: int,
    live_apps: set[str],
) -> str | None:
    if container.status not in _STOPPED_STATUSES:
        return "not_stopped"
    if _df_status_is_live(container.df_status):
        return "df_status_live"
    if is_control_plane_container(container.name):
        return "control_plane"
    key = app_key(container.labels)
    if has_coolify(container.labels) and key in live_apps:
        return "coolify_live_or_recent"
    if container.status == "created":
        anchor = container.created
    else:
        anchor = container.finished_at or container.created
    if not _older_than(anchor, now, min_age_days):
        return "not_older_than_n_days"
    return None


def _image_hold_reason(
    image: ImageRec,
    *,
    now: datetime,
    min_age_days: int,
    referenced: set[str],
    rollback_keep: set[str],
    previous_ids: set[str],
) -> str | None:
    if is_control_plane_image(image.repos):
        return "control_plane"
    if image.full_id in referenced:
        return "referenced_by_container"
    if image.df_containers is not None and image.df_containers > 0:
        return "df_container_count"
    if image.full_id in previous_ids:
        return "coolify_previous"
    if image.full_id in rollback_keep:
        return "coolify_rollback_keep"
    if image.created is None:
        return "unknown_age"
    if not _older_than(image.created, now, min_age_days):
        return "not_older_than_n_days"
    return None


def _volume_hold_reason(volume: VolumeRec) -> str | None:
    if not volume.in_df:
        return "not_in_df"
    if not _ANON_VOLUME_RE.fullmatch(volume.name):
        return "named"
    if has_coolify(volume.labels):
        return "coolify_label"
    if volume.links != 0:
        return "not_dangling"
    return None


def _render_report(
    *,
    mode: str,
    now: datetime,
    summary: str,
    image_min_age_days: int,
    container_min_age_days: int,
    coolify_recent_days: int,
    build_cache_until: str,
    prunable_cache: list[CacheRec],
    prunable_dangling: list[ImageRec],
    prunable_tagged: list[ImageRec],
    prunable_containers: list[ContainerRec],
    prunable_volumes: list[VolumeRec],
    held_images: list[str],
    held_containers: list[str],
    held_volumes: list[str],
    rollback_lines: list[str],
    named_volumes: int,
    coolify_volumes: int,
    live_apps: int,
    actions: list[Action],
) -> str:
    def total(items, attr: str) -> int:
        return sum(getattr(item, attr) for item in items)

    lines = [
        f"docker-reclaim: mode={mode}",
        f"now: {now.strftime('%Y-%m-%dT%H:%M:%SZ')}",
        f"image_min_age_days: {image_min_age_days}",
        f"container_min_age_days: {container_min_age_days}",
        f"coolify_recent_days: {coolify_recent_days}",
        f"build_cache_until: {build_cache_until}",
        "source: docker system df -v",
        "before:",
        summary.rstrip(),
        "",
        "reclaimable:",
        _count_line(
            "build_cache_older_than",
            len(prunable_cache),
            total(prunable_cache, "size"),
        ),
        _count_line(
            "dangling_images",
            len(prunable_dangling),
            total(prunable_dangling, "unique_size"),
        ),
        _count_line(
            "unused_images_older_than",
            len(prunable_tagged),
            total(prunable_tagged, "unique_size"),
        ),
        _count_line(
            "stopped_containers_older_than",
            len(prunable_containers),
            total(prunable_containers, "size"),
        ),
        _count_line(
            "dangling_anonymous_volumes",
            len(prunable_volumes),
            total(prunable_volumes, "size"),
        ),
        "",
        "held:",
        f"named_volumes count={named_volumes}",
        f"coolify_labeled_volumes count={coolify_volumes}",
        f"coolify_live_or_recent_apps count={live_apps}",
        *rollback_lines,
        *sorted(held_images),
        *sorted(held_containers),
        *sorted(held_volumes),
        "",
        "actions:",
    ]
    for action in actions:
        lines.append(f"{action.kind} {action.value}")
    lines.append(
        "note: build cache bytes are estimated from df -v relative times; "
        "APPLY runs docker builder prune with the until filter"
    )
    lines.append(
        "note: an image still referenced by any container is kept this run, "
        "including a container selected for removal"
    )
    return "\n".join(lines) + "\n"


def write_actions(path: Path, actions: list[Action]) -> None:
    allowed = {
        "container": _HEX_ID_RE,
        "image": _HEX_ID_RE,
        "volume": _ANON_VOLUME_RE,
        "build-cache": _UNTIL_RE,
    }
    lines: list[str] = []
    for action in actions:
        pattern = allowed.get(action.kind)
        if pattern is None or pattern.fullmatch(action.value) is None:
            raise SnapshotError("refused action")
        if "\t" in action.value or "\n" in action.value:
            raise SnapshotError("refused action")
        lines.append(f"{action.kind}\t{action.value}")
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def _parse_now(text: str) -> datetime:
    parsed = parse_time(text)
    if parsed is None:
        raise SnapshotError("now was empty")
    return parsed


def plan_from_dir(
    input_dir: Path,
    *,
    now: datetime,
    image_min_age_days: int,
    container_min_age_days: int,
    coolify_recent_days: int,
    build_cache_until: str,
    mode: str,
) -> Plan:
    summary, images, containers, volumes, cache = load_snapshot(input_dir, now)
    return build_plan(
        summary=summary,
        images=images,
        containers=containers,
        volumes=volumes,
        cache=cache,
        now=now,
        image_min_age_days=image_min_age_days,
        container_min_age_days=container_min_age_days,
        coolify_recent_days=coolify_recent_days,
        build_cache_until=build_cache_until,
        mode=mode,
    )


def render_table(headers: list[str], rows: list[list[str]]) -> str:
    widths = [len(header) for header in headers]
    for row in rows:
        if len(row) != len(headers):
            raise SnapshotError("table row width")
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))

    def format_row(cells: list[str]) -> str:
        parts: list[str] = []
        for index, cell in enumerate(cells):
            if index == len(cells) - 1:
                parts.append(cell)
            else:
                parts.append(cell.ljust(widths[index] + 3))
        return "".join(parts).rstrip()

    return "\n".join([format_row(headers), *[format_row(row) for row in rows]])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Plan a safe Docker reclaim.")
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan")
    plan.add_argument("--input-dir", required=True, type=Path)
    plan.add_argument("--now", required=True)
    plan.add_argument("--image-min-age-days", required=True, type=int)
    plan.add_argument("--container-min-age-days", required=True, type=int)
    plan.add_argument("--coolify-recent-days", required=True, type=int)
    plan.add_argument("--build-cache-until", required=True)
    plan.add_argument("--commands", required=True, type=Path)
    plan.add_argument("--mode", choices=("dry-run", "apply"), default="dry-run")
    args = parser.parse_args(argv)
    if args.command != "plan":
        print("docker-reclaim: unknown command", file=sys.stderr)
        return 2
    try:
        result = plan_from_dir(
            args.input_dir,
            now=_parse_now(args.now),
            image_min_age_days=args.image_min_age_days,
            container_min_age_days=args.container_min_age_days,
            coolify_recent_days=args.coolify_recent_days,
            build_cache_until=args.build_cache_until,
            mode=args.mode,
        )
        write_actions(args.commands, result.actions)
    except SnapshotError as exc:
        print(f"docker-reclaim: {exc}", file=sys.stderr)
        return 1
    sys.stdout.write(result.report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
