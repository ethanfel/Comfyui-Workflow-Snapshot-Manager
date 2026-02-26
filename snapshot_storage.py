"""
Filesystem storage layer for workflow snapshots.

Stores each snapshot as an individual JSON file under:
    <extension_dir>/data/snapshots/<encoded_workflow_key>/<id>.json

Workflow keys are percent-encoded for filesystem safety.

An in-memory metadata cache avoids redundant disk reads for list/prune/delete
operations.  Only get_full_record() reads a file from disk after warm-up.
"""

import json
import os
import urllib.parse

_DATA_DIR = os.path.join(os.path.dirname(__file__), "data", "snapshots")

# ─── In-memory metadata cache ────────────────────────────────────────
# Maps workflow_key -> list of metadata dicts (sorted by timestamp asc).
# Metadata is everything *except* graphData.
_cache = {}
_cache_warmed = set()  # workflow keys already loaded from disk


def _extract_meta(record):
    """Return a lightweight copy of *record* without graphData."""
    return {k: v for k, v in record.items() if k != "graphData"}


def _ensure_cached(workflow_key):
    """Warm the cache for *workflow_key* if not already loaded. Return cached list."""
    if workflow_key not in _cache_warmed:
        d = _workflow_dir(workflow_key)
        entries = []
        if os.path.isdir(d):
            for fname in os.listdir(d):
                if not fname.endswith(".json"):
                    continue
                path = os.path.join(d, fname)
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        entries.append(_extract_meta(json.load(f)))
                except (json.JSONDecodeError, OSError):
                    continue
        entries.sort(key=lambda r: r.get("timestamp", 0))
        _cache[workflow_key] = entries
        _cache_warmed.add(workflow_key)
    return _cache.get(workflow_key, [])


# ─── Helpers ─────────────────────────────────────────────────────────

def _workflow_dir(workflow_key):
    encoded = urllib.parse.quote(workflow_key, safe="")
    return os.path.join(_DATA_DIR, encoded)


def _validate_id(snapshot_id):
    if not snapshot_id or "/" in snapshot_id or "\\" in snapshot_id or ".." in snapshot_id:
        raise ValueError(f"Invalid snapshot id: {snapshot_id!r}")


# ─── Public API ──────────────────────────────────────────────────────

def put(record):
    """Write one snapshot record to disk and update the cache."""
    snapshot_id = record["id"]
    workflow_key = record["workflowKey"]
    _validate_id(snapshot_id)
    d = _workflow_dir(workflow_key)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{snapshot_id}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(record, f, separators=(",", ":"))

    # Update cache only if already warmed; otherwise _ensure_cached will
    # pick up the new file from disk on next read.
    if workflow_key in _cache_warmed:
        meta = _extract_meta(record)
        cached = _cache[workflow_key]
        cached[:] = [e for e in cached if e.get("id") != snapshot_id]
        cached.append(meta)
        cached.sort(key=lambda r: r.get("timestamp", 0))


def get_all_for_workflow(workflow_key):
    """Return all snapshot metadata for a workflow (no graphData), sorted ascending by timestamp."""
    return [dict(e) for e in _ensure_cached(workflow_key)]


def get_full_record(workflow_key, snapshot_id):
    """Read a single snapshot file from disk (with graphData). Returns dict or None."""
    _validate_id(snapshot_id)
    path = os.path.join(_workflow_dir(workflow_key), f"{snapshot_id}.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def update_meta(workflow_key, snapshot_id, fields):
    """Merge *fields* into an existing snapshot on disk without touching graphData.

    Returns True on success, False if the file does not exist.
    """
    _validate_id(snapshot_id)
    path = os.path.join(_workflow_dir(workflow_key), f"{snapshot_id}.json")
    if not os.path.isfile(path):
        return False
    with open(path, "r", encoding="utf-8") as f:
        record = json.load(f)
    # Merge fields; None values remove the key
    for k, v in fields.items():
        if v is None:
            record.pop(k, None)
        else:
            record[k] = v
    with open(path, "w", encoding="utf-8") as f:
        json.dump(record, f, separators=(",", ":"))
    # Update cache entry
    for entry in _cache.get(workflow_key, []):
        if entry.get("id") == snapshot_id:
            for k, v in fields.items():
                if k == "graphData":
                    continue
                if v is None:
                    entry.pop(k, None)
                else:
                    entry[k] = v
            break
    return True


def delete(workflow_key, snapshot_id):
    """Remove one snapshot file and its cache entry. Cleans up empty workflow dir."""
    _validate_id(snapshot_id)
    d = _workflow_dir(workflow_key)
    path = os.path.join(d, f"{snapshot_id}.json")
    if os.path.isfile(path):
        os.remove(path)

    # Update cache
    if workflow_key in _cache:
        _cache[workflow_key] = [e for e in _cache[workflow_key] if e.get("id") != snapshot_id]
        if not _cache[workflow_key]:
            del _cache[workflow_key]
            _cache_warmed.discard(workflow_key)

    # Clean up empty directory
    if os.path.isdir(d) and not os.listdir(d):
        os.rmdir(d)


def delete_all_for_workflow(workflow_key):
    """Delete all unlocked snapshots for a workflow. Returns {lockedCount}."""
    entries = _ensure_cached(workflow_key)
    locked = []
    locked_count = 0
    d = _workflow_dir(workflow_key)
    for rec in entries:
        if rec.get("locked"):
            locked_count += 1
            locked.append(rec)
        else:
            _validate_id(rec["id"])
            path = os.path.join(d, f"{rec['id']}.json")
            if os.path.isfile(path):
                os.remove(path)

    # Update cache to locked-only
    if locked:
        _cache[workflow_key] = locked
    else:
        _cache.pop(workflow_key, None)
        _cache_warmed.discard(workflow_key)

    # Clean up empty directory
    if os.path.isdir(d) and not os.listdir(d):
        os.rmdir(d)
    return {"lockedCount": locked_count}


def get_all_workflow_keys():
    """Scan subdirs and return [{workflowKey, count}]."""
    if not os.path.isdir(_DATA_DIR):
        return []
    results = []
    for encoded_name in os.listdir(_DATA_DIR):
        subdir = os.path.join(_DATA_DIR, encoded_name)
        if not os.path.isdir(subdir):
            continue
        workflow_key = urllib.parse.unquote(encoded_name)
        entries = _ensure_cached(workflow_key)
        if not entries:
            continue
        results.append({"workflowKey": workflow_key, "count": len(entries)})
    results.sort(key=lambda r: r["workflowKey"])
    return results


def prune(workflow_key, max_snapshots, source=None):
    """Delete oldest unlocked snapshots beyond limit. Returns count deleted.

    source filtering:
      - "node": only prune records where source == "node"
      - "regular": only prune records where source is absent or not "node"
      - None: prune all unlocked (existing behavior)
    """
    entries = _ensure_cached(workflow_key)
    if source == "node":
        candidates = [r for r in entries if not r.get("locked") and r.get("source") == "node"]
    elif source == "regular":
        candidates = [r for r in entries if not r.get("locked") and r.get("source") != "node"]
    else:
        candidates = [r for r in entries if not r.get("locked")]
    if len(candidates) <= max_snapshots:
        return 0
    to_delete = candidates[: len(candidates) - max_snapshots]
    d = _workflow_dir(workflow_key)
    deleted = 0
    delete_ids = set()
    for rec in to_delete:
        _validate_id(rec["id"])
        path = os.path.join(d, f"{rec['id']}.json")
        if os.path.isfile(path):
            os.remove(path)
            deleted += 1
            delete_ids.add(rec["id"])

    # Update cache
    if delete_ids and workflow_key in _cache:
        _cache[workflow_key] = [e for e in _cache[workflow_key] if e.get("id") not in delete_ids]
        if not _cache[workflow_key]:
            del _cache[workflow_key]
            _cache_warmed.discard(workflow_key)

    # Clean up empty directory
    if os.path.isdir(d) and not os.listdir(d):
        os.rmdir(d)

    return deleted
