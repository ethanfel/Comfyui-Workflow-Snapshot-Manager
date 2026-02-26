"""
HTTP route handlers for snapshot storage.

Registers endpoints with PromptServer.instance.routes at import time.
"""

from aiohttp import web
from server import PromptServer

from . import snapshot_storage as storage

routes = PromptServer.instance.routes


@routes.post("/snapshot-manager/save")
async def save_snapshot(request):
    try:
        data = await request.json()
        record = data.get("record")
        if not record or "id" not in record or "workflowKey" not in record:
            return web.json_response({"error": "Missing record with id and workflowKey"}, status=400)
        storage.put(record)
        return web.json_response({"ok": True})
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/snapshot-manager/list")
async def list_snapshots(request):
    try:
        data = await request.json()
        workflow_key = data.get("workflowKey")
        if not workflow_key:
            return web.json_response({"error": "Missing workflowKey"}, status=400)
        records = storage.get_all_for_workflow(workflow_key)
        return web.json_response(records)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/snapshot-manager/get")
async def get_snapshot(request):
    try:
        data = await request.json()
        workflow_key = data.get("workflowKey")
        snapshot_id = data.get("id")
        if not workflow_key or not snapshot_id:
            return web.json_response({"error": "Missing workflowKey or id"}, status=400)
        record = storage.get_full_record(workflow_key, snapshot_id)
        if record is None:
            return web.json_response({"error": "Not found"}, status=404)
        return web.json_response(record)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/snapshot-manager/update-meta")
async def update_snapshot_meta(request):
    try:
        data = await request.json()
        workflow_key = data.get("workflowKey")
        snapshot_id = data.get("id")
        fields = data.get("fields")
        if not workflow_key or not snapshot_id or not isinstance(fields, dict):
            return web.json_response({"error": "Missing workflowKey, id, or fields"}, status=400)
        ok = storage.update_meta(workflow_key, snapshot_id, fields)
        if not ok:
            return web.json_response({"error": "Not found"}, status=404)
        return web.json_response({"ok": True})
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/snapshot-manager/delete")
async def delete_snapshot(request):
    try:
        data = await request.json()
        workflow_key = data.get("workflowKey")
        snapshot_id = data.get("id")
        if not workflow_key or not snapshot_id:
            return web.json_response({"error": "Missing workflowKey or id"}, status=400)
        storage.delete(workflow_key, snapshot_id)
        return web.json_response({"ok": True})
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/snapshot-manager/delete-all")
async def delete_all_snapshots(request):
    try:
        data = await request.json()
        workflow_key = data.get("workflowKey")
        if not workflow_key:
            return web.json_response({"error": "Missing workflowKey"}, status=400)
        result = storage.delete_all_for_workflow(workflow_key)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/snapshot-manager/workflows")
async def list_workflows(request):
    try:
        keys = storage.get_all_workflow_keys()
        return web.json_response(keys)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/snapshot-manager/prune")
async def prune_snapshots(request):
    try:
        data = await request.json()
        workflow_key = data.get("workflowKey")
        max_snapshots = data.get("maxSnapshots")
        source = data.get("source")
        protected_ids = data.get("protectedIds")
        if not workflow_key or max_snapshots is None:
            return web.json_response({"error": "Missing workflowKey or maxSnapshots"}, status=400)
        deleted = storage.prune(workflow_key, int(max_snapshots), source=source, protected_ids=protected_ids)
        return web.json_response({"deleted": deleted})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/snapshot-manager/migrate")
async def migrate_snapshots(request):
    try:
        data = await request.json()
        records = data.get("records")
        if not isinstance(records, list):
            return web.json_response({"error": "Missing records array"}, status=400)
        imported = 0
        for record in records:
            if "id" in record and "workflowKey" in record:
                storage.put(record)
                imported += 1
        return web.json_response({"imported": imported})
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ─── Profile Endpoints ───────────────────────────────────────────────

@routes.post("/snapshot-manager/profile/save")
async def save_profile(request):
    try:
        data = await request.json()
        profile = data.get("profile")
        if not profile or "id" not in profile:
            return web.json_response({"error": "Missing profile with id"}, status=400)
        storage.profile_put(profile)
        return web.json_response({"ok": True})
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/snapshot-manager/profile/list")
async def list_profiles(request):
    try:
        profiles = storage.profile_get_all()
        return web.json_response(profiles)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/snapshot-manager/profile/get")
async def get_profile(request):
    try:
        data = await request.json()
        profile_id = data.get("id")
        if not profile_id:
            return web.json_response({"error": "Missing id"}, status=400)
        profile = storage.profile_get(profile_id)
        if profile is None:
            return web.json_response({"error": "Not found"}, status=404)
        return web.json_response(profile)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/snapshot-manager/profile/delete")
async def delete_profile(request):
    try:
        data = await request.json()
        profile_id = data.get("id")
        if not profile_id:
            return web.json_response({"error": "Missing id"}, status=400)
        storage.profile_delete(profile_id)
        return web.json_response({"ok": True})
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
