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
        if not workflow_key or max_snapshots is None:
            return web.json_response({"error": "Missing workflowKey or maxSnapshots"}, status=400)
        deleted = storage.prune(workflow_key, int(max_snapshots))
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
