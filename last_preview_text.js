import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

// Text for every Last Preview Text node seen this session, keyed by
// "<workflow>:<node id>". It lives outside the nodes, so it survives
// switching workflow tabs and jobs from other workflows. Nothing is saved
// with the workflow; after a refresh, the text is fetched from the server,
// which keeps its own record (see nodes.py).
// (preview_text isn't kept here; see FIELDS.)
const states = new Map();
// Text received during each job that hasn't finished yet: prompt id -> (key -> text)
const pendingByPrompt = new Map();
// ComfyUI can give a workflow a new id each time its tab is opened, so each id
// is linked to the workflow's saved path, which stays the same: id -> path
const workflowPathByGraphId = new Map();
// Every Last Preview Text node currently on the canvas
const allNodes = new Set();

// Field name, which part of the saved state it shows, and its placeholder.
// Fields marked nodeOnly keep their text only on the node itself, so they're
// cleared whenever ComfyUI rebuilds the node (switching tabs, undo, and so on).
const FIELDS = [
    {
        name: "previous_preview_text",
        textKey: "previous",
        placeholder: "Shows the previous job's text once the next job starts…",
    },
    {
        name: "current_preview_text",
        textKey: "finished",
        placeholder: "Shows the previous job's text while jobs run, and the latest text once all jobs finish…",
    },
    {
        name: "working_preview_text",
        textKey: "working",
        placeholder: "Shows this workflow's job text while its job runs, and clears when that job ends…",
    },
    {
        name: "preview_text",
        textKey: "current",
        nodeOnly: true,
        placeholder: "Shows the current job's text as soon as it arrives…",
    },
];

const TITLE_SUFFIX = "__title";
const TITLE_HEIGHT = 20;

function toText(value) {
    if (Array.isArray(value)) {
        return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2))).join("\n");
    }
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

// The saved path of the workflow on screen, e.g. "workflows/My workflow.json"
function activeWorkflowPath() {
    try {
        return app.extensionManager?.workflow?.activeWorkflow?.path ?? null;
    } catch {
        return null;
    }
}

// Identifies a workflow by its saved path when its id has been linked to one,
// otherwise by the id itself
function workflowKey(graphId) {
    return workflowPathByGraphId.get(String(graphId)) ?? String(graphId);
}

// Identifies a node within its workflow, the same way the server does (see nodes.py).
// A node inside a subgraph is identified by that subgraph's id plus its own id, so
// every copy of a subgraph used more than once in a workflow gives the same key.
function nodePart(node) {
    const root = node.graph?.rootGraph ?? node.graph ?? app.rootGraph ?? app.graph;
    const inSubgraph = node.graph && root && node.graph !== root;
    return inSubgraph ? `sg:${node.graph.id}:${node.id}` : String(node.id);
}

function nodeKey(node) {
    const root = node.graph?.rootGraph ?? node.graph ?? app.rootGraph ?? app.graph;
    return `${workflowKey(root?.id ?? "")}:${nodePart(node)}`;
}

// Tells the server which saved path the workflow on screen has, then fetches the
// server's text for any of its nodes this page hasn't seen yet (after a refresh,
// or the first time a workflow is opened). Nodes this page is already tracking
// keep their own text, which is at least as up to date.
async function restoreFromServer(graphId, path) {
    try {
        await api.fetchApi("/last_preview_text/workflow", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ graph_id: String(graphId), path }),
        });

        const nodes = [...allNodes].filter((n) => !states.has(nodeKey(n)));
        if (!nodes.length) return;
        const parts = [...new Set(nodes.map(nodePart))];
        const query = `workflow=${encodeURIComponent(path)}&nodes=${encodeURIComponent(parts.join(","))}`;
        const result = await (await api.fetchApi(`/last_preview_text/state?${query}`)).json();

        for (const [part, saved] of Object.entries(result ?? {})) {
            const key = `${path}:${part}`;
            if (states.has(key)) continue;
            const state = getState(key);
            state.previous = saved.previous ?? "";
            state.finished = saved.finished ?? "";
            state.working = saved.working ?? "";
            refresh(key);
        }
    } catch {
        // Without the server's text, the fields just start empty
    }
}

// The most nodes whose text is kept; the least recently used are removed first
const MAX_STATES = 200;

function getState(key) {
    let state = states.get(key);
    if (state) {
        // Move it to the end, so nodes in use aren't the ones removed
        states.delete(key);
        states.set(key, state);
        return state;
    }
    state = { previous: "", finished: "", working: "" };
    states.set(key, state);
    while (states.size > MAX_STATES) {
        states.delete(states.keys().next().value);
    }
    return state;
}

function isMarkdown(node) {
    return node.widgets?.find((w) => w.name === "mode")?.value === "Markdown";
}

// Renamed field labels are kept in the node's properties so they're saved with the workflow
function getLabels(node) {
    node.properties = node.properties || {};
    node.properties.fieldLabels = node.properties.fieldLabels || {};
    return node.properties.fieldLabels;
}

function titleText(node, fieldName) {
    return getLabels(node)[fieldName] || fieldName;
}

// Small title shown on the node above each field; hidden from the right panel
function addTitleWidget(node, field) {
    const el = document.createElement("div");
    el.textContent = titleText(node, field.name);
    Object.assign(el.style, {
        boxSizing: "border-box",
        width: "100%",
        height: `${TITLE_HEIGHT}px`,
        lineHeight: `${TITLE_HEIGHT}px`,
        padding: "0 4px",
        fontSize: "11px",
        opacity: "0.75",
        color: "var(--input-text, #ddd)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        pointerEvents: "none",
        userSelect: "none",
    });

    const widget = node.addDOMWidget(field.name + TITLE_SUFFIX, "lpt_title", el, {
        serialize: false,
        hideInPanel: true,
        getMinHeight: () => TITLE_HEIGHT,
        getMaxHeight: () => TITLE_HEIGHT,
    });
    widget.serialize = false;
    widget.titleEl = el;
}

// Builds the preview fields using ComfyUI's own widgets: a text box for plain
// text, or the Markdown widget for Markdown. Each field keeps the same name in
// both modes, so a favorite in the right panel follows the selected mode.
function buildPreviewWidgets(node) {
    const size = [...node.size];
    const markdown = isMarkdown(node);
    const labels = getLabels(node);
    // A node that isn't in a graph yet has no proper id, so it starts empty. Only text
    // that already exists is looked up here, so loading a workflow doesn't add entries.
    const ready = node.graph && node.id != null && node.id !== -1;
    const state = (ready && states.get(nodeKey(node))) || { previous: "", finished: "", working: "" };

    for (const field of FIELDS) {
        for (const name of [field.name + TITLE_SUFFIX, field.name]) {
            const old = node.widgets?.find((w) => w.name === name);
            if (old) node.removeWidget(old);
        }
    }

    for (const field of FIELDS) {
        const text = (field.nodeOnly ? node.nodeText?.[field.textKey] : state[field.textKey]) ?? "";

        addTitleWidget(node, field);

        let widget;
        if (markdown) {
            widget = ComfyWidgets.MARKDOWN(node, field.name, ["STRING", { default: text }], app).widget;
        } else {
            widget = ComfyWidgets.STRING(
                node,
                field.name,
                ["STRING", { multiline: true, default: text, placeholder: field.placeholder }],
                app
            ).widget;
            // "element" is the current name; "inputEl" is only for older ComfyUI versions
            const textBox = widget.element ?? widget.inputEl;
            if (textBox) textBox.readOnly = true;
        }

        // Display only: read-only, not saved in the workflow or sent with the job
        widget.options = widget.options || {};
        widget.options.read_only = true;
        widget.options.serialize = false;
        widget.serialize = false;
        widget.value = text;
        if (labels[field.name]) widget.label = labels[field.name];
    }

    const minHeight = node.computeSize()[1];
    node.setSize([size[0], Math.max(size[1], minHeight)]);
    node.setDirtyCanvas?.(true, true);
}

// Picks up a field being renamed (in the right panel or on the node) and updates its title
function syncLabels(node) {
    const labels = getLabels(node);
    for (const field of FIELDS) {
        const widget = node.widgets?.find((w) => w.name === field.name);
        if (!widget) continue;
        const label = widget.label && widget.label !== field.name ? widget.label : "";
        if ((labels[field.name] || "") !== label) {
            if (label) labels[field.name] = label;
            else delete labels[field.name];
        }
        const title = node.widgets?.find((w) => w.name === field.name + TITLE_SUFFIX);
        const text = titleText(node, field.name);
        if (title?.titleEl && title.titleEl.textContent !== text) title.titleEl.textContent = text;
    }
}

// Shows the saved state on whichever node on the canvas matches the key, if any
function refresh(key) {
    const state = states.get(key);
    if (!state) return;
    for (const node of allNodes) {
        if (nodeKey(node) !== key) continue;
        for (const field of FIELDS) {
            if (field.nodeOnly) continue;
            const widget = node.widgets?.find((w) => w.name === field.name);
            if (widget) widget.value = state[field.textKey] ?? "";
        }
        node.setDirtyCanvas?.(true, true);
    }
}

// Shows the saved state on one node. Used once a workflow has finished loading,
// when its id has been linked to its saved path.
function refreshNode(node) {
    const state = states.get(nodeKey(node));
    for (const field of FIELDS) {
        if (field.nodeOnly) continue;
        const widget = node.widgets?.find((w) => w.name === field.name);
        if (widget) widget.value = state?.[field.textKey] ?? "";
    }
    node.setDirtyCanvas?.(true, true);
}

// Clears working_preview_text for the nodes a job reached, once that job has ended
function clearWorking(promptId) {
    const pending = pendingByPrompt.get(promptId);
    if (!pending) return;
    for (const key of pending.keys()) {
        const state = states.get(key);
        if (!state) continue;
        state.working = "";
        refresh(key);
    }
}

// Sets a nodeOnly field's text on a node that's on the canvas
function setNodeText(node, textKey, text) {
    node.nodeText = node.nodeText || {};
    node.nodeText[textKey] = text;
    const field = FIELDS.find((f) => f.textKey === textKey);
    const widget = node.widgets?.find((w) => w.name === field?.name);
    if (widget) widget.value = text;
    node.setDirtyCanvas?.(true, true);
}

// The job currently running (ComfyUI runs one job at a time)
let runningPromptId = null;

// Records text for previous_preview_text, current_preview_text and working_preview_text.
// It can be called twice for the same text (once from each path below); the second
// call changes nothing.
function recordText(key, promptId, text) {
    const state = getState(key);

    // A new job reached this node: the most recently finished text becomes previous_preview_text
    if (state.seenPromptId !== promptId) {
        if (state.finished) state.previous = state.finished;
        state.seenPromptId = promptId;
    }
    state.working = text;
    if (!pendingByPrompt.has(promptId)) pendingByPrompt.set(promptId, new Map());
    pendingByPrompt.get(promptId).set(key, text);

    refresh(key);
}

// The workflow and node a piece of text came from, if the server tagged it.
// When a subgraph is used more than once in a workflow, its copies share the same
// key, so the copy that ran most recently is what shows.
function taggedKey(output) {
    const nodeId = output?.lpt_node_id?.[0];
    if (!nodeId) return null;
    // Without a workflow id (a job sent from a script or another interface), don't guess
    const graphId = output.lpt_graph_id?.[0];
    if (!graphId) return null;
    return `${workflowKey(graphId)}:${nodeId}`;
}

app.registerExtension({
    name: "LastPreviewText",

    // Once a workflow has loaded (including switching back to its tab), link its id to
    // its saved path, show each node the text saved for that workflow, and get any
    // text this page doesn't have from the server
    afterLoadGraph() {
        const path = activeWorkflowPath();
        const graphId = (app.rootGraph ?? app.graph)?.id;
        if (path && graphId) workflowPathByGraphId.set(String(graphId), path);
        for (const node of allNodes) {
            refreshNode(node);
        }
        if (path && graphId) restoreFromServer(graphId, path);
    },

    setup() {
        api.addEventListener("execution_start", (e) => {
            runningPromptId = e.detail?.prompt_id ?? null;
        });

        // Tagged text also reaches workflows that aren't on screen, so their
        // previous_preview_text and current_preview_text still update
        api.addEventListener("executed", (e) => {
            const key = taggedKey(e.detail?.output);
            if (!key) return;
            recordText(key, e.detail.prompt_id, toText(e.detail.output.text ?? ""));
        });

        // When a job finishes successfully, its text becomes current_preview_text,
        // and working_preview_text clears for that job's workflow
        api.addEventListener("execution_success", (e) => {
            const pending = pendingByPrompt.get(e.detail?.prompt_id);
            clearWorking(e.detail?.prompt_id);
            pendingByPrompt.delete(e.detail?.prompt_id);
            if (!pending) return;
            for (const [key, text] of pending) {
                getState(key).finished = text;
                refresh(key);
            }
        });

        // A failed or cancelled job doesn't count as finished, but its working text still clears
        for (const event of ["execution_error", "execution_interrupted"]) {
            api.addEventListener(event, (e) => {
                clearWorking(e.detail?.prompt_id);
                pendingByPrompt.delete(e.detail?.prompt_id);
            });
        }
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "LastPreviewText") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);

            allNodes.add(this);

            // Rebuild the preview fields straight away when the mode is changed
            const modeWidget = this.widgets?.find((w) => w.name === "mode");
            if (modeWidget) {
                const callback = modeWidget.callback;
                modeWidget.callback = (...args) => {
                    const r = callback?.apply(modeWidget, args);
                    syncLabels(this);
                    buildPreviewWidgets(this);
                    return r;
                };
            }

            buildPreviewWidgets(this);
            return result;
        };

        // When a workflow loads or its tab is switched back to, match the fields
        // to the saved mode and labels, and to this session's text for the node
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            allNodes.add(this);
            buildPreviewWidgets(this);
            return result;
        };

        const onAdded = nodeType.prototype.onAdded;
        nodeType.prototype.onAdded = function () {
            const result = onAdded?.apply(this, arguments);
            allNodes.add(this);
            return result;
        };

        // ComfyUI hands the text to the node with this id in the workflow on screen.
        // This is the path that fills preview_text.
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            if (message?.text === undefined || message?.text === null) return;

            // If the text is tagged for a different workflow, it isn't for this node
            const key = taggedKey(message);
            if (key && key !== nodeKey(this)) return;

            const text = toText(message.text);
            setNodeText(this, "current", text);
            recordText(key ?? nodeKey(this), runningPromptId, text);
        };

        // The text stays in the session's saved state, so switching tabs doesn't lose it
        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            allNodes.delete(this);
            return onRemoved?.apply(this, arguments);
        };

        // Keep the titles in step with any renames
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function () {
            const result = onDrawForeground?.apply(this, arguments);
            syncLabels(this);
            return result;
        };
    },
});
