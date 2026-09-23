import hashlib
import json
import os
import time

from pathlib import Path
from collections import defaultdict
from datetime import datetime

ROOTS = [
    root.strip()
    for root in os.environ.get(
        "SCAN_ROOTS",
        "/media/Downloads,/media/Movies,/media/Series"
    ).split(",")
    if root.strip()
]

DATA_DIR = "data"

CACHE_FILE = os.path.join(DATA_DIR, "cache.json")
RESULTS_FILE = os.path.join(DATA_DIR, "results.json")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")

VIDEO_EXTENSIONS = {
    ".mkv", ".mp4", ".avi",
    ".mov", ".m4v", ".ts", ".wmv"
}

# Files smaller than this still count toward total/wasted space but are
# skipped from duplicate-hash detection - not worth the CPU, and they're
# rarely meaningful "movie" duplicates (samples, thumbnails, etc.)
MIN_SIZE_FOR_DEDUP = 10 * 1024 * 1024  # 10 MB

HISTORY_LIMIT = 30


def load_json(path, default):
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return default
    return default


def save_json(path, data):
    # Write to a temp file then atomically replace, so a reader (the
    # Flask app) never sees a half-written results.json.
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, path)


def update_status(status, **values):
    if status is not None:
        status.update(values)


def sample_hash_file(path):
    """
    Hash:
      first 4 MB
      middle 4 MB
      last 4 MB

    Extremely fast compared to full SHA256.
    """

    SAMPLE_SIZE = 4 * 1024 * 1024

    h = hashlib.sha256()

    size = os.path.getsize(path)

    with open(path, "rb") as f:

        if size <= SAMPLE_SIZE * 3:
            h.update(f.read())
            return h.hexdigest()

        # start
        h.update(f.read(SAMPLE_SIZE))

        # middle
        middle = (size // 2) - (SAMPLE_SIZE // 2)
        f.seek(middle)
        h.update(f.read(SAMPLE_SIZE))

        # end
        f.seek(size - SAMPLE_SIZE)
        h.update(f.read(SAMPLE_SIZE))

    return h.hexdigest()


def cached_hash(path, stat_info, cache):

    key = str(path)

    entry = cache.get(key)

    if entry:

        if (
            entry.get("size") == stat_info.st_size
            and entry.get("mtime") == stat_info.st_mtime
            and entry.get("sample_hash")
        ):
            return entry["sample_hash"]

    digest = sample_hash_file(path)

    cache[key] = {
        "size": stat_info.st_size,
        "mtime": stat_info.st_mtime,
        "sample_hash": digest
    }

    return digest


def build_results(files, total_size, wasted_size, duplicate_count,
                   hardlink_count, history, duration, partial=False):
    return {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "total_space": total_size,
        "wasted_space": wasted_size,
        "duplicate_count": duplicate_count,
        "hardlink_count": hardlink_count,
        "scan_duration_seconds": round(duration, 1),
        "partial": partial,
        "files": files,
        "history": history
    }


def scan(status=None):

    os.makedirs(DATA_DIR, exist_ok=True)

    # Be a good neighbour to Sonarr/Radarr/Prowlarr/Plex etc. running
    # alongside this on the same NAS - deprioritize under contention.
    try:
        os.nice(15)
    except (AttributeError, OSError):
        pass

    start_ts = time.time()

    cache = load_json(CACHE_FILE, {})
    history = load_json(HISTORY_FILE, [])

    files = []

    inode_groups = defaultdict(list)
    size_groups = defaultdict(list)

    total_size = 0
    wasted_size = 0
    duplicate_groups = []

    # --------------------------------------------------
    # Phase 1: Collect files (os.scandir - lower overhead than
    # Path.rglob for large trees)
    # --------------------------------------------------

    update_status(
        status,
        running=True,
        phase="Collecting files",
        current=0,
        total=0
    )

    all_files = []
    seen_paths = set()

    for root in ROOTS:

        if not os.path.isdir(root):
            continue

        stack = [root]

        while stack:
            current_dir = stack.pop()

            try:
                with os.scandir(current_dir) as it:
                    for entry in it:
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                stack.append(entry.path)
                            elif entry.is_file(follow_symlinks=False):
                                ext = os.path.splitext(entry.name)[1].lower()
                                if ext in VIDEO_EXTENSIONS:
                                    path = Path(entry.path).resolve()
                                    if path not in seen_paths:
                                        seen_paths.add(path)
                                        all_files.append(path)
                        except OSError:
                            continue
            except OSError:
                continue

    update_status(
        status,
        phase="Collecting metadata",
        current=0,
        total=len(all_files)
    )

    # --------------------------------------------------
    # Phase 2: Metadata
    # --------------------------------------------------

    for index, path in enumerate(all_files, start=1):

        try:
            st = path.stat()
        except OSError:
            continue

        total_size += st.st_size

        record = {
            "path": str(path),
            "size": st.st_size,
            "inode": st.st_ino,
            "device": st.st_dev,
            "link_count": st.st_nlink,
            "findings": []  # Changed from "issues" to "findings"
        }

        files.append(record)

        if st.st_size >= MIN_SIZE_FOR_DEDUP:
            size_groups[st.st_size].append((path, st, record))

        inode_groups[(st.st_dev, st.st_ino)].append(record)

        if index % 200 == 0:
            update_status(status, current=index)

    update_status(status, current=len(all_files))

    # Publish what we know so far (totals, file list) so the page
    # already reflects reality if someone loads it mid-scan.
    save_json(
        RESULTS_FILE,
        build_results(files, total_size, 0, 0, 0, history,
                      time.time() - start_ts, partial=True)
    )

    # --------------------------------------------------
    # Phase 3+4: Hash equal-size files & flag duplicates as we go
    # --------------------------------------------------

    candidate_groups = [
        group for group in size_groups.values() if len(group) > 1
    ]

    update_status(
        status,
        phase="Sample hashing",
        current=0,
        total=len(candidate_groups)
    )

    for processed_groups, group in enumerate(candidate_groups, start=1):

        # Files already hardlinked to each other share content by
        # definition - hash one representative per inode, not every path.
        inode_map = defaultdict(list)
        for path, st, record in group:
            inode_map[(st.st_dev, st.st_ino)].append((path, st, record))

        local_hashes = defaultdict(list)

        for items in inode_map.values():
            rep_path, rep_st, _ = items[0]

            try:
                digest = cached_hash(rep_path, rep_st, cache)
            except OSError:
                continue

            for _, _, record in items:
                record["sample_hash"] = digest
                local_hashes[digest].append(record)

        for digest_records in local_hashes.values():
            inode_records = defaultdict(list)
            for record in digest_records:
                inode_records[(record["device"], record["inode"])].append(record)

            if len(inode_records) > 1:
                inode_record_groups = list(inode_records.values())
                canonical_group = next(
                    (records for records in inode_record_groups
                     if "/Downloads/" in records[0]["path"]),
                    inode_record_groups[0]
                )
                canonical_path = canonical_group[0]["path"]
                duplicate_groups.append(digest_records)

                for duplicate_group in inode_record_groups:
                    if duplicate_group is canonical_group:
                        continue
                    duplicate = duplicate_group[0]
                    wasted_size += duplicate["size"]
                    duplicate["findings"].append({
                        "type": "duplicate",
                        "severity": "error",
                        "message": "Duplicate content detected",
                        "matched_path": canonical_path
                    })

        if processed_groups % 10 == 0:
            update_status(status, current=processed_groups)
            save_json(CACHE_FILE, cache)
            save_json(
                RESULTS_FILE,
                build_results(files, total_size, wasted_size,
                              len(duplicate_groups), 0, history,
                              time.time() - start_ts, partial=True)
            )

    save_json(CACHE_FILE, cache)

    # --------------------------------------------------
    # Phase 5: Hardlinks
    # --------------------------------------------------

    update_status(status, phase="Checking hardlinks")

    hardlink_groups = []

    for group in inode_groups.values():

        if len(group) <= 1:
            continue

        hardlink_groups.append(group)

        linked_paths = [item["path"] for item in group]

        for item in group:
            item["linked_paths"] = linked_paths
            item["findings"].append({
                "type": "hardlink",
                "severity": "info",
                "message": "Hardlinked",
                "linked_paths": linked_paths
            })

    # --------------------------------------------------
    # Phase 6: Finish up
    # --------------------------------------------------

    update_status(status, phase="Saving results")

    duplicate_count = len(duplicate_groups)
    hardlink_count = len(hardlink_groups)
    duration = time.time() - start_ts

    # Surface problem files first (errors, then warnings/info), largest first.
    files.sort(key=lambda f: (
        0 if any(f["severity"] == "error" for f in f.get("findings", [])) else 1,
        -f["size"]
    ))

    history.append({
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "total_space": total_size,
        "wasted_space": wasted_size,
        "duplicate_count": duplicate_count,
        "hardlink_count": hardlink_count,
        "duration_seconds": round(duration, 1)
    })
    history = history[-HISTORY_LIMIT:]

    save_json(HISTORY_FILE, history)

    results = build_results(
        files, total_size, wasted_size, duplicate_count,
        hardlink_count, history, duration, partial=False
    )

    save_json(RESULTS_FILE, results)

    update_status(status, phase="Idle", current=0, total=0)

    return results
