import base64
import io

from server import PromptServer


class _AnyType(str):
    def __ne__(self, other):
        return False


ANY_TYPE = _AnyType("*")


def _make_thumbnail(value):
    """Convert an image tensor to a base64 JPEG thumbnail, or return None."""
    try:
        import torch
        if not isinstance(value, torch.Tensor):
            return None
        if value.ndim != 4 or value.shape[3] not in (3, 4):
            return None

        from PIL import Image

        frame = value[0]  # first frame only
        if frame.shape[2] == 4:
            frame = frame[:, :, :3]  # drop alpha
        arr = frame.clamp(0, 1).mul(255).byte().cpu().numpy()
        img = Image.fromarray(arr, mode="RGB")
        img.thumbnail((200, 150), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=75)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return None


class SaveSnapshot:
    CATEGORY = "Snapshot Manager"
    FUNCTION = "execute"
    RETURN_TYPES = (ANY_TYPE,)
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": (ANY_TYPE, {}),
                "label": ("STRING", {"default": "Node Trigger"}),
            }
        }

    @classmethod
    def VALIDATE_INPUTS(cls, input_types):
        return True

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return float("NaN")

    def execute(self, value, label):
        payload = {"label": label}
        thumbnail = _make_thumbnail(value)
        if thumbnail is not None:
            payload["thumbnail"] = thumbnail
        PromptServer.instance.send_sync(
            "snapshot-manager-capture", payload
        )
        return (value,)
