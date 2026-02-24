"""
ComfyUI Snapshot Manager

Automatically snapshots workflow state as you edit, with a sidebar panel
to browse and restore any previous version. Stored in server-side JSON files.
"""

from . import snapshot_routes
from .snapshot_node import SaveSnapshot

WEB_DIRECTORY = "./js"
NODE_CLASS_MAPPINGS = {"SaveSnapshot": SaveSnapshot}
NODE_DISPLAY_NAME_MAPPINGS = {"SaveSnapshot": "Save Snapshot"}
