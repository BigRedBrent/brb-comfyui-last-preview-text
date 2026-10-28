import json
import threading
from collections import OrderedDict

# The server keeps its own record of each node's text, so the browser can get it back
# after a refresh, or after being closed while jobs ran. It's kept in memory only,
# so restarting ComfyUI clears it.
_lock = threading.Lock()
# "<workflow>:<node>" -> the most recent jobs that reached that node, oldest first
_records = OrderedDict()
# Workflow id -> the workflow's saved path, sent by the browser whenever a workflow loads.
# ComfyUI can give a workflow a new id each time its tab is opened; the path stays the same.
_workflow_paths = OrderedDict()

MAX_KEYS = 200
MAX_RECORDS = 20
MAX_PATHS = 1000


def _subgraph_definitions(container, found=None):
    """Collects every subgraph definition in the workflow, including nested ones."""
    if found is None:
        found = {}
    definitions = container.get("definitions") if isinstance(container, dict) else None
    for definition in (definitions or {}).get("subgraphs", []) or []:
        if isinstance(definition, dict) and definition.get("id"):
            found[str(definition["id"])] = definition
            _subgraph_definitions(definition, found)
    return found


def _node_key(workflow, unique_id):
    """Identifies the node the same way the browser does.

    A node outside any subgraph is just its id. A node inside a subgraph is the
    id of the subgraph it's in plus its own id, so every copy of a subgraph that's
    used more than once gives the same key.
    """
    ids = str(unique_id).split(":")
    if len(ids) == 1 or not isinstance(workflow, dict):
        return str(unique_id)

    definitions = _subgraph_definitions(workflow)
    nodes = workflow.get("nodes", [])
    subgraph_id = None
    for node_id in ids[:-1]:
        node = next((n for n in nodes if isinstance(n, dict) and str(n.get("id")) == node_id), None)
        if node is None:
            return str(unique_id)
        subgraph_id = str(node.get("type"))
        definition = definitions.get(subgraph_id)
        if definition is None:
            return str(unique_id)
        nodes = definition.get("nodes", [])

    return f"sg:{subgraph_id}:{ids[-1]}"


def _to_text(value):
    """Turns any input into text, the way ComfyUI's Preview as Text node does."""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if value is None:
        return "None"
    try:
        return json.dumps(value, indent=4, ensure_ascii=False)
    except Exception:
        try:
            return str(value)
        except Exception:
            return "The input exists, but couldn't be turned into text."


def _prompt_queue():
    try:
        from server import PromptServer
        return PromptServer.instance.prompt_queue
    except Exception:
        return None


def _running_prompt_id(queue):
    """The id of the job running now (ComfyUI runs one job at a time)."""
    try:
        running, _ = queue.get_current_queue_volatile()
        return str(running[0][1]) if running else None
    except Exception:
        return None


def _remember(key, prompt_id, text):
    with _lock:
        records = [r for r in _records.pop(key, []) if r["prompt_id"] != prompt_id]
        records.append({"prompt_id": prompt_id, "text": text, "succeeded": False})
        _records[key] = records[-MAX_RECORDS:]
        while len(_records) > MAX_KEYS:
            _records.popitem(last=False)


def _succeeded(queue, record):
    """Whether the record's job finished successfully, according to ComfyUI's job history."""
    if record["succeeded"] or queue is None:
        return record["succeeded"]
    prompt_id = record["prompt_id"]
    try:
        entry = queue.get_history(prompt_id=prompt_id, map_function=lambda p: dict(p.get("status") or {}))
        status = entry.get(prompt_id) or {}
    except TypeError:
        # Older ComfyUI versions without map_function
        status = (queue.get_history(prompt_id=prompt_id).get(prompt_id) or {}).get("status") or {}
    except Exception:
        return False
    if status.get("status_str") == "success" and status.get("completed"):
        # Remembered, so clearing ComfyUI's history later doesn't undo it
        record["succeeded"] = True
    return record["succeeded"]


def _state(key):
    """Works out the three fields the same way the browser does."""
    queue = _prompt_queue()
    running = _running_prompt_id(queue) if queue is not None else None
    with _lock:
        records = _records.get(key, [])
        succeeded = [_succeeded(queue, r) for r in records]
        finished = next((r["text"] for r, ok in zip(reversed(records), reversed(succeeded)) if ok), "")
        previous = ""
        if records:
            earlier = list(zip(records[:-1], succeeded[:-1]))
            previous = next((r["text"] for r, ok in reversed(earlier) if ok), "")
        working = records[-1]["text"] if records and running and records[-1]["prompt_id"] == running else ""
    return {"previous": previous, "finished": finished, "working": working}


try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post("/last_preview_text/workflow")
    async def _link_workflow(request):
        data = await request.json()
        graph_id = str(data.get("graph_id") or "")
        path = str(data.get("path") or "")
        if graph_id and path:
            with _lock:
                _workflow_paths.pop(graph_id, None)
                _workflow_paths[graph_id] = path
                while len(_workflow_paths) > MAX_PATHS:
                    _workflow_paths.popitem(last=False)
        return web.json_response({"ok": True})

    @PromptServer.instance.routes.get("/last_preview_text/state")
    async def _get_state(request):
        workflow = request.rel_url.query.get("workflow", "")
        nodes = [n for n in request.rel_url.query.get("nodes", "").split(",") if n]
        return web.json_response({node: _state(f"{workflow}:{node}") for node in nodes})
except Exception:
    # Without the server routes the node still works; text just isn't restored on refresh
    pass


class LastPreviewText:
    """Shows the text from the previous, current and working jobs."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Accepts any type; it's turned into text before it's shown
                "text": ("*", {}),
                "mode": (["Plain text", "Markdown"], {"default": "Plain text"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "utils"
    DESCRIPTION = "Shows the previous run's text alongside the current run's text."

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Always run, so the display gets refreshed on every job
        return float("nan")

    def run(self, text, mode, unique_id=None, extra_pnginfo=None):
        text = _to_text(text)

        # Tag the text with the workflow and node it came from, so the browser
        # only updates this node, even when jobs from other workflows are running
        graph_id = ""
        workflow = None
        if isinstance(extra_pnginfo, dict):
            workflow = extra_pnginfo.get("workflow")
            if isinstance(workflow, dict):
                graph_id = str(workflow.get("id") or "")

        # Identify the workflow by its saved path when the browser has linked one
        with _lock:
            workflow_key = _workflow_paths.get(graph_id, graph_id)
        node_key = _node_key(workflow, unique_id or "")

        if workflow_key:
            queue = _prompt_queue()
            prompt_id = _running_prompt_id(queue) if queue is not None else None
            _remember(f"{workflow_key}:{node_key}", prompt_id or "", text)

        return {
            "ui": {
                "text": [text],
                "lpt_graph_id": [workflow_key],
                "lpt_node_id": [node_key],
            },
        }
