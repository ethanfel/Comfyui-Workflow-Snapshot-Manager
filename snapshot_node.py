from server import PromptServer


class _AnyType(str):
    def __ne__(self, other):
        return False


ANY_TYPE = _AnyType("*")


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
        PromptServer.instance.send_sync(
            "snapshot-manager-capture", {"label": label}
        )
        return (value,)
