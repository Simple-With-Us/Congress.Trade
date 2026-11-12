#!/usr/bin/env python3
"""Read-only sizes for every Docker volume and bind mount on the Coolify host.

The reporter never runs Docker and never deletes anything. The shell wrapper
collects `docker system df -v`, volume labels, and container mounts, sizes
bind mounts with `du`, and then this module writes JSON and markdown.

An orphan is a volume that no inspected container mounts. When `docker system
df -v` prints a numeric LINKS count, it has to match that mount count or the
report stops without suggesting a removal. For each orphan the stdout is one
`docker volume rm` command and nothing else.
"""

from __future__ import annotations

import argparse
import json
import re
import shlex
import sys
from dataclasses import dataclass, field
from pathlib import Path


class SnapshotError(Exception):
    """The collected Docker output is not safe to report."""


# Same byte grammar as scripts/ops/docker_reclaim.py. Both reports read
# `docker system df -v`, and a size such as 12.4kB has to mean the same thing.
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
_NOW_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
_HOST_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})?$")
_HEX_ID_RE = re.compile(r"^[0-9a-f]{64}$")
_STATUS_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
_VOLUME_HEADERS = ("VOLUME NAME", "LINKS", "SIZE")
_SKIP_MOUNT_TYPES = frozenset({"tmpfs", "npipe", "image"})
_GAP = "\u00a0 "

# Names only. Token, secret, and password labels are never read into the report.
_RESOURCE_LABELS = ("coolify.resourceName", "coolify.applicationName")
_SERVICE_LABELS = ("coolify.serviceName", "com.docker.compose.service")
_PROJECT_LABELS = ("coolify.projectName", "com.docker.compose.project")
_NAME_LABELS = ("coolify.name",)
_TYPE_LABELS = ("coolify.type", "coolify.resourceType")


@dataclass
class VolumeRec:
    name: str
    driver: str
    mountpoint: str
    labels: dict[str, str]
    links: int | None
    size: int


@dataclass
class MountRec:
    mount_type: str
    volume_name: str
    source: str
    destination: str


@dataclass
class ContainerRec:
    full_id: str
    name: str
    status: str
    labels: dict[str, str]
    mounts: list[MountRec] = field(default_factory=list)


@dataclass(frozen=True)
class Owner:
    app: str
    service: str
    project: str
    coolify_type: str
    map_source: str


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


def human_bytes(nbytes: int | None) -> str:
    if nbytes is None:
        return "unknown"
    return human_size(nbytes)


def labels_from(value: object) -> dict[str, str]:
    if value is None:
        return {}
    if isinstance(value, dict):
        labels: dict[str, str] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise SnapshotError("label key was not a string")
            labels[key] = "" if item is None else str(item)
        return labels
    if not isinstance(value, str):
        raise SnapshotError("labels were not a string or object")
    text = value.strip()
    if text in {"", "N/A", "map[]"}:
        return {}
    if text.startswith("map[") and text.endswith("]"):
        labels = {}
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


def _first_label(labels: dict[str, str], keys: tuple[str, ...]) -> str:
    for key in keys:
        text = clean_text(labels.get(key, ""))
        if text:
            return text
    return ""


def clean_text(value: str, *, limit: int = 200) -> str:
    if any(ord(char) < 32 or char == "\x7f" for char in value):
        raise SnapshotError("text was not printable")
    text = " ".join(value.split())
    if len(text) > limit:
        raise SnapshotError("text was too long")
    return text


def clean_identifier(value: str) -> str:
    if not value or any(ord(char) < 32 or char == "\x7f" for char in value):
        raise SnapshotError("name was not printable")
    if len(value) > 255:
        raise SnapshotError("name was too long")
    return value


def normalize_bind_source(path: str) -> str:
    if not isinstance(path, str) or not path.startswith("/"):
        raise SnapshotError("bind source is not absolute")
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    if path == "/":
        raise SnapshotError("refusing to size /")
    parts = path.split("/")
    if any(part in {"", ".", ".."} for part in parts[1:]):
        raise SnapshotError("bind source is not a normal path")
    if len(path) > 4096:
        raise SnapshotError("bind source was too long")
    return path


def parse_links(value: str) -> int | None:
    text = value.strip()
    if not text:
        raise SnapshotError("volume links were empty")
    if text.upper() == "N/A":
        return None
    if not re.fullmatch(r"\d+", text):
        raise SnapshotError("volume links were not a number")
    return int(text)


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
            columns[name] = line[start : min(end, len(line))].strip()
    return columns


def parse_volume_table(text: str) -> list[dict[str, str]]:
    """Read only the Local Volumes section of `docker system df -v`."""
    lines = [line.rstrip("\r") for line in text.splitlines()]
    index = 0
    while index < len(lines):
        if lines[index].strip().startswith("Local Volumes space usage"):
            break
        index += 1
    else:
        raise SnapshotError("docker system df -v had no volumes section")
    index += 1
    while index < len(lines) and not lines[index].strip():
        index += 1
    if index >= len(lines):
        raise SnapshotError("unparsed volumes table")
    positions = _column_starts(lines[index], _VOLUME_HEADERS)
    if positions is None:
        raise SnapshotError("unparsed volumes table")
    index += 1
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    while index < len(lines) and lines[index].strip():
        title = lines[index].strip()
        if title.endswith("space usage:") or title.startswith("Build cache usage"):
            break
        row = _slice_row(lines[index], positions)
        name = row.get("VOLUME NAME", "").strip()
        if not name:
            raise SnapshotError("volume name was empty")
        if name in seen:
            raise SnapshotError("duplicate volume in docker system df -v")
        seen.add(name)
        rows.append(row)
        index += 1
    return rows


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
    return path.read_text(encoding="utf-8")


def _container_name(value: object) -> str:
    name = clean_identifier(str(value or "").strip())
    if name.startswith("/"):
        name = name[1:]
    if not name or name.startswith("/"):
        raise SnapshotError("container name was empty")
    return clean_identifier(name)


def _mount_from(row: object) -> MountRec | None:
    if not isinstance(row, dict):
        raise SnapshotError("mount was not an object")
    mount_type = str(row.get("Type") or "").strip().lower()
    if mount_type in _SKIP_MOUNT_TYPES:
        return None
    if mount_type == "volume":
        name = clean_identifier(str(row.get("Name") or "").strip())
        destination = clean_text(str(row.get("Destination") or ""), limit=4096)
        return MountRec("volume", name, "", destination)
    if mount_type == "bind":
        source = normalize_bind_source(str(row.get("Source") or ""))
        destination = clean_text(str(row.get("Destination") or ""), limit=4096)
        return MountRec("bind", "", source, destination)
    raise SnapshotError("unparsed mount type")


def load_volumes(input_dir: Path) -> list[VolumeRec]:
    table = {
        row["VOLUME NAME"].strip(): row
        for row in parse_volume_table(_require_text(input_dir / "df-verbose.txt"))
    }
    listed: list[VolumeRec] = []
    seen: set[str] = set()
    for row in _load_jsonl(input_dir / "volumes.jsonl"):
        name = clean_identifier(str(row.get("Name") or "").strip())
        if name in seen:
            raise SnapshotError("duplicate volume in volume ls")
        seen.add(name)
        df_row = table.get(name)
        if df_row is None:
            raise SnapshotError("docker system df -v omitted a volume")
        driver = clean_text(str(row.get("Driver") or "local"), limit=64) or "local"
        raw_mount = str(row.get("Mountpoint") or "").strip()
        mountpoint = ""
        if raw_mount and raw_mount.upper() != "N/A":
            mountpoint = normalize_bind_source(raw_mount)
        listed.append(
            VolumeRec(
                name=name,
                driver=driver,
                mountpoint=mountpoint,
                labels=labels_from(row.get("Labels")),
                links=parse_links(str(df_row.get("LINKS", ""))),
                size=parse_size(df_row.get("SIZE", "") or ""),
            )
        )
    if set(table) != seen:
        raise SnapshotError("docker system df -v listed a volume ls did not")
    return listed


def load_containers(input_dir: Path) -> list[ContainerRec]:
    id_path = input_dir / "container-ids.txt"
    if not id_path.is_file():
        raise SnapshotError("missing container-ids.txt")
    raw_ids = [line.strip() for line in id_path.read_text(encoding="utf-8").splitlines()]
    raw_ids = [item for item in raw_ids if item]
    if any(not _HEX_ID_RE.fullmatch(item) for item in raw_ids):
        raise SnapshotError("container id was not 64 hex characters")
    if len(raw_ids) != len(set(raw_ids)):
        raise SnapshotError("duplicate container id")
    records = _load_jsonl(input_dir / "containers.jsonl")
    containers: list[ContainerRec] = []
    seen: set[str] = set()
    for row in records:
        full = str(row.get("Id") or "").strip()
        if not _HEX_ID_RE.fullmatch(full):
            raise SnapshotError("container id was not 64 hex characters")
        if full in seen:
            raise SnapshotError("duplicate container id")
        seen.add(full)
        status = str(row.get("Status") or "").strip().lower()
        if not _STATUS_RE.fullmatch(status):
            raise SnapshotError("container status was empty")
        mounts_raw = row.get("Mounts")
        if mounts_raw is None:
            mounts_raw = []
        if not isinstance(mounts_raw, list):
            raise SnapshotError("mounts were not a list")
        mounts = [mount for item in mounts_raw if (mount := _mount_from(item)) is not None]
        containers.append(
            ContainerRec(
                full_id=full,
                name=_container_name(row.get("Name")),
                status=status,
                labels=labels_from(row.get("Labels")),
                mounts=mounts,
            )
        )
    if seen != set(raw_ids):
        raise SnapshotError("container inspect did not match ps")
    return containers


def owner_from_labels(labels: dict[str, str]) -> Owner | None:
    app = _first_label(labels, _RESOURCE_LABELS)
    service = _first_label(labels, _SERVICE_LABELS)
    project = _first_label(labels, _PROJECT_LABELS)
    if not app:
        app = service or _first_label(labels, _NAME_LABELS)
    if not app and project and service:
        app = f"{project}/{service}"
    if not app:
        app = project
    coolify_type = _first_label(labels, _TYPE_LABELS)
    if not app:
        return None
    return Owner(app, service, project, coolify_type, "label")


def owner_from_container(name: str) -> Owner:
    if not name:
        return Owner("unmapped", "", "", "", "unmapped")
    return Owner(name, "", "", "", "container-name")


def summarize_owners(owners: list[Owner]) -> dict[str, object]:
    if not owners:
        owners = [Owner("unmapped", "", "", "", "unmapped")]
    apps = sorted({owner.app for owner in owners if owner.app})
    services = sorted({owner.service for owner in owners if owner.service})
    projects = sorted({owner.project for owner in owners if owner.project})
    types = sorted({owner.coolify_type for owner in owners if owner.coolify_type})
    sources = {owner.map_source for owner in owners}
    if sources == {"label"}:
        map_source = "label"
    elif sources == {"container-name"}:
        map_source = "container-name"
    elif sources == {"unmapped"}:
        map_source = "unmapped"
    else:
        map_source = "mixed"
    return {
        "app": ", ".join(apps) if apps else "unmapped",
        "apps": apps or ["unmapped"],
        "service": ", ".join(services),
        "project": ", ".join(projects),
        "coolify_type": ", ".join(types),
        "map_source": map_source,
    }


def suggested_rm(name: str) -> str:
    # Quote the name and pass it after -- so the printed line cannot gain flags.
    return "docker volume rm -- " + shlex.quote(name)


def _container_brief(container: ContainerRec) -> dict[str, str]:
    return {"name": container.name, "status": container.status}


def _owners_for_volume(volume: VolumeRec, holders: list[ContainerRec]) -> list[Owner]:
    owners: list[Owner] = []
    for container in holders:
        mapped = owner_from_labels(container.labels)
        owners.append(mapped if mapped is not None else owner_from_container(container.name))
    if owners:
        return owners
    mapped = owner_from_labels(volume.labels)
    if mapped is not None:
        return [mapped]
    return [Owner("unmapped", "", "", "", "unmapped")]


def _owners_for_bind(holders: list[ContainerRec]) -> list[Owner]:
    owners: list[Owner] = []
    for container in holders:
        mapped = owner_from_labels(container.labels)
        owners.append(mapped if mapped is not None else owner_from_container(container.name))
    return owners or [Owner("unmapped", "", "", "", "unmapped")]


def parse_bind_sizes(text: str) -> dict[str, tuple[int | None, str]]:
    sizes: dict[str, tuple[int | None, str]] = {}
    for line in text.splitlines():
        if not line:
            continue
        if line.startswith(("missing\t", "error\t", "refused\t")):
            kind, path = line.split("\t", 1)
            source = normalize_bind_source(path) if path != "/" else path
            if source in sizes:
                raise SnapshotError("duplicate bind size")
            sizes[source] = (None, kind)
            continue
        if "\t" in line:
            raw_size, path = line.split("\t", 1)
        else:
            parts = line.split(None, 1)
            if len(parts) != 2:
                raise SnapshotError("unparsed bind size")
            raw_size, path = parts
        if not re.fullmatch(r"\d+", raw_size.strip()):
            raise SnapshotError("unparsed bind size")
        source = normalize_bind_source(path)
        if source in sizes:
            raise SnapshotError("duplicate bind size")
        sizes[source] = (int(raw_size.strip()), "")
    return sizes


def load_bind_sizes(input_dir: Path, expected: list[str]) -> dict[str, tuple[int | None, str]]:
    text = _require_text(input_dir / "bind-sizes.txt") if (input_dir / "bind-sizes.txt").is_file() else ""
    if not expected and not text.strip():
        return {}
    sizes = parse_bind_sizes(text)
    if set(sizes) != set(expected):
        raise SnapshotError("bind sizes did not match container mounts")
    for source, (_nbytes, error) in sizes.items():
        if error == "refused" or source == "/":
            raise SnapshotError("refusing to size a bind mount")
    return sizes


def bind_source_list(containers: list[ContainerRec]) -> list[str]:
    found: set[str] = set()
    for container in containers:
        for mount in container.mounts:
            if mount.mount_type == "bind":
                found.add(mount.source)
    return sorted(found)


def _check_links(name: str, links: int | None, holders: int) -> None:
    if links is not None and links != holders:
        raise SnapshotError(f"volume links disagreed with container mounts for {name}")


def build_report(
    *,
    volumes: list[VolumeRec],
    containers: list[ContainerRec],
    bind_sizes: dict[str, tuple[int | None, str]],
    now: str,
    host: str,
    top: int,
    previous: dict[tuple[str, str], int | None] | None,
    previous_generated_at: str | None,
) -> dict[str, object]:
    if not _NOW_RE.fullmatch(now):
        raise SnapshotError("timestamp was not UTC RFC3339")
    if not _HOST_RE.fullmatch(host):
        raise SnapshotError("host was not a hostname")
    if top < 1:
        raise SnapshotError("top must be a positive integer")

    holders_by_volume: dict[str, list[ContainerRec]] = {volume.name: [] for volume in volumes}
    bind_holders: dict[str, list[ContainerRec]] = {}
    bind_destinations: dict[str, set[str]] = {}
    known = set(holders_by_volume)
    for container in containers:
        seen_volumes: set[str] = set()
        for mount in container.mounts:
            if mount.mount_type == "volume":
                if mount.volume_name not in known:
                    raise SnapshotError("container mounted a volume ls did not")
                if mount.volume_name in seen_volumes:
                    continue
                seen_volumes.add(mount.volume_name)
                holders_by_volume[mount.volume_name].append(container)
            elif mount.mount_type == "bind":
                bind_holders.setdefault(mount.source, [])
                if all(item.full_id != container.full_id for item in bind_holders[mount.source]):
                    bind_holders[mount.source].append(container)
                bind_destinations.setdefault(mount.source, set()).add(mount.destination)

    volume_rows: list[dict[str, object]] = []
    orphans: list[dict[str, object]] = []
    for volume in sorted(volumes, key=lambda item: (-item.size, item.name)):
        holders = sorted(holders_by_volume[volume.name], key=lambda item: item.name)
        _check_links(volume.name, volume.links, len(holders))
        summary = summarize_owners(_owners_for_volume(volume, holders))
        orphan = len(holders) == 0
        command = suggested_rm(volume.name) if orphan else ""
        row: dict[str, object] = {
            "name": volume.name,
            "bytes": volume.size,
            "driver": volume.driver,
            "mountpoint": volume.mountpoint,
            "links": volume.links,
            "orphan": orphan,
            "app": summary["app"],
            "apps": summary["apps"],
            "service": summary["service"],
            "project": summary["project"],
            "coolify_type": summary["coolify_type"],
            "map_source": summary["map_source"],
            "containers": [_container_brief(item) for item in holders],
        }
        if command:
            row["suggested_rm"] = command
        volume_rows.append(row)
        if command:
            orphans.append(
                {
                    "name": volume.name,
                    "bytes": volume.size,
                    "app": summary["app"],
                    "suggested_rm": command,
                }
            )

    bind_rows: list[dict[str, object]] = []
    for source in sorted(bind_holders):
        nbytes, error = bind_sizes.get(source, (None, "missing"))
        holders = sorted(bind_holders[source], key=lambda item: item.name)
        summary = summarize_owners(_owners_for_bind(holders))
        bind_rows.append(
            {
                "source": source,
                "bytes": nbytes,
                "size_error": error,
                "app": summary["app"],
                "apps": summary["apps"],
                "service": summary["service"],
                "project": summary["project"],
                "coolify_type": summary["coolify_type"],
                "map_source": summary["map_source"],
                "containers": [_container_brief(item) for item in holders],
                "destinations": sorted(bind_destinations.get(source, set())),
            }
        )
    bind_rows.sort(key=lambda item: (-(item["bytes"] if isinstance(item["bytes"], int) else -1), str(item["source"])))

    current_sizes: dict[tuple[str, str], int | None] = {
        ("volume", str(row["name"])): row["bytes"] if isinstance(row["bytes"], int) else None
        for row in volume_rows
    }
    for row in bind_rows:
        current_sizes[("bind", str(row["source"]))] = row["bytes"] if isinstance(row["bytes"], int) else None

    return {
        "version": 1,
        "generated_at": now,
        "host": host,
        "read_only": True,
        "previous_present": previous is not None,
        "previous_generated_at": previous_generated_at,
        "totals": {
            "volumes": len(volume_rows),
            "bind_mounts": len(bind_rows),
            "orphans": len(orphans),
            "volume_bytes": sum(volume.size for volume in volumes),
            "bind_bytes": sum(nbytes for nbytes, _error in bind_sizes.values() if isinstance(nbytes, int)),
        },
        "volumes": volume_rows,
        "bind_mounts": bind_rows,
        "orphans": sorted(orphans, key=lambda item: str(item["name"])),
        "top_growers": top_growers(current_sizes, previous, top),
    }


def top_growers(
    current: dict[tuple[str, str], int | None],
    previous: dict[tuple[str, str], int | None] | None,
    top: int,
) -> list[dict[str, object]]:
    if previous is None:
        return []
    rows: list[dict[str, object]] = []
    for key, nbytes in current.items():
        if not isinstance(nbytes, int):
            continue
        if key in previous:
            old = previous[key]
            if not isinstance(old, int):
                continue
        else:
            old = 0
        delta = nbytes - old
        if delta <= 0:
            continue
        kind, name = key
        rows.append(
            {
                "kind": kind,
                "name": name,
                "bytes": nbytes,
                "previous_bytes": old,
                "delta_bytes": delta,
            }
        )
    rows.sort(key=lambda item: (-int(item["delta_bytes"]), str(item["kind"]), str(item["name"])))
    return rows[:top]


def load_previous(path: Path | None) -> tuple[dict[tuple[str, str], int | None] | None, str | None]:
    if path is None:
        return None, None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SnapshotError("previous JSON could not be read") from exc
    if not isinstance(data, dict) or data.get("version") != 1:
        raise SnapshotError("previous JSON version is not 1")
    sizes: dict[tuple[str, str], int | None] = {}
    volumes = data.get("volumes")
    binds = data.get("bind_mounts")
    if not isinstance(volumes, list) or not isinstance(binds, list):
        raise SnapshotError("previous JSON is missing volume lists")
    for item in volumes:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise SnapshotError("previous JSON volume was unparsed")
        sizes[("volume", item["name"])] = _previous_bytes(item.get("bytes"))
    for item in binds:
        if not isinstance(item, dict) or not isinstance(item.get("source"), str):
            raise SnapshotError("previous JSON bind mount was unparsed")
        sizes[("bind", item["source"])] = _previous_bytes(item.get("bytes"))
    generated = data.get("generated_at")
    if generated is not None and not isinstance(generated, str):
        raise SnapshotError("previous JSON timestamp was unparsed")
    return sizes, generated if isinstance(generated, str) else None


def _previous_bytes(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise SnapshotError("previous JSON size was unparsed")
    return value


def md_cell(value: object) -> str:
    return str(value).replace("|", "\\|").replace("`", "'")


def _container_cell(containers: object) -> str:
    if not isinstance(containers, list) or not containers:
        return ""
    parts: list[str] = []
    for item in containers:
        if isinstance(item, dict):
            parts.append(f"{item.get('name', '')} ({item.get('status', '')})")
    return ", ".join(parts)


def render_markdown(report: dict[str, object]) -> str:
    totals = report["totals"]
    if not isinstance(totals, dict):
        raise SnapshotError("totals were missing")
    lines = [
        "# Docker Volume Report",
        "",
        (
            f"Generated {report['generated_at']} on {report['host']}.{_GAP}"
            f"Read-only.{_GAP}"
            "This report deletes nothing."
        ),
        "",
        (
            f"Volumes {totals['volumes']}, bind mounts {totals['bind_mounts']}, "
            f"orphans {totals['orphans']}."
        ),
        "",
        "## Volumes",
        "",
        "| Name | Bytes | App | Map | Containers | Orphan |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    volumes = report["volumes"]
    if not isinstance(volumes, list):
        raise SnapshotError("volumes were missing")
    if not volumes:
        lines.append("| none |  |  |  |  |  |")
    for row in volumes:
        if not isinstance(row, dict):
            raise SnapshotError("volume row was unparsed")
        lines.append(
            "| "
            + " | ".join(
                [
                    md_cell(row["name"]),
                    md_cell(human_bytes(row["bytes"] if isinstance(row["bytes"], int) else None)),
                    md_cell(row["app"]),
                    md_cell(row["map_source"]),
                    md_cell(_container_cell(row["containers"])),
                    "yes" if row["orphan"] else "no",
                ]
            )
            + " |"
        )
    lines.extend(["", "## Bind Mounts", ""])
    lines.append("| Source | Bytes | App | Map | Containers |")
    lines.append("| --- | --- | --- | --- | --- |")
    binds = report["bind_mounts"]
    if not isinstance(binds, list):
        raise SnapshotError("bind mounts were missing")
    if not binds:
        lines.append("| none |  |  |  |  |")
    for row in binds:
        if not isinstance(row, dict):
            raise SnapshotError("bind row was unparsed")
        lines.append(
            "| "
            + " | ".join(
                [
                    md_cell(row["source"]),
                    md_cell(human_bytes(row["bytes"] if isinstance(row["bytes"], int) else None)),
                    md_cell(row["app"]),
                    md_cell(row["map_source"]),
                    md_cell(_container_cell(row["containers"])),
                ]
            )
            + " |"
        )
    lines.extend(["", "## Top Growers", ""])
    growers = report["top_growers"]
    if not isinstance(growers, list):
        raise SnapshotError("top growers were missing")
    if not report["previous_present"]:
        lines.append("No previous JSON was saved, so this run has no growth comparison.")
    elif not growers:
        lines.append("No volume or bind mount grew since the previous JSON.")
    else:
        lines.append("| Kind | Name | Previous | Current | Delta |")
        lines.append("| --- | --- | --- | --- | --- |")
        for row in growers:
            if not isinstance(row, dict):
                raise SnapshotError("grower row was unparsed")
            lines.append(
                "| "
                + " | ".join(
                    [
                        md_cell(row["kind"]),
                        md_cell(row["name"]),
                        md_cell(human_bytes(row["previous_bytes"] if isinstance(row["previous_bytes"], int) else None)),
                        md_cell(human_bytes(row["bytes"] if isinstance(row["bytes"], int) else None)),
                        md_cell(human_bytes(row["delta_bytes"] if isinstance(row["delta_bytes"], int) else None)),
                    ]
                )
                + " |"
            )
    lines.extend(["", "## Orphans", ""])
    commands = orphan_commands(report)
    if commands:
        lines.extend(commands)
    else:
        lines.append("none")
    lines.append("")
    return "\n".join(lines)


def orphan_commands(report: dict[str, object]) -> list[str]:
    orphans = report["orphans"]
    if not isinstance(orphans, list):
        raise SnapshotError("orphans were missing")
    commands: list[str] = []
    for item in orphans:
        if not isinstance(item, dict):
            raise SnapshotError("orphan row was unparsed")
        command = item.get("suggested_rm")
        if not isinstance(command, str) or not command.startswith("docker volume rm -- "):
            raise SnapshotError("orphan command was missing")
        commands.append(command)
    return commands


def report_from_dir(
    input_dir: Path,
    *,
    now: str,
    host: str,
    top: int,
    previous_path: Path | None,
) -> dict[str, object]:
    volumes = load_volumes(input_dir)
    containers = load_containers(input_dir)
    expected = bind_source_list(containers)
    bind_sizes = load_bind_sizes(input_dir, expected)
    previous, previous_generated_at = load_previous(previous_path)
    return build_report(
        volumes=volumes,
        containers=containers,
        bind_sizes=bind_sizes,
        now=now,
        host=host,
        top=top,
        previous=previous,
        previous_generated_at=previous_generated_at,
    )


def atomic_write(path: Path, text: str) -> None:
    if not path.is_absolute():
        raise SnapshotError("output path must be absolute")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def _emit_bind_sources(input_dir: Path) -> int:
    sources = bind_source_list(load_containers(input_dir))
    if sources:
        sys.stdout.write("\n".join(sources) + "\n")
    return 0


def _emit_report(args: argparse.Namespace) -> int:
    if args.top < 1:
        raise SnapshotError("top must be a positive integer")
    report = report_from_dir(
        args.input_dir,
        now=args.now,
        host=args.host,
        top=args.top,
        previous_path=args.previous,
    )
    body = json.dumps(report, indent=2, sort_keys=True) + "\n"
    markdown = render_markdown(report)
    # Read the previous file before either replace, which report_from_dir already did.
    atomic_write(args.json_path, body)
    atomic_write(args.markdown, markdown)
    commands = orphan_commands(report)
    if commands:
        sys.stdout.write("\n".join(commands) + "\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Report Docker volume and bind-mount sizes. Never deletes.")
    sub = parser.add_subparsers(dest="command", required=True)
    binds = sub.add_parser("bind-sources")
    binds.add_argument("--input-dir", required=True, type=Path)
    report = sub.add_parser("report")
    report.add_argument("--input-dir", required=True, type=Path)
    report.add_argument("--json", required=True, type=Path, dest="json_path")
    report.add_argument("--markdown", required=True, type=Path)
    report.add_argument("--previous", type=Path)
    report.add_argument("--now", required=True)
    report.add_argument("--host", required=True)
    report.add_argument("--top", required=True, type=int)
    args = parser.parse_args(argv)
    try:
        if args.command == "bind-sources":
            return _emit_bind_sources(args.input_dir)
        if args.command == "report":
            return _emit_report(args)
    except SnapshotError as exc:
        print(f"docker-volume-report: {exc}", file=sys.stderr)
        return 1
    print("docker-volume-report: unknown command", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
