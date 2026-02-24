"""
Filesystem storage layer for workflow snapshots.

Stores each snapshot as an individual JSON file under:
    <extension_dir>/data/snapshots/<encoded_workflow_key>/<id>.json

Workflow keys are percent-encoded for filesystem safety.
"""

import json
import os
import urllib.parse

_DATA_DIR = os.path.join(os.path.dirname(__file__), "data", "snapshots")


def _workflow_dir(workflow_key):
    encoded = urllib.parse.quote(workflow_key, safe="")
    return os.path.join(_DATA_DIR, encoded)


def _validate_id(snapshot_id):
    if not snapshot_id or "/" in snapshot_id or "\\" in snapshot_id or ".." in snapshot_id:
        raise ValueError(f"Invalid snapshot id: {snapshot_id!r}")


def put(record):
    """Write one snapshot record to disk."""
    snapshot_id = record["id"]
    workflow_key = record["workflowKey"]
    _validate_id(snapshot_id)
    d = _workflow_dir(workflow_key)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{snapshot_id}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(record, f, separators=(",", ":"))


def get_all_for_workflow(workflow_key):
    """Return all snapshots for a workflow, sorted ascending by timestamp."""
    d = _workflow_dir(workflow_key)
    if not os.path.isdir(d):
        return []
    results = []
    for fname in os.listdir(d):
        if not fname.endswith(".json"):
            continue
        path = os.path.join(d, fname)
        try:
            with open(path, "r", encoding="utf-8") as f:
                results.append(json.load(f))
        except (json.JSONDecodeError, OSError):
            continue
    results.sort(key=lambda r: r.get("timestamp", 0))
    return results


def delete(workflow_key, snapshot_id):
    """Remove one snapshot file. Cleans up empty workflow dir."""
    _validate_id(snapshot_id)
    d = _workflow_dir(workflow_key)
    path = os.path.join(d, f"{snapshot_id}.json")
    if os.path.isfile(path):
        os.remove(path)
    # Clean up empty directory
    if os.path.isdir(d) and not os.listdir(d):
        os.rmdir(d)


def delete_all_for_workflow(workflow_key):
    """Delete all unlocked snapshots for a workflow. Returns {lockedCount}."""
    records = get_all_for_workflow(workflow_key)
    locked_count = 0
    for rec in records:
        if rec.get("locked"):
            locked_count += 1
        else:
            _validate_id(rec["id"])
            path = os.path.join(_workflow_dir(workflow_key), f"{rec['id']}.json")
            if os.path.isfile(path):
                os.remove(path)
    # Clean up empty directory
    d = _workflow_dir(workflow_key)
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
        count = sum(1 for f in os.listdir(subdir) if f.endswith(".json"))
        if count == 0:
            continue
        workflow_key = urllib.parse.unquote(encoded_name)
        results.append({"workflowKey": workflow_key, "count": count})
    results.sort(key=lambda r: r["workflowKey"])
    return results


def prune(workflow_key, max_snapshots):
    """Delete oldest unlocked snapshots beyond limit. Returns count deleted."""
    records = get_all_for_workflow(workflow_key)
    unlocked = [r for r in records if not r.get("locked")]
    if len(unlocked) <= max_snapshots:
        return 0
    to_delete = unlocked[: len(unlocked) - max_snapshots]
    d = _workflow_dir(workflow_key)
    deleted = 0
    for rec in to_delete:
        _validate_id(rec["id"])
        path = os.path.join(d, f"{rec['id']}.json")
        if os.path.isfile(path):
            os.remove(path)
            deleted += 1
    return deleted
