/**
 * ComfyUI Snapshot Manager
 *
 * Automatically captures workflow snapshots as you edit, stores them on the
 * server as JSON files, and provides a sidebar panel to browse and restore
 * any previous version.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXTENSION_NAME = "ComfyUI.SnapshotManager";
const RESTORE_GUARD_MS = 500;
const INITIAL_CAPTURE_DELAY_MS = 1500;
const MIGRATE_BATCH_SIZE = 10;
const OLD_DB_NAME = "ComfySnapshotManager";
const OLD_STORE_NAME = "snapshots";

// ─── Configurable Settings (updated via ComfyUI settings UI) ────────

let maxSnapshots = 50;
let debounceMs = 3000;
let autoCaptureEnabled = true;
let captureOnLoad = true;
let maxNodeSnapshots = 5;
let showTimeline = false;

// ─── State ───────────────────────────────────────────────────────────

const lastCapturedHashMap = new Map();
const lastGraphDataMap = new Map(); // workflowKey -> previous graphData for change-type detection
let restoreLock = null;
let captureTimer = null;
let sidebarRefresh = null; // callback set by sidebar render
let viewingWorkflowKey = null; // null = follow active workflow; string = override
let pickerDirty = true; // forces workflow picker to re-fetch on next expand
let timelineEl = null;       // root DOM element for timeline bar
let timelineRefresh = null;  // callback to re-render timeline
let activeSnapshotId = null;   // ID of the snapshot currently loaded via swap
let currentSnapshotId = null;  // ID of the auto-saved "Current" snapshot before a swap
let diffBaseSnapshot = null;   // snapshot record selected as diff base (shift+click)
const svgCache = new Map();    // "snapshotId:WxH" -> SVGElement template
let svgClipCounter = 0;        // unique prefix for SVG clipPath IDs
let sidebarTooltipEl = null;   // tooltip element for sidebar hover previews
const lastCapturedIdMap = new Map(); // workflowKey -> id of most recent capture (for parentId chaining)
const activeBranchSelections = new Map(); // forkPointId -> selected child index
let branchingEnabled = true;
let timelineExpanded = false;
const sessionWorkflows = new Map(); // workflowKey -> { firstSeen, lastSeen }

// ─── Server API Layer ───────────────────────────────────────────────

async function db_put(record) {
    try {
        const resp = await api.fetchApi("/snapshot-manager/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ record }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || resp.statusText);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Save failed:`, err);
        showToast("Failed to save snapshot", "error");
        throw err;
    }
}

async function db_getAllForWorkflow(workflowKey) {
    try {
        const resp = await api.fetchApi("/snapshot-manager/list", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflowKey }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || resp.statusText);
        }
        return await resp.json();
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] List failed:`, err);
        showToast("Failed to read snapshots", "error");
        return [];
    }
}

async function db_delete(workflowKey, id) {
    try {
        const resp = await api.fetchApi("/snapshot-manager/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflowKey, id }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || resp.statusText);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Delete failed:`, err);
        showToast("Failed to delete snapshot", "error");
    }
}

async function db_deleteAllForWorkflow(workflowKey) {
    try {
        const resp = await api.fetchApi("/snapshot-manager/delete-all", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflowKey }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || resp.statusText);
        }
        return await resp.json();
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Bulk delete failed:`, err);
        showToast("Failed to clear snapshots", "error");
        throw err;
    }
}

async function db_getAllWorkflowKeys() {
    try {
        const resp = await api.fetchApi("/snapshot-manager/workflows");
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || resp.statusText);
        }
        return await resp.json();
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Workflow key scan failed:`, err);
        return [];
    }
}

async function db_updateMeta(workflowKey, id, fields) {
    try {
        const resp = await api.fetchApi("/snapshot-manager/update-meta", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflowKey, id, fields }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || resp.statusText);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Update meta failed:`, err);
        showToast("Failed to update snapshot", "error");
    }
}

async function db_getFullRecord(workflowKey, id) {
    try {
        const resp = await api.fetchApi("/snapshot-manager/get", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflowKey, id }),
        });
        if (!resp.ok) return null;
        return await resp.json();
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Get full record failed:`, err);
        return null;
    }
}

async function pruneSnapshots(workflowKey, protectedIds = []) {
    try {
        const resp = await api.fetchApi("/snapshot-manager/prune", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflowKey, maxSnapshots, source: "regular", protectedIds }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || resp.statusText);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Prune failed:`, err);
    }
}

async function pruneNodeSnapshots(workflowKey, protectedIds = []) {
    try {
        const resp = await api.fetchApi("/snapshot-manager/prune", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflowKey, maxSnapshots: maxNodeSnapshots, source: "node", protectedIds }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || resp.statusText);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Node prune failed:`, err);
    }
}

// ─── Profile API Layer ───────────────────────────────────────────────

async function profile_save(profile) {
    try {
        const resp = await api.fetchApi("/snapshot-manager/profile/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profile }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || resp.statusText);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Profile save failed:`, err);
        showToast("Failed to save profile", "error");
        throw err;
    }
}

async function profile_list() {
    try {
        const resp = await api.fetchApi("/snapshot-manager/profile/list");
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || resp.statusText);
        }
        return await resp.json();
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Profile list failed:`, err);
        return [];
    }
}

async function profile_delete(profileId) {
    try {
        const resp = await api.fetchApi("/snapshot-manager/profile/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: profileId }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || resp.statusText);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Profile delete failed:`, err);
        showToast("Failed to delete profile", "error");
    }
}

function trackSessionWorkflow(workflowKey) {
    const now = Date.now();
    if (sessionWorkflows.has(workflowKey)) {
        sessionWorkflows.get(workflowKey).lastSeen = now;
    } else {
        sessionWorkflows.set(workflowKey, { firstSeen: now, lastSeen: now });
    }
}

// ─── IndexedDB Migration ────────────────────────────────────────────

async function migrateFromIndexedDB() {
    try {
        // Check if the old database exists (databases() not supported in all browsers)
        if (typeof indexedDB.databases === "function") {
            const databases = await indexedDB.databases();
            if (!databases.some((db) => db.name === OLD_DB_NAME)) return;
        }

        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(OLD_DB_NAME, 1);
            req.onupgradeneeded = (e) => {
                // DB didn't exist before — close and clean up
                e.target.transaction.abort();
                reject(new Error("no-existing-db"));
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        const allRecords = await new Promise((resolve, reject) => {
            const tx = db.transaction(OLD_STORE_NAME, "readonly");
            const req = tx.objectStore(OLD_STORE_NAME).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        db.close();

        if (allRecords.length === 0) {
            indexedDB.deleteDatabase(OLD_DB_NAME);
            return;
        }

        // Send in batches
        let totalImported = 0;
        for (let i = 0; i < allRecords.length; i += MIGRATE_BATCH_SIZE) {
            const batch = allRecords.slice(i, i + MIGRATE_BATCH_SIZE);
            const resp = await api.fetchApi("/snapshot-manager/migrate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ records: batch }),
            });
            if (!resp.ok) throw new Error("Migration batch failed");
            const result = await resp.json();
            totalImported += result.imported;
        }

        // Success — delete old database
        indexedDB.deleteDatabase(OLD_DB_NAME);
        console.log(`[${EXTENSION_NAME}] Migrated ${totalImported} snapshots from IndexedDB to server`);
    } catch (err) {
        if (err.message === "no-existing-db") return;
        console.warn(`[${EXTENSION_NAME}] IndexedDB migration failed (old data preserved):`, err);
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function quickHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
}

function getWorkflowKey() {
    try {
        const wf = app.extensionManager?.workflow?.activeWorkflow;
        return wf?.key || wf?.filename || wf?.path || "default";
    } catch {
        return "default";
    }
}

function getEffectiveWorkflowKey() {
    return viewingWorkflowKey ?? getWorkflowKey();
}

function getGraphData() {
    try {
        return app.graph.serialize();
    } catch {
        return null;
    }
}

function generateId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function validateSnapshotData(graphData) {
    return graphData != null && typeof graphData === "object" && Array.isArray(graphData.nodes);
}

// ─── Change-Type Detection ──────────────────────────────────────────

function detectChangeType(prevGraph, currGraph) {
    if (!prevGraph) return "initial";

    const prevNodes = prevGraph.nodes || [];
    const currNodes = currGraph.nodes || [];

    // Quick length check before building Sets
    if (prevNodes.length !== currNodes.length) {
        return prevNodes.length < currNodes.length ? "node_add" : "node_remove";
    }

    const prevIds = new Set(prevNodes.map(n => n.id));
    let hasAdded = false;
    let hasRemoved = false;
    for (let i = 0; i < currNodes.length; i++) {
        if (!prevIds.has(currNodes[i].id)) { hasAdded = true; break; }
    }
    if (hasAdded) {
        // Same length but different IDs → both add and remove
        return "mixed";
    }

    // Node sets identical (same length, all curr IDs exist in prev)
    // — check links, params, positions with early exits
    let flags = 0;
    const FLAG_CONNECTION = 1;
    const FLAG_PARAM = 2;
    const FLAG_MOVE = 4;
    const ALL_FLAGS = FLAG_CONNECTION | FLAG_PARAM | FLAG_MOVE;

    // Compare links — check length first to avoid stringify when possible
    const prevLinks = prevGraph.links || [];
    const currLinks = currGraph.links || [];
    if (prevLinks.length !== currLinks.length) {
        flags |= FLAG_CONNECTION;
    } else if (prevLinks.length > 0) {
        // Same length — spot-check first/last before full stringify
        const pFirst = prevLinks[0], cFirst = currLinks[0];
        const pLast = prevLinks[prevLinks.length - 1], cLast = currLinks[currLinks.length - 1];
        if (pFirst?.[0] !== cFirst?.[0] || pFirst?.[1] !== cFirst?.[1]
            || pLast?.[0] !== cLast?.[0] || pLast?.[1] !== cLast?.[1]) {
            flags |= FLAG_CONNECTION;
        } else if (JSON.stringify(prevLinks) !== JSON.stringify(currLinks)) {
            flags |= FLAG_CONNECTION;
        }
    }

    // Build lookup for prev nodes by id
    const prevNodeMap = new Map(prevNodes.map(n => [n.id, n]));

    for (const cn of currNodes) {
        const pn = prevNodeMap.get(cn.id);
        if (!pn) continue;

        // Compare widget values — cheap ref/length check before stringify
        if (!(flags & FLAG_PARAM)) {
            const cw = cn.widgets_values;
            const pw = pn.widgets_values;
            if (cw !== pw) {
                if (cw == null || pw == null
                    || !Array.isArray(cw) || !Array.isArray(pw)
                    || cw.length !== pw.length) {
                    flags |= FLAG_PARAM;
                } else {
                    // Same-length arrays — compare elements directly
                    for (let i = 0; i < cw.length; i++) {
                        if (cw[i] !== pw[i]) { flags |= FLAG_PARAM; break; }
                    }
                }
            }
        }

        // Compare positions
        if (!(flags & FLAG_MOVE)) {
            const cp = cn.pos, pp = pn.pos;
            if (cp?.[0] !== pp?.[0] || cp?.[1] !== pp?.[1]) flags |= FLAG_MOVE;
        }

        if (flags === ALL_FLAGS) break;
    }

    if (flags === 0) return "unknown";

    // Count set flags
    const count = ((flags & FLAG_CONNECTION) ? 1 : 0)
               + ((flags & FLAG_PARAM) ? 1 : 0)
               + ((flags & FLAG_MOVE) ? 1 : 0);
    if (count > 1) return "mixed";

    if (flags & FLAG_CONNECTION) return "connection";
    if (flags & FLAG_PARAM) return "param";
    if (flags & FLAG_MOVE) return "move";

    return "unknown";
}

// ─── Detailed Diff ──────────────────────────────────────────────────

function buildNodeLookup(...graphs) {
    const map = new Map();
    for (const g of graphs) {
        if (!g || !Array.isArray(g.nodes)) continue;
        for (const n of g.nodes) {
            if (!map.has(n.id)) {
                map.set(n.id, { type: n.type || "?", title: n.title || n.type || `#${n.id}` });
            }
        }
    }
    return map;
}

function computeDetailedDiff(baseGraph, targetGraph) {
    const empty = {
        addedNodes: [], removedNodes: [], modifiedNodes: [],
        addedLinks: [], removedLinks: [],
        summary: { nodesAdded: 0, nodesRemoved: 0, nodesModified: 0, linksAdded: 0, linksRemoved: 0 },
    };
    if (!baseGraph && !targetGraph) return empty;
    const bNodes = (baseGraph?.nodes || []);
    const tNodes = (targetGraph?.nodes || []);

    const baseMap = new Map(bNodes.map(n => [n.id, n]));
    const targetMap = new Map(tNodes.map(n => [n.id, n]));

    const addedNodes = [];
    const removedNodes = [];
    const modifiedNodes = [];

    // Removed: in base but not in target
    for (const [id, n] of baseMap) {
        if (!targetMap.has(id)) {
            removedNodes.push({ id, type: n.type || "?", title: n.title || n.type || `#${id}` });
        }
    }

    // Added or modified: in target
    for (const [id, tn] of targetMap) {
        const bn = baseMap.get(id);
        if (!bn) {
            addedNodes.push({ id, type: tn.type || "?", title: tn.title || tn.type || `#${id}` });
            continue;
        }
        // Check modifications
        const changes = {};

        // Position
        if (bn.pos?.[0] !== tn.pos?.[0] || bn.pos?.[1] !== tn.pos?.[1]) {
            changes.position = { from: bn.pos, to: tn.pos };
        }

        // Size
        if (bn.size?.[0] !== tn.size?.[0] || bn.size?.[1] !== tn.size?.[1]) {
            changes.size = { from: bn.size, to: tn.size };
        }

        // Title
        if ((bn.title || "") !== (tn.title || "")) {
            changes.title = { from: bn.title || "", to: tn.title || "" };
        }

        // Mode
        if (bn.mode !== tn.mode) {
            changes.mode = { from: bn.mode, to: tn.mode };
        }

        // Widget values
        const bw = bn.widgets_values;
        const tw = tn.widgets_values;
        if (bw !== tw) {
            if (bw == null || tw == null || !Array.isArray(bw) || !Array.isArray(tw) || bw.length !== tw.length) {
                changes.widgetValues = { from: bw, to: tw };
            } else {
                const diffs = [];
                for (let i = 0; i < Math.max(bw.length, tw.length); i++) {
                    const bv = i < bw.length ? bw[i] : undefined;
                    const tv = i < tw.length ? tw[i] : undefined;
                    if (bv !== tv) {
                        const bs = typeof bv === "object" ? JSON.stringify(bv) : String(bv ?? "");
                        const ts = typeof tv === "object" ? JSON.stringify(tv) : String(tv ?? "");
                        if (bs !== ts) diffs.push({ index: i, from: bs, to: ts });
                    }
                }
                if (diffs.length > 0) changes.widgetValues = diffs;
            }
        }

        // Properties (shallow key comparison)
        const bp = bn.properties || {};
        const tp = tn.properties || {};
        const allPropKeys = new Set([...Object.keys(bp), ...Object.keys(tp)]);
        const propDiffs = [];
        for (const key of allPropKeys) {
            const bv = bp[key];
            const tv = tp[key];
            if (bv !== tv) {
                const bs = typeof bv === "object" ? JSON.stringify(bv) : String(bv ?? "");
                const ts = typeof tv === "object" ? JSON.stringify(tv) : String(tv ?? "");
                if (bs !== ts) propDiffs.push({ key, from: bs, to: ts });
            }
        }
        if (propDiffs.length > 0) changes.properties = propDiffs;

        if (Object.keys(changes).length > 0) {
            modifiedNodes.push({
                id, type: tn.type || "?", title: tn.title || tn.type || `#${id}`, changes,
            });
        }
    }

    // Links
    const bLinks = (baseGraph?.links || []).filter(Boolean);
    const tLinks = (targetGraph?.links || []).filter(Boolean);

    const baseLinkMap = new Map(bLinks.map(l => [l[0], l]));
    const targetLinkMap = new Map(tLinks.map(l => [l[0], l]));

    const addedLinks = [];
    const removedLinks = [];

    for (const [linkId, l] of baseLinkMap) {
        if (!targetLinkMap.has(linkId)) {
            removedLinks.push({ linkId, srcNodeId: l[1], srcSlot: l[2], destNodeId: l[3], destSlot: l[4], type: l[5] });
        }
    }
    for (const [linkId, l] of targetLinkMap) {
        if (!baseLinkMap.has(linkId)) {
            addedLinks.push({ linkId, srcNodeId: l[1], srcSlot: l[2], destNodeId: l[3], destSlot: l[4], type: l[5] });
        }
    }

    return {
        addedNodes, removedNodes, modifiedNodes, addedLinks, removedLinks,
        summary: {
            nodesAdded: addedNodes.length,
            nodesRemoved: removedNodes.length,
            nodesModified: modifiedNodes.length,
            linksAdded: addedLinks.length,
            linksRemoved: removedLinks.length,
        },
    };
}

// ─── SVG Graph Renderer ─────────────────────────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_NODE_TITLE_HEIGHT = 25;
const SVG_SLOT_SPACING = 20;
const SVG_DEFAULTS = { width: 140, height: 80, color: "#333", bgcolor: "#353535" };
const SVG_LINK_TYPE_COLORS = {
    IMAGE: "#64b5f6", CLIP: "#ffa726", MODEL: "#b39ddb",
    CONDITIONING: "#ef9a9a", LATENT: "#ff63c9", VAE: "#ff6e6e",
    MASK: "#81c784", INT: "#7986cb", FLOAT: "#7986cb", STRING: "#7986cb",
};
const SVG_HIGHLIGHT_COLORS = { added: "#22c55e", removed: "#dc2626", modified: "#f59e0b" };

function renderGraphSVG(graphData, options = {}) {
    const {
        width = 400, height = 300, padding = 40,
        highlightNodes = null, showLabels = true,
        showLinks = true, showSlots = true, showGroups = true,
        backgroundColor = "#1a1a2e",
    } = options;

    const nodes = graphData?.nodes;
    if (!nodes || nodes.length === 0) return null;

    // Build node map (skip null entries)
    const nodeMap = new Map();
    for (const n of nodes) {
        if (n == null) continue;
        nodeMap.set(n.id, n);
    }
    if (nodeMap.size === 0) return null;

    // Compute bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodeMap.values()) {
        const x = n.pos?.[0] ?? 0;
        const y = n.pos?.[1] ?? 0;
        const w = n.size?.[0] ?? SVG_DEFAULTS.width;
        const h = n.flags?.collapsed ? SVG_NODE_TITLE_HEIGHT : (n.size?.[1] ?? SVG_DEFAULTS.height);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + w > maxX) maxX = x + w;
        if (y + h > maxY) maxY = y + h;
    }

    // Include groups in bbox
    const groups = graphData.groups || [];
    if (showGroups) {
        for (const g of groups) {
            if (!g?.bounding) continue;
            const [gx, gy, gw, gh] = g.bounding;
            if (gx < minX) minX = gx;
            if (gy < minY) minY = gy;
            if (gx + gw > maxX) maxX = gx + gw;
            if (gy + gh > maxY) maxY = gy + gh;
        }
    }

    // Guard zero-area bbox (single node edge case)
    if (maxX - minX < 1) maxX = minX + SVG_DEFAULTS.width;
    if (maxY - minY < 1) maxY = minY + SVG_DEFAULTS.height;

    const bboxW = maxX - minX + padding * 2;
    const bboxH = maxY - minY + padding * 2;
    const vbX = minX - padding;
    const vbY = minY - padding;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `${vbX} ${vbY} ${bboxW} ${bboxH}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.style.display = "block";

    // Auto-simplify for thumbnails
    const effectiveLabels = width < 200 ? false : showLabels;
    const effectiveSlots = width < 200 ? false : showSlots;
    const clipPrefix = `sc${svgClipCounter++}`;

    // Background
    const bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("x", vbX);
    bg.setAttribute("y", vbY);
    bg.setAttribute("width", bboxW);
    bg.setAttribute("height", bboxH);
    bg.setAttribute("fill", backgroundColor);
    svg.appendChild(bg);

    // Groups
    if (showGroups && groups.length > 0) {
        for (const g of groups) {
            if (!g?.bounding) continue;
            const [gx, gy, gw, gh] = g.bounding;
            const gRect = document.createElementNS(SVG_NS, "rect");
            gRect.setAttribute("x", gx);
            gRect.setAttribute("y", gy);
            gRect.setAttribute("width", gw);
            gRect.setAttribute("height", gh);
            gRect.setAttribute("rx", "5");
            const gColor = g.color || "#335";
            gRect.setAttribute("fill", gColor);
            gRect.setAttribute("fill-opacity", "0.3");
            gRect.setAttribute("stroke", gColor);
            gRect.setAttribute("stroke-opacity", "0.5");
            gRect.setAttribute("stroke-width", "1");
            svg.appendChild(gRect);

            // Group title
            if (effectiveLabels && g.title) {
                const gText = document.createElementNS(SVG_NS, "text");
                gText.setAttribute("x", gx + 8);
                gText.setAttribute("y", gy + 16);
                gText.setAttribute("fill", "#aaa");
                gText.setAttribute("font-size", "14");
                gText.setAttribute("font-family", "system-ui, sans-serif");
                gText.textContent = g.title;
                svg.appendChild(gText);
            }
        }
    }

    // Slot position helpers
    function getOutputSlotPos(node, slotIndex) {
        const x = node.pos?.[0] ?? 0;
        const y = node.pos?.[1] ?? 0;
        const w = node.size?.[0] ?? SVG_DEFAULTS.width;
        return [x + w, y + SVG_NODE_TITLE_HEIGHT + slotIndex * SVG_SLOT_SPACING + SVG_SLOT_SPACING / 2];
    }

    function getInputSlotPos(node, slotIndex) {
        const x = node.pos?.[0] ?? 0;
        const y = node.pos?.[1] ?? 0;
        return [x, y + SVG_NODE_TITLE_HEIGHT + slotIndex * SVG_SLOT_SPACING + SVG_SLOT_SPACING / 2];
    }

    // Links
    const links = (graphData.links || []).filter(Boolean);
    if (showLinks && links.length <= 2000) {
        for (const link of links) {
            const srcNodeId = link[1];
            const srcSlot = link[2];
            const destNodeId = link[3];
            const destSlot = link[4];
            const linkType = link[5];

            const srcNode = nodeMap.get(srcNodeId);
            const destNode = nodeMap.get(destNodeId);
            if (!srcNode || !destNode) continue;

            // Skip links from collapsed source nodes where slot is hidden
            const srcCollapsed = srcNode.flags?.collapsed;
            const destCollapsed = destNode.flags?.collapsed;

            const [srcX, srcY] = srcCollapsed
                ? [(srcNode.pos?.[0] ?? 0) + (srcNode.size?.[0] ?? SVG_DEFAULTS.width), (srcNode.pos?.[1] ?? 0) + SVG_NODE_TITLE_HEIGHT / 2]
                : getOutputSlotPos(srcNode, srcSlot);
            const [destX, destY] = destCollapsed
                ? [(destNode.pos?.[0] ?? 0), (destNode.pos?.[1] ?? 0) + SVG_NODE_TITLE_HEIGHT / 2]
                : getInputSlotPos(destNode, destSlot);

            const dx = Math.max(Math.abs(destX - srcX) * 0.5, 50);
            const d = `M ${srcX} ${srcY} C ${srcX + dx} ${srcY}, ${destX - dx} ${destY}, ${destX} ${destY}`;

            const path = document.createElementNS(SVG_NS, "path");
            path.setAttribute("d", d);
            path.setAttribute("fill", "none");
            const color = SVG_LINK_TYPE_COLORS[linkType] || "#888";
            path.setAttribute("stroke", color);
            path.setAttribute("stroke-width", "2");
            path.setAttribute("stroke-opacity", "0.5");
            svg.appendChild(path);
        }
    }

    // Nodes
    for (const n of nodeMap.values()) {
        const x = n.pos?.[0] ?? 0;
        const y = n.pos?.[1] ?? 0;
        const w = n.size?.[0] ?? SVG_DEFAULTS.width;
        const isCollapsed = n.flags?.collapsed;
        const h = isCollapsed ? SVG_NODE_TITLE_HEIGHT : (n.size?.[1] ?? SVG_DEFAULTS.height);
        const bgcolor = n.bgcolor || SVG_DEFAULTS.bgcolor;
        const color = n.color || SVG_DEFAULTS.color;

        const highlightType = highlightNodes?.get(n.id);
        const highlightColor = highlightType ? SVG_HIGHLIGHT_COLORS[highlightType] : null;

        // Node body
        const body = document.createElementNS(SVG_NS, "rect");
        body.setAttribute("x", x);
        body.setAttribute("y", y);
        body.setAttribute("width", w);
        body.setAttribute("height", h);
        body.setAttribute("rx", "4");
        body.setAttribute("fill", bgcolor);
        if (highlightColor) {
            body.setAttribute("stroke", highlightColor);
            body.setAttribute("stroke-width", "3");
        } else {
            body.setAttribute("stroke", "#555");
            body.setAttribute("stroke-width", "1");
        }
        svg.appendChild(body);

        // Title bar
        const titleBar = document.createElementNS(SVG_NS, "rect");
        titleBar.setAttribute("x", x);
        titleBar.setAttribute("y", y);
        titleBar.setAttribute("width", w);
        titleBar.setAttribute("height", SVG_NODE_TITLE_HEIGHT);
        titleBar.setAttribute("rx", "4");
        titleBar.setAttribute("fill", color);
        svg.appendChild(titleBar);

        // Title text
        if (effectiveLabels) {
            const titleText = document.createElementNS(SVG_NS, "text");
            titleText.setAttribute("x", x + 8);
            titleText.setAttribute("y", y + 16);
            titleText.setAttribute("fill", "#eee");
            titleText.setAttribute("font-size", "11");
            titleText.setAttribute("font-family", "system-ui, sans-serif");
            // Truncate to fit node width
            const maxChars = Math.max(4, Math.floor(w / 7));
            const title = n.title || n.type || "";
            titleText.textContent = title.length > maxChars ? title.slice(0, maxChars - 1) + "\u2026" : title;
            // Clip to node width
            const clipId = `${clipPrefix}-${n.id}`;
            const clipPath = document.createElementNS(SVG_NS, "clipPath");
            clipPath.setAttribute("id", clipId);
            const clipRect = document.createElementNS(SVG_NS, "rect");
            clipRect.setAttribute("x", x);
            clipRect.setAttribute("y", y);
            clipRect.setAttribute("width", w);
            clipRect.setAttribute("height", SVG_NODE_TITLE_HEIGHT);
            clipPath.appendChild(clipRect);
            svg.appendChild(clipPath);
            titleText.setAttribute("clip-path", `url(#${clipId})`);
            svg.appendChild(titleText);
        }

        // Slots
        if (effectiveSlots && !isCollapsed) {
            const inputs = n.inputs || [];
            for (let i = 0; i < inputs.length; i++) {
                const [sx, sy] = getInputSlotPos(n, i);
                const circle = document.createElementNS(SVG_NS, "circle");
                circle.setAttribute("cx", sx);
                circle.setAttribute("cy", sy);
                circle.setAttribute("r", "4");
                const slotType = inputs[i]?.type || "";
                circle.setAttribute("fill", SVG_LINK_TYPE_COLORS[slotType] || "#888");
                svg.appendChild(circle);
            }

            const outputs = n.outputs || [];
            for (let i = 0; i < outputs.length; i++) {
                const [sx, sy] = getOutputSlotPos(n, i);
                const circle = document.createElementNS(SVG_NS, "circle");
                circle.setAttribute("cx", sx);
                circle.setAttribute("cy", sy);
                circle.setAttribute("r", "4");
                const slotType = outputs[i]?.type || "";
                circle.setAttribute("fill", SVG_LINK_TYPE_COLORS[slotType] || "#888");
                svg.appendChild(circle);
            }
        }
    }

    return svg;
}

function getCachedSVG(snapshotId, graphData, options = {}) {
    const { width = 400, height = 300 } = options;
    const key = `${snapshotId}:${width}x${height}`;
    if (svgCache.has(key)) {
        return svgCache.get(key).cloneNode(true);
    }
    const svg = renderGraphSVG(graphData, options);
    if (svg) {
        svgCache.set(key, svg);
        return svg.cloneNode(true);
    }
    return null;
}

// ─── Snapshot Tree (Branching) ───────────────────────────────────────

function buildSnapshotTree(records) {
    const childrenOf = new Map(); // parentId -> [children records]
    const parentOf = new Map();   // id -> parentId
    const roots = [];
    const byId = new Map();

    for (const r of records) byId.set(r.id, r);

    // Separate legacy (no parentId) from branched records
    const legacy = [];
    const branched = [];
    for (const r of records) {
        if (r.parentId === undefined || r.parentId === null) {
            legacy.push(r);
        } else {
            branched.push(r);
        }
    }

    // Chain legacy snapshots by timestamp order (backwards compat)
    legacy.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < legacy.length; i++) {
        const r = legacy[i];
        const syntheticParent = i > 0 ? legacy[i - 1].id : null;
        if (syntheticParent) {
            parentOf.set(r.id, syntheticParent);
            if (!childrenOf.has(syntheticParent)) childrenOf.set(syntheticParent, []);
            childrenOf.get(syntheticParent).push(r);
        } else {
            roots.push(r);
        }
    }

    // Process branched records
    for (const r of branched) {
        parentOf.set(r.id, r.parentId);
        if (byId.has(r.parentId)) {
            if (!childrenOf.has(r.parentId)) childrenOf.set(r.parentId, []);
            childrenOf.get(r.parentId).push(r);
        } else {
            // Parent not found (deleted?), treat as root
            roots.push(r);
        }
    }

    // Sort children by timestamp at each fork point
    for (const [, children] of childrenOf) {
        children.sort((a, b) => a.timestamp - b.timestamp);
    }

    return { childrenOf, parentOf, roots, byId };
}

function getDisplayPath(tree, branchSelections) {
    const { childrenOf, roots } = tree;
    if (roots.length === 0) return [];

    // Pick root (should normally be 1, but handle multiple)
    const rootIndex = branchSelections.get("__root__") ?? 0;
    let current = roots[Math.min(rootIndex, roots.length - 1)];
    if (!current) return [];

    const path = [current];
    while (true) {
        const children = childrenOf.get(current.id);
        if (!children || children.length === 0) break;
        const selectedIndex = branchSelections.get(current.id) ?? 0;
        current = children[Math.min(selectedIndex, children.length - 1)];
        path.push(current);
    }
    return path;
}

function getAncestorIds(snapshotId, parentOf) {
    const ancestors = new Set();
    let current = snapshotId;
    while (parentOf.has(current)) {
        current = parentOf.get(current);
        if (ancestors.has(current)) break; // safety: cycle detection
        ancestors.add(current);
    }
    return ancestors;
}

function getAllBranches(tree) {
    const branches = [];
    function walk(nodeId, path) {
        const record = tree.byId.get(nodeId);
        if (!record) return;
        const currentPath = [...path, record];
        const children = tree.childrenOf.get(nodeId);
        if (!children || children.length === 0) {
            branches.push(currentPath);
        } else {
            for (const child of children) {
                walk(child.id, currentPath);
            }
        }
    }
    for (const root of tree.roots) {
        walk(root.id, []);
    }
    return branches;
}

function selectBranchContaining(snapshotId, tree) {
    // Walk from snapshot to root, at each fork set activeBranchSelections
    const pathToRoot = [];
    const visited = new Set();
    let current = snapshotId;
    while (current) {
        if (visited.has(current)) break; // cycle detection
        visited.add(current);
        pathToRoot.push(current);
        current = tree.parentOf.get(current) || null;
    }
    pathToRoot.reverse(); // now root → snapshot

    // Handle multiple roots
    if (pathToRoot.length > 0 && tree.roots.length > 1) {
        const rootId = pathToRoot[0];
        const rootIdx = tree.roots.findIndex(r => r.id === rootId);
        if (rootIdx >= 0) activeBranchSelections.set("__root__", rootIdx);
    }

    for (let i = 0; i < pathToRoot.length - 1; i++) {
        const parentId = pathToRoot[i];
        const childId = pathToRoot[i + 1];
        const children = tree.childrenOf.get(parentId);
        if (children && children.length > 1) {
            const idx = children.findIndex(c => c.id === childId);
            if (idx >= 0) activeBranchSelections.set(parentId, idx);
        }
    }
}

// ─── Restore Lock ───────────────────────────────────────────────────

async function withRestoreLock(fn) {
    if (restoreLock) return;
    let resolve;
    restoreLock = new Promise((r) => { resolve = r; });
    try {
        await fn();
    } finally {
        setTimeout(() => {
            restoreLock = null;
            resolve();
            if (sidebarRefresh) {
                sidebarRefresh().catch(() => {});
            }
            if (timelineRefresh) {
                timelineRefresh().catch(() => {});
            }
        }, RESTORE_GUARD_MS);
    }
}

// ─── UI Utilities ───────────────────────────────────────────────────

function showToast(message, severity = "info") {
    try {
        app.extensionManager.toast.add({
            severity,
            summary: "Snapshot Manager",
            detail: message,
            life: 2500,
        });
    } catch { /* silent fallback */ }
}

async function showConfirmDialog(message) {
    try {
        return await app.extensionManager.dialog.confirm({
            title: "Snapshot Manager",
            message,
        });
    } catch {
        return window.confirm(message);
    }
}

async function showPromptDialog(message, defaultValue = "Manual") {
    try {
        const result = await app.extensionManager.dialog.prompt({
            title: "Snapshot Name",
            message,
        });
        return result;
    } catch {
        return window.prompt(message, defaultValue);
    }
}

// ─── Diff Modal ─────────────────────────────────────────────────────

function showDiffModal(baseLabel, targetLabel, diff, allNodes, baseGraphData, targetGraphData) {
    // Overlay
    const overlay = document.createElement("div");
    overlay.className = "snap-diff-overlay";

    // Modal
    const modal = document.createElement("div");
    modal.className = "snap-diff-modal";

    // Header
    const hdr = document.createElement("div");
    hdr.className = "snap-diff-header";
    const hdrTitle = document.createElement("span");
    hdrTitle.textContent = `${baseLabel} \u2192 ${targetLabel}`;
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u2715";
    closeBtn.addEventListener("click", dismiss);
    hdr.appendChild(hdrTitle);
    hdr.appendChild(closeBtn);

    // Summary pills
    const { summary } = diff;
    const summaryBar = document.createElement("div");
    summaryBar.className = "snap-diff-summary";
    const pills = [
        { count: summary.nodesAdded, label: "added", color: "#22c55e" },
        { count: summary.nodesRemoved, label: "removed", color: "#dc2626" },
        { count: summary.nodesModified, label: "modified", color: "#f59e0b" },
        { count: summary.linksAdded, label: "links +", color: "#3b82f6" },
        { count: summary.linksRemoved, label: "links \u2212", color: "#3b82f6" },
    ];
    for (const p of pills) {
        if (p.count === 0) continue;
        const pill = document.createElement("span");
        pill.style.cssText = `background:${p.color}; color:#fff; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600;`;
        pill.textContent = `${p.count} ${p.label}`;
        summaryBar.appendChild(pill);
    }

    // Body (scrollable)
    const body = document.createElement("div");
    body.className = "snap-diff-body";

    const totalChanges = summary.nodesAdded + summary.nodesRemoved + summary.nodesModified + summary.linksAdded + summary.linksRemoved;

    if (totalChanges === 0) {
        const emptyMsg = document.createElement("div");
        emptyMsg.className = "snap-diff-empty";
        emptyMsg.textContent = "No differences found.";
        body.appendChild(emptyMsg);
    } else {
        // Helper: collapsible section
        function makeSection(title, count, entries, renderEntry) {
            if (count === 0) return null;
            const section = document.createElement("div");
            section.className = "snap-diff-section";
            const sectionHdr = document.createElement("div");
            sectionHdr.className = "snap-diff-section-header";
            const arrow = document.createElement("span");
            arrow.className = "snap-diff-section-arrow";
            arrow.textContent = "\u25BC";
            const sectionTitle = document.createElement("span");
            sectionTitle.textContent = `${title} (${count})`;
            sectionHdr.appendChild(arrow);
            sectionHdr.appendChild(sectionTitle);
            const sectionBody = document.createElement("div");
            sectionBody.className = "snap-diff-section-body";
            for (const entry of entries) {
                sectionBody.appendChild(renderEntry(entry));
            }
            let collapsed = false;
            sectionHdr.addEventListener("click", () => {
                collapsed = !collapsed;
                sectionBody.style.display = collapsed ? "none" : "";
                arrow.textContent = collapsed ? "\u25B6" : "\u25BC";
            });
            section.appendChild(sectionHdr);
            section.appendChild(sectionBody);
            return section;
        }

        function nodeEntry(n, colorClass) {
            const el = document.createElement("div");
            el.className = `snap-diff-node-entry ${colorClass}`;
            el.textContent = `${n.title} (${n.type}) #${n.id}`;
            return el;
        }

        // Added Nodes
        const addedSec = makeSection("Added Nodes", diff.addedNodes.length, diff.addedNodes, (n) => nodeEntry(n, "snap-diff-added"));
        if (addedSec) body.appendChild(addedSec);

        // Removed Nodes
        const removedSec = makeSection("Removed Nodes", diff.removedNodes.length, diff.removedNodes, (n) => nodeEntry(n, "snap-diff-removed"));
        if (removedSec) body.appendChild(removedSec);

        // Modified Nodes
        const modSec = makeSection("Modified Nodes", diff.modifiedNodes.length, diff.modifiedNodes, (n) => {
            const wrap = document.createElement("div");
            wrap.className = "snap-diff-node-entry snap-diff-neutral";
            const header = document.createElement("div");
            header.textContent = `${n.title} (${n.type}) #${n.id}`;
            wrap.appendChild(header);

            const { changes } = n;
            if (changes.position) {
                const d = document.createElement("div");
                d.className = "snap-diff-change-detail";
                const from = changes.position.from || [0, 0];
                const to = changes.position.to || [0, 0];
                d.appendChild(makeValueChange("Position", `[${Math.round(from[0])}, ${Math.round(from[1])}]`, `[${Math.round(to[0])}, ${Math.round(to[1])}]`));
                wrap.appendChild(d);
            }
            if (changes.size) {
                const d = document.createElement("div");
                d.className = "snap-diff-change-detail";
                const from = changes.size.from || [0, 0];
                const to = changes.size.to || [0, 0];
                d.appendChild(makeValueChange("Size", `[${Math.round(from[0])}, ${Math.round(from[1])}]`, `[${Math.round(to[0])}, ${Math.round(to[1])}]`));
                wrap.appendChild(d);
            }
            if (changes.title) {
                const d = document.createElement("div");
                d.className = "snap-diff-change-detail";
                d.appendChild(makeValueChange("Title", changes.title.from, changes.title.to));
                wrap.appendChild(d);
            }
            if (changes.mode) {
                const d = document.createElement("div");
                d.className = "snap-diff-change-detail";
                d.appendChild(makeValueChange("Mode", String(changes.mode.from), String(changes.mode.to)));
                wrap.appendChild(d);
            }
            if (changes.widgetValues) {
                if (Array.isArray(changes.widgetValues)) {
                    for (const wv of changes.widgetValues) {
                        const d = document.createElement("div");
                        d.className = "snap-diff-change-detail";
                        d.appendChild(makeValueChange(`Value[${wv.index}]`, wv.from, wv.to));
                        wrap.appendChild(d);
                    }
                } else {
                    const d = document.createElement("div");
                    d.className = "snap-diff-change-detail";
                    d.appendChild(makeValueChange("Widget values", JSON.stringify(changes.widgetValues.from), JSON.stringify(changes.widgetValues.to)));
                    wrap.appendChild(d);
                }
            }
            if (changes.properties) {
                for (const pv of changes.properties) {
                    const d = document.createElement("div");
                    d.className = "snap-diff-change-detail";
                    d.appendChild(makeValueChange(`prop.${pv.key}`, pv.from, pv.to));
                    wrap.appendChild(d);
                }
            }
            return wrap;
        });
        if (modSec) body.appendChild(modSec);

        // Link changes (combined section)
        const allLinkChanges = [
            ...diff.addedLinks.map(l => ({ ...l, action: "added" })),
            ...diff.removedLinks.map(l => ({ ...l, action: "removed" })),
        ];
        const linkSec = makeSection("Link Changes", allLinkChanges.length, allLinkChanges, (l) => {
            const el = document.createElement("div");
            el.className = `snap-diff-link-entry ${l.action === "added" ? "snap-diff-added" : "snap-diff-removed"}`;
            const srcInfo = allNodes.get(l.srcNodeId) || { title: `#${l.srcNodeId}` };
            const destInfo = allNodes.get(l.destNodeId) || { title: `#${l.destNodeId}` };
            const prefix = l.action === "added" ? "+" : "\u2212";
            el.textContent = `${prefix} ${srcInfo.title} [${l.srcSlot}] \u2192 ${destInfo.title} [${l.destSlot}]${l.type ? ` (${l.type})` : ""}`;
            return el;
        });
        if (linkSec) body.appendChild(linkSec);
    }

    function makeValueChange(label, oldVal, newVal) {
        const span = document.createElement("span");
        const lbl = document.createElement("span");
        lbl.textContent = `${label}: `;
        const oldSpan = document.createElement("span");
        oldSpan.className = "snap-diff-val-old";
        oldSpan.textContent = truncateVal(oldVal);
        const arrow = document.createElement("span");
        arrow.textContent = " \u2192 ";
        const newSpan = document.createElement("span");
        newSpan.className = "snap-diff-val-new";
        newSpan.textContent = truncateVal(newVal);
        span.appendChild(lbl);
        span.appendChild(oldSpan);
        span.appendChild(arrow);
        span.appendChild(newSpan);
        return span;
    }

    function truncateVal(v) {
        const s = String(v ?? "");
        return s.length > 80 ? s.slice(0, 77) + "\u2026" : s;
    }

    // SVG comparison panel
    let svgCompare = null;
    if (baseGraphData && targetGraphData) {
        const highlightNodesBase = new Map();
        for (const n of diff.removedNodes) highlightNodesBase.set(n.id, "removed");
        for (const n of diff.modifiedNodes) highlightNodesBase.set(n.id, "modified");

        const highlightNodesTarget = new Map();
        for (const n of diff.addedNodes) highlightNodesTarget.set(n.id, "added");
        for (const n of diff.modifiedNodes) highlightNodesTarget.set(n.id, "modified");

        const svgOpts = { width: 330, height: 220, showLabels: true, showLinks: true, showSlots: false, showGroups: true };
        const baseSvg = renderGraphSVG(baseGraphData, { ...svgOpts, highlightNodes: highlightNodesBase });
        const targetSvg = renderGraphSVG(targetGraphData, { ...svgOpts, highlightNodes: highlightNodesTarget });

        if (baseSvg || targetSvg) {
            svgCompare = document.createElement("div");
            svgCompare.className = "snap-diff-svg-compare";

            const basePanel = document.createElement("div");
            basePanel.className = "snap-diff-svg-panel";
            const baseLbl = document.createElement("div");
            baseLbl.className = "snap-diff-svg-panel-label";
            baseLbl.textContent = "Base";
            basePanel.appendChild(baseLbl);
            if (baseSvg) basePanel.appendChild(baseSvg);

            const targetPanel = document.createElement("div");
            targetPanel.className = "snap-diff-svg-panel";
            const targetLbl = document.createElement("div");
            targetLbl.className = "snap-diff-svg-panel-label";
            targetLbl.textContent = "Target";
            targetPanel.appendChild(targetLbl);
            if (targetSvg) targetPanel.appendChild(targetSvg);

            svgCompare.appendChild(basePanel);
            svgCompare.appendChild(targetPanel);
        }
    }

    modal.appendChild(hdr);
    modal.appendChild(summaryBar);
    if (svgCompare) modal.appendChild(svgCompare);
    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function dismiss() {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
    }

    function onKey(e) {
        if (e.key === "Escape") dismiss();
    }
    document.addEventListener("keydown", onKey);

    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) dismiss();
    });
}

// ─── Preview Modal ──────────────────────────────────────────────────

async function showPreviewModal(record) {
    if (!record.graphData) {
        const full = await db_getFullRecord(record.workflowKey, record.id);
        if (!full) { showToast("Failed to load snapshot data", "error"); return; }
        record = full;
    }

    const overlay = document.createElement("div");
    overlay.className = "snap-preview-overlay";

    const modal = document.createElement("div");
    modal.className = "snap-preview-modal";

    const hdr = document.createElement("div");
    hdr.className = "snap-preview-header";
    const hdrTitle = document.createElement("span");
    hdrTitle.textContent = `${record.label} \u2014 ${formatTime(record.timestamp)}`;
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u2715";
    closeBtn.addEventListener("click", dismiss);
    hdr.appendChild(hdrTitle);
    hdr.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "snap-preview-body";

    const svg = renderGraphSVG(record.graphData, {
        width: 860, height: 600,
        showLabels: true, showLinks: true, showSlots: true, showGroups: true,
    });
    if (svg) {
        body.appendChild(svg);
    } else {
        const fallback = document.createElement("div");
        fallback.style.cssText = "color: #666; font-size: 13px; padding: 32px;";
        fallback.textContent = "Unable to render preview";
        body.appendChild(fallback);
    }

    modal.appendChild(hdr);
    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function dismiss() {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
    }

    function onKey(e) {
        if (e.key === "Escape") dismiss();
    }
    document.addEventListener("keydown", onKey);

    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) dismiss();
    });
}

// ─── Snapshot Capture ────────────────────────────────────────────────

async function captureSnapshot(label = "Auto") {
    if (restoreLock) return false;

    const graphData = getGraphData();
    if (!graphData) return false;

    const nodes = graphData.nodes || [];
    if (nodes.length === 0) return false;

    const workflowKey = getWorkflowKey();
    const serialized = JSON.stringify(graphData);
    const hash = quickHash(serialized);
    if (hash === lastCapturedHashMap.get(workflowKey)) return false;

    const prevGraph = lastGraphDataMap.get(workflowKey);
    const changeType = detectChangeType(prevGraph, graphData);

    // Determine parentId for branching
    let parentId = null;
    if (branchingEnabled) {
        if (activeSnapshotId) {
            parentId = activeSnapshotId; // fork from swapped snapshot
        } else if (lastCapturedIdMap.has(workflowKey)) {
            parentId = lastCapturedIdMap.get(workflowKey); // continuation
        }
    }

    const record = {
        id: generateId(),
        workflowKey,
        timestamp: Date.now(),
        label,
        nodeCount: nodes.length,
        graphData,
        locked: false,
        changeType,
        parentId,
    };

    try {
        await db_put(record);
        if (branchingEnabled) {
            // Compute protected IDs: ancestors of this capture + fork points
            const allRecs = await db_getAllForWorkflow(workflowKey);
            const tempTree = buildSnapshotTree(allRecs);
            const ancestors = getAncestorIds(record.id, tempTree.parentOf);
            // Protect fork points (snapshots with >1 child)
            for (const [pid, children] of tempTree.childrenOf) {
                if (children.length > 1) ancestors.add(pid);
            }
            ancestors.add(record.id); // protect the just-captured snapshot
            await pruneSnapshots(workflowKey, [...ancestors]);
        } else {
            await pruneSnapshots(workflowKey);
        }
    } catch {
        return false;
    }

    lastCapturedHashMap.set(workflowKey, hash);
    lastGraphDataMap.set(workflowKey, graphData);
    lastCapturedIdMap.set(workflowKey, record.id);
    pickerDirty = true;
    currentSnapshotId = null;  // new capture supersedes "current" bookmark
    activeSnapshotId = null;   // graph has changed, no snapshot is "active"

    if (sidebarRefresh) {
        sidebarRefresh().catch(() => {});
    }
    if (timelineRefresh) {
        timelineRefresh().catch(() => {});
    }
    return record.id;
}

async function captureNodeSnapshot(label = "Node Trigger") {
    if (restoreLock) return false;

    const graphData = getGraphData();
    if (!graphData) return false;

    const nodes = graphData.nodes || [];
    if (nodes.length === 0) return false;

    const workflowKey = getWorkflowKey();
    const prevGraph = lastGraphDataMap.get(workflowKey);
    const changeType = detectChangeType(prevGraph, graphData);

    // Determine parentId for branching
    let parentId = null;
    if (branchingEnabled) {
        if (activeSnapshotId) {
            parentId = activeSnapshotId;
        } else if (lastCapturedIdMap.has(workflowKey)) {
            parentId = lastCapturedIdMap.get(workflowKey);
        }
    }

    const record = {
        id: generateId(),
        workflowKey,
        timestamp: Date.now(),
        label,
        nodeCount: nodes.length,
        graphData,
        locked: false,
        source: "node",
        changeType,
        parentId,
    };

    try {
        await db_put(record);
        if (branchingEnabled) {
            // Compute protected IDs: ancestors + fork points
            const allRecs = await db_getAllForWorkflow(workflowKey);
            const tempTree = buildSnapshotTree(allRecs);
            const protectedNodeIds = getAncestorIds(record.id, tempTree.parentOf);
            for (const [pid, children] of tempTree.childrenOf) {
                if (children.length > 1) protectedNodeIds.add(pid);
            }
            protectedNodeIds.add(record.id);
            await pruneNodeSnapshots(workflowKey, [...protectedNodeIds]);
        } else {
            await pruneNodeSnapshots(workflowKey);
        }
    } catch {
        return false;
    }

    lastGraphDataMap.set(workflowKey, graphData);
    lastCapturedIdMap.set(workflowKey, record.id);
    pickerDirty = true;
    currentSnapshotId = null;
    activeSnapshotId = null;

    if (sidebarRefresh) {
        sidebarRefresh().catch(() => {});
    }
    if (timelineRefresh) {
        timelineRefresh().catch(() => {});
    }
    return true;
}

function scheduleCaptureSnapshot() {
    if (!autoCaptureEnabled) return;
    if (restoreLock) return;
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = setTimeout(() => {
        captureTimer = null;
        captureSnapshot("Auto").catch((err) => {
            console.warn(`[${EXTENSION_NAME}] Auto-capture failed:`, err);
        });
    }, debounceMs);
}

// ─── Restore ─────────────────────────────────────────────────────────

async function restoreSnapshot(record) {
    if (!record.graphData) {
        const full = await db_getFullRecord(record.workflowKey, record.id);
        if (!full) { showToast("Failed to load snapshot data", "error"); return; }
        record = full;
    }
    await withRestoreLock(async () => {
        if (!validateSnapshotData(record.graphData)) {
            showToast("Invalid snapshot data", "error");
            return;
        }
        try {
            await app.loadGraphData(record.graphData, true, true);
            lastCapturedHashMap.set(getWorkflowKey(), quickHash(JSON.stringify(record.graphData)));
            lastGraphDataMap.set(getWorkflowKey(), record.graphData);
            showToast("Snapshot restored", "success");
        } catch (err) {
            console.warn(`[${EXTENSION_NAME}] Restore failed:`, err);
            showToast("Failed to restore snapshot", "error");
        }
    });
}

async function swapSnapshot(record) {
    // Warn when swapping in a snapshot from a different workflow
    const currentKey = getWorkflowKey();
    if (record.workflowKey && record.workflowKey !== currentKey) {
        const confirmed = await showConfirmDialog(
            `This snapshot belongs to a different workflow ("${record.workflowKey}").\nSwap it into the current workflow anyway?`
        );
        if (!confirmed) return;
    }

    // Auto-save current state before swapping (so user can get back),
    // but skip if the graph is already a saved snapshot (browsing between old ones)
    const prevCurrentId = currentSnapshotId;
    if (!activeSnapshotId) {
        const capturedId = await captureSnapshot("Current");
        currentSnapshotId = capturedId || prevCurrentId;
    }

    if (!record.graphData) {
        const full = await db_getFullRecord(record.workflowKey, record.id);
        if (!full) { showToast("Failed to load snapshot data", "error"); return; }
        record = full;
    }

    await withRestoreLock(async () => {
        if (!validateSnapshotData(record.graphData)) {
            showToast("Invalid snapshot data", "error");
            return;
        }
        try {
            const workflow = app.extensionManager?.workflow?.activeWorkflow;
            await app.loadGraphData(record.graphData, true, true, workflow);
            lastCapturedHashMap.set(getWorkflowKey(), quickHash(JSON.stringify(record.graphData)));
            lastGraphDataMap.set(getWorkflowKey(), record.graphData);
            activeSnapshotId = record.id;
            showToast("Snapshot swapped", "success");
        } catch (err) {
            console.warn(`[${EXTENSION_NAME}] Swap failed:`, err);
            showToast("Failed to swap snapshot", "error");
        }
    });
}

// ─── Sidebar UI ──────────────────────────────────────────────────────

const CSS = `
.snap-sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    color: var(--input-text, #ccc);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
}
.snap-header {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border-color, #444);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}
.snap-header button {
    padding: 5px 10px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    background: #3b82f6;
    color: #fff;
    white-space: nowrap;
}
.snap-header button:hover {
    background: #2563eb;
}
.snap-header button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.snap-header .snap-count {
    margin-left: auto;
    font-size: 11px;
    color: var(--descrip-text, #888);
    white-space: nowrap;
}
.snap-search {
    padding: 6px 10px;
    border-bottom: 1px solid var(--border-color, #444);
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
}
.snap-search input {
    flex: 1;
    padding: 4px 8px;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    background: var(--comfy-menu-bg, #2a2a2a);
    color: var(--input-text, #ccc);
    font-size: 12px;
    outline: none;
}
.snap-search input::placeholder {
    color: var(--descrip-text, #888);
}
.snap-search-clear {
    background: none;
    border: none;
    color: var(--descrip-text, #888);
    cursor: pointer;
    font-size: 14px;
    padding: 2px 4px;
    line-height: 1;
    visibility: hidden;
}
.snap-search-clear.visible {
    visibility: visible;
}
.snap-filter-auto-btn {
    background: none;
    border: 1px solid var(--border-color, #555);
    color: var(--descrip-text, #888);
    cursor: pointer;
    font-size: 10px;
    font-weight: 600;
    padding: 3px 6px;
    border-radius: 4px;
    white-space: nowrap;
    line-height: 1;
    flex-shrink: 0;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
}
.snap-filter-auto-btn:hover {
    border-color: var(--descrip-text, #888);
    color: var(--input-text, #ccc);
}
.snap-filter-auto-btn.active {
    background: rgba(59, 130, 246, 0.15);
    border-color: #3b82f6;
    color: #3b82f6;
}
.snap-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
}
.snap-item {
    display: flex;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border-color, #333);
    gap: 8px;
}
.snap-item:hover {
    background: var(--comfy-menu-bg, #2a2a2a);
}
.snap-item-info {
    flex: 1;
    min-width: 0;
}
.snap-item-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--input-text, #ddd);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.snap-item-time {
    font-size: 12px;
    color: var(--input-text, #ddd);
}
.snap-item-date {
    font-size: 10px;
    color: var(--descrip-text, #777);
}
.snap-item-meta {
    font-size: 10px;
    color: var(--descrip-text, #666);
}
.snap-item-label-input {
    width: 100%;
    padding: 2px 6px;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    background: var(--comfy-menu-bg, #2a2a2a);
    color: var(--input-text, #ccc);
    font-size: 13px;
    font-weight: 600;
    outline: none;
    box-sizing: border-box;
}
.snap-btn-note {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 13px;
    padding: 3px 4px;
    color: var(--descrip-text, #888);
    opacity: 0.5;
    transition: opacity 0.15s, color 0.15s;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.snap-btn-note:hover {
    opacity: 1;
}
.snap-btn-note.has-note {
    opacity: 1;
    color: #f59e0b;
}
.snap-item-notes {
    font-size: 10px;
    font-style: italic;
    color: var(--descrip-text, #888);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
}
.snap-item-notes-input {
    width: 100%;
    padding: 4px 6px;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    background: var(--comfy-menu-bg, #2a2a2a);
    color: var(--input-text, #ccc);
    font-size: 11px;
    outline: none;
    resize: vertical;
    min-height: 32px;
    max-height: 80px;
    box-sizing: border-box;
    font-family: inherit;
}
.snap-item-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
}
.snap-item-actions button {
    padding: 3px 8px;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
}
.snap-item-actions button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}
.snap-btn-swap {
    background: #f59e0b;
    color: #fff;
}
.snap-btn-swap:hover:not(:disabled) {
    background: #d97706;
}
.snap-btn-restore {
    background: #22c55e;
    color: #fff;
}
.snap-btn-restore:hover:not(:disabled) {
    background: #16a34a;
}
.snap-btn-lock {
    background: var(--comfy-menu-bg, #444);
    color: var(--descrip-text, #aaa);
    font-size: 13px;
    min-width: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.snap-btn-lock.snap-btn-locked {
    background: #2563eb;
    color: #fff;
}
.snap-btn-delete {
    background: var(--comfy-menu-bg, #444);
    color: var(--descrip-text, #aaa);
}
.snap-btn-delete:hover:not(:disabled) {
    background: #dc2626;
    color: #fff;
}
.snap-footer {
    padding: 8px 10px;
    border-top: 1px solid var(--border-color, #444);
    flex-shrink: 0;
}
.snap-footer button {
    width: 100%;
    padding: 5px 10px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    background: var(--comfy-menu-bg, #555);
    color: var(--input-text, #ccc);
}
.snap-footer button:hover {
    background: #dc2626;
    color: #fff;
}
.snap-item-node {
    border-left: 3px solid #6d28d9;
}
.snap-item-active {
    background: rgba(255,255,255,0.06);
    border-left: 3px solid #fff;
}
.snap-item-current {
    background: rgba(16,185,129,0.06);
    border-left: 3px solid #10b981;
}
.snap-node-badge {
    display: inline-block;
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
    background: #6d28d9;
    color: #fff;
    margin-left: 6px;
    vertical-align: middle;
    font-weight: 500;
}
.snap-empty {
    padding: 20px;
    text-align: center;
    color: var(--descrip-text, #666);
    font-size: 12px;
}
.snap-workflow-selector {
    padding: 6px 10px;
    border-bottom: 1px solid var(--border-color, #444);
    display: flex;
    align-items: center;
    cursor: pointer;
    gap: 4px;
    flex-shrink: 0;
    user-select: none;
}
.snap-workflow-selector:hover {
    background: var(--comfy-menu-bg, #2a2a2a);
}
.snap-workflow-selector.snap-viewing-other {
    border-left: 3px solid #f59e0b;
    padding-left: 7px;
}
.snap-workflow-selector-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--descrip-text, #888);
}
.snap-workflow-selector-arrow {
    font-size: 10px;
    color: var(--descrip-text, #888);
    flex-shrink: 0;
    transition: transform 0.15s;
}
.snap-workflow-selector-arrow.expanded {
    transform: rotate(180deg);
}
.snap-workflow-list {
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.15s ease-out;
}
.snap-workflow-list.expanded {
    max-height: 200px;
    overflow-y: auto;
    border-bottom: 1px solid var(--border-color, #444);
}
.snap-workflow-item {
    padding: 4px 10px 4px 18px;
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--input-text, #ccc);
}
.snap-workflow-item:hover {
    background: var(--comfy-menu-bg, #2a2a2a);
}
.snap-workflow-item.active {
    font-weight: 700;
    color: #3b82f6;
}
.snap-workflow-item-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.snap-workflow-item-count {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--descrip-text, #888);
}
.snap-workflow-viewing-banner {
    padding: 5px 10px;
    border-bottom: 1px solid var(--border-color, #444);
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(245, 158, 11, 0.1);
    font-size: 11px;
    flex-shrink: 0;
}
.snap-workflow-viewing-banner span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #f59e0b;
}
.snap-workflow-viewing-banner button {
    padding: 2px 8px;
    border: 1px solid #f59e0b;
    border-radius: 3px;
    background: transparent;
    color: #f59e0b;
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
}
.snap-workflow-viewing-banner button:hover {
    background: rgba(245, 158, 11, 0.2);
}
.snap-timeline {
    position: absolute;
    bottom: 4px;
    left: 10%;
    right: 10%;
    height: 38px;
    background: rgba(15, 23, 42, 0.85);
    border: 1px solid var(--border-color, #334155);
    border-radius: 8px;
    display: flex;
    align-items: center;
    padding: 0 16px;
    z-index: 9;
    pointer-events: auto;
}
.snap-timeline-track {
    flex: 1;
    height: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
}
.snap-timeline-marker {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    cursor: pointer;
    transition: transform 0.1s, box-shadow 0.1s;
    border: 2px solid transparent;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--snap-marker-color, #3b82f6);
}
.snap-timeline-marker svg {
    display: block;
    color: #fff;
    pointer-events: none;
}
.snap-timeline-marker:hover {
    transform: scale(1.4);
    box-shadow: 0 0 8px var(--snap-marker-color, rgba(59,130,246,0.6));
}
.snap-timeline-marker-node {
    background: #6d28d9;
}
.snap-timeline-marker-node:hover {
    box-shadow: 0 0 6px rgba(109, 40, 217, 0.6);
}
.snap-timeline-marker-locked {
    border-color: #facc15;
}
.snap-timeline-marker-active {
    border-color: #fff;
    transform: scale(1.3);
}
.snap-timeline-marker-active:hover {
    transform: scale(1.5);
}
.snap-timeline-marker-current {
    background: #10b981;
}
.snap-timeline-marker-current:hover {
    box-shadow: 0 0 6px rgba(16, 185, 129, 0.6);
}
.snap-timeline-snap-btn {
    background: none;
    border: 1px solid var(--descrip-text, #64748b);
    color: var(--descrip-text, #94a3b8);
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
    margin-left: 8px;
    white-space: nowrap;
    flex-shrink: 0;
    font-family: system-ui, sans-serif;
}
.snap-timeline-snap-btn:hover {
    border-color: #3b82f6;
    color: #3b82f6;
}
.snap-timeline-empty {
    color: var(--descrip-text, #64748b);
    font-size: 11px;
    font-family: system-ui, sans-serif;
    line-height: 32px;
}
.snap-timeline-fork-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    height: 100%;
}
.snap-timeline-branch-btn {
    background: none;
    border: none;
    color: #3b82f6;
    font-size: 8px;
    cursor: pointer;
    padding: 0;
    margin: 0;
    line-height: 1;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    width: 18px;
    flex: 1;
    border-radius: 2px;
    flex-shrink: 0;
    opacity: 0.7;
    transition: opacity 0.1s, background 0.1s;
}
.snap-timeline-branch-btn:last-child {
    align-items: flex-end;
}
.snap-timeline-branch-btn:hover {
    opacity: 1;
    background: rgba(59, 130, 246, 0.2);
}
.snap-timeline-expand-btn {
    font-size: 13px;
    padding: 2px 6px;
    line-height: 1;
}
.snap-timeline-expanded {
    height: auto;
    align-items: flex-start;
    padding: 8px 16px;
}
.snap-timeline-expanded .snap-timeline-track {
    flex-direction: column;
    gap: 4px;
    height: auto;
    max-height: 180px;
    overflow-y: auto;
    align-items: stretch;
}
.snap-timeline-branch-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 6px;
    border-radius: 4px;
    min-height: 24px;
    border-left: 2px solid transparent;
}
.snap-timeline-branch-row-active {
    background: rgba(59, 130, 246, 0.12);
    border-left-color: #3b82f6;
}
.snap-diff-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
}
.snap-diff-modal {
    width: min(720px, 90vw);
    max-height: 80vh;
    background: #1e1e2e;
    border: 1px solid #444;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    color: #ccc;
}
.snap-diff-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid #444;
    font-weight: 700;
    font-size: 14px;
}
.snap-diff-header button {
    background: none;
    border: none;
    color: #888;
    font-size: 16px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
}
.snap-diff-header button:hover {
    background: #333;
    color: #fff;
}
.snap-diff-summary {
    display: flex;
    gap: 6px;
    padding: 8px 14px;
    flex-wrap: wrap;
    border-bottom: 1px solid #333;
}
.snap-diff-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 14px 14px;
}
.snap-diff-section {
    margin-bottom: 8px;
}
.snap-diff-section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    padding: 6px 4px;
    font-weight: 600;
    font-size: 12px;
    color: #aaa;
    user-select: none;
    border-radius: 4px;
}
.snap-diff-section-header:hover {
    background: #2a2a3a;
}
.snap-diff-section-arrow {
    font-size: 10px;
    width: 14px;
    text-align: center;
}
.snap-diff-section-body {
    padding-left: 20px;
}
.snap-diff-node-entry {
    padding: 4px 6px;
    margin: 2px 0;
    border-radius: 4px;
    font-size: 12px;
}
.snap-diff-node-entry.snap-diff-added {
    color: #22c55e;
    background: rgba(34,197,94,0.08);
}
.snap-diff-node-entry.snap-diff-removed {
    color: #dc2626;
    background: rgba(220,38,38,0.08);
}
.snap-diff-node-entry.snap-diff-neutral {
    color: #f59e0b;
    background: rgba(245,158,11,0.06);
}
.snap-diff-change-detail {
    padding: 2px 0 2px 16px;
    font-size: 11px;
    color: #999;
}
.snap-diff-val-old {
    color: #dc2626;
    text-decoration: line-through;
}
.snap-diff-val-new {
    color: #22c55e;
}
.snap-diff-link-entry {
    padding: 3px 6px;
    margin: 2px 0;
    border-radius: 4px;
    font-size: 12px;
}
.snap-diff-link-entry.snap-diff-added {
    color: #22c55e;
    background: rgba(34,197,94,0.08);
}
.snap-diff-link-entry.snap-diff-removed {
    color: #dc2626;
    background: rgba(220,38,38,0.08);
}
.snap-diff-empty {
    text-align: center;
    padding: 32px 16px;
    color: #666;
    font-size: 13px;
}
.snap-item.snap-diff-base {
    outline: 2px solid #6d28d9;
    outline-offset: -2px;
    border-radius: 4px;
}
.snap-btn-diff {
    background: #6d28d9;
    color: #fff;
}
.snap-btn-diff:hover:not(:disabled) {
    background: #5b21b6;
}
.snap-btn-diff.snap-diff-base-active {
    box-shadow: 0 0 6px rgba(109,40,217,0.6);
}
.snap-preview-tooltip {
    position: fixed;
    z-index: 10001;
    pointer-events: none;
    background: #1e1e2e;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 6px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    opacity: 0;
    transition: opacity 0.15s;
}
.snap-preview-tooltip.visible {
    opacity: 1;
}
.snap-preview-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
}
.snap-preview-modal {
    width: min(900px, 90vw);
    max-height: 90vh;
    background: #1e1e2e;
    border: 1px solid #444;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    color: #ccc;
}
.snap-preview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid #444;
    font-weight: 700;
    font-size: 14px;
}
.snap-preview-header button {
    background: none;
    border: none;
    color: #888;
    font-size: 16px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
}
.snap-preview-header button:hover {
    background: #333;
    color: #fff;
}
.snap-preview-body {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: 16px;
}
.snap-diff-svg-compare {
    display: flex;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid #333;
    justify-content: center;
}
.snap-diff-svg-panel {
    flex: 1;
    text-align: center;
}
.snap-diff-svg-panel-label {
    font-size: 11px;
    font-weight: 600;
    color: #888;
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.snap-btn-preview {
    background: #334155;
    color: #fff;
    font-size: 13px;
    min-width: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.snap-btn-preview:hover:not(:disabled) {
    background: #475569;
}
.snap-branch-nav {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 3px 10px;
    background: rgba(59, 130, 246, 0.08);
    border-bottom: 1px solid var(--border-color, #333);
    user-select: none;
}
.snap-branch-nav button {
    background: none;
    border: 1px solid rgba(59, 130, 246, 0.3);
    color: #3b82f6;
    border-radius: 3px;
    width: 22px;
    height: 20px;
    font-size: 11px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    line-height: 1;
}
.snap-branch-nav button:hover {
    background: rgba(59, 130, 246, 0.15);
    border-color: #3b82f6;
}
.snap-branch-nav-label {
    font-size: 11px;
    color: #3b82f6;
    font-weight: 600;
    min-width: 30px;
    text-align: center;
}
.snap-profiles {
    border-bottom: 1px solid var(--border-color, #444);
    flex-shrink: 0;
}
.snap-profiles-header {
    display: flex;
    align-items: center;
    padding: 6px 10px;
    cursor: pointer;
    gap: 6px;
    user-select: none;
}
.snap-profiles-header:hover {
    background: var(--comfy-menu-bg, #2a2a2a);
}
.snap-profiles-arrow {
    font-size: 10px;
    color: var(--descrip-text, #888);
    flex-shrink: 0;
    transition: transform 0.15s;
}
.snap-profiles-arrow.expanded {
    transform: rotate(90deg);
}
.snap-profiles-title {
    flex: 1;
    font-size: 12px;
    font-weight: 600;
    color: var(--descrip-text, #888);
}
.snap-profiles-save-btn {
    padding: 2px 8px;
    border: 1px solid #3b82f6;
    border-radius: 3px;
    background: transparent;
    color: #3b82f6;
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
}
.snap-profiles-save-btn:hover {
    background: rgba(59, 130, 246, 0.15);
}
.snap-profiles-body {
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.15s ease-out;
}
.snap-profiles-body.expanded {
    max-height: 200px;
    overflow-y: auto;
}
.snap-profile-item {
    display: flex;
    align-items: center;
    padding: 4px 10px 4px 18px;
    gap: 6px;
    font-size: 12px;
}
.snap-profile-item:hover {
    background: var(--comfy-menu-bg, #2a2a2a);
}
.snap-profile-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--input-text, #ccc);
}
.snap-profile-count {
    font-size: 10px;
    color: var(--descrip-text, #888);
    flex-shrink: 0;
}
.snap-profile-load-btn {
    padding: 2px 8px;
    border: none;
    border-radius: 3px;
    background: #22c55e;
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
}
.snap-profile-load-btn:hover {
    background: #16a34a;
}
.snap-profile-delete-btn {
    background: none;
    border: none;
    color: var(--descrip-text, #888);
    cursor: pointer;
    font-size: 12px;
    padding: 2px 4px;
    flex-shrink: 0;
}
.snap-profile-delete-btn:hover {
    color: #dc2626;
}
.snap-profiles-empty {
    padding: 6px 18px;
    font-size: 11px;
    color: var(--descrip-text, #888);
}
`;

const CHANGE_TYPE_ICONS = {
    initial: {
        svg: '<svg width="10" height="10" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="currentColor"/></svg>',
        color: "#3b82f6",
        label: "Initial snapshot",
    },
    node_add: {
        svg: '<svg width="10" height="10" viewBox="0 0 12 12"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        color: "#22c55e",
        label: "Nodes added",
    },
    node_remove: {
        svg: '<svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 6h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        color: "#ef4444",
        label: "Nodes removed",
    },
    connection: {
        svg: '<svg width="10" height="10" viewBox="0 0 12 12"><path d="M1 9L4 3L8 9L11 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
        color: "#f59e0b",
        label: "Connections changed",
    },
    param: {
        svg: '<svg width="10" height="10" viewBox="0 0 12 12"><path d="M0 6Q3 2 6 6Q9 10 12 6" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
        color: "#a78bfa",
        label: "Parameters changed",
    },
    move: {
        svg: '<svg width="10" height="10" viewBox="0 0 12 12"><path d="M6 1L3 4h6L6 1ZM6 11L3 8h6L6 11Z" fill="currentColor"/></svg>',
        color: "#64748b",
        label: "Nodes repositioned",
    },
    mixed: {
        svg: '<svg width="10" height="10" viewBox="0 0 12 12"><path d="M6 1L7.5 4.5H11L8.25 6.75L9.5 10.5L6 8L2.5 10.5L3.75 6.75L1 4.5H4.5Z" fill="currentColor"/></svg>',
        color: "#f97316",
        label: "Multiple changes",
    },
    unknown: {
        svg: '<svg width="10" height="10" viewBox="0 0 12 12"><circle cx="6" cy="6" r="3" fill="currentColor" opacity="0.5"/></svg>',
        color: "#6b7280",
        label: "Unknown change",
    },
};

function injectStyles() {
    if (document.getElementById("snapshot-manager-styles")) return;
    const style = document.createElement("style");
    style.id = "snapshot-manager-styles";
    style.textContent = CSS;
    document.head.appendChild(style);
}

function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function buildBranchNavigator(forkPointId, children, selectedIndex, refreshFn) {
    const nav = document.createElement("div");
    nav.className = "snap-branch-nav";

    const leftBtn = document.createElement("button");
    leftBtn.textContent = "\u25C0";
    leftBtn.title = "Previous branch";
    leftBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const newIndex = Math.max(0, selectedIndex - 1);
        activeBranchSelections.set(forkPointId, newIndex);
        refreshFn();
        if (timelineRefresh) timelineRefresh().catch(() => {});
    });
    if (selectedIndex <= 0) leftBtn.style.visibility = "hidden";

    const label = document.createElement("span");
    label.className = "snap-branch-nav-label";
    label.textContent = `${selectedIndex + 1}/${children.length}`;

    const rightBtn = document.createElement("button");
    rightBtn.textContent = "\u25B6";
    rightBtn.title = "Next branch";
    rightBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const newIndex = Math.min(children.length - 1, selectedIndex + 1);
        activeBranchSelections.set(forkPointId, newIndex);
        refreshFn();
        if (timelineRefresh) timelineRefresh().catch(() => {});
    });
    if (selectedIndex >= children.length - 1) rightBtn.style.visibility = "hidden";

    nav.appendChild(leftBtn);
    nav.appendChild(label);
    nav.appendChild(rightBtn);
    return nav;
}

async function buildSidebar(el) {
    injectStyles();
    // Clean up previous tooltip if sidebar is being rebuilt
    if (sidebarTooltipEl) {
        sidebarTooltipEl.remove();
        sidebarTooltipEl = null;
    }
    el.innerHTML = "";

    const container = document.createElement("div");
    container.className = "snap-sidebar";

    // Shared hover tooltip
    const tooltip = document.createElement("div");
    tooltip.className = "snap-preview-tooltip";
    document.body.appendChild(tooltip);
    let tooltipTimer = null;

    // Header
    const header = document.createElement("div");
    header.className = "snap-header";

    const takeBtn = document.createElement("button");
    takeBtn.textContent = "Take Snapshot";
    takeBtn.addEventListener("click", async () => {
        let name = await showPromptDialog("Enter a name for this snapshot:", "Manual");
        if (name == null) return; // cancelled (null or undefined)
        name = name.trim() || "Manual";
        takeBtn.disabled = true;
        takeBtn.textContent = "Saving...";
        try {
            const saved = await captureSnapshot(name);
            if (saved) showToast("Snapshot saved", "success");
        } finally {
            const isViewingOther = viewingWorkflowKey != null && viewingWorkflowKey !== getWorkflowKey();
            takeBtn.disabled = isViewingOther;
            takeBtn.textContent = "Take Snapshot";
        }
    });

    const countSpan = document.createElement("span");
    countSpan.className = "snap-count";

    header.appendChild(takeBtn);
    header.appendChild(countSpan);

    // Search
    const searchRow = document.createElement("div");
    searchRow.className = "snap-search";

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Filter snapshots...";

    const searchClear = document.createElement("button");
    searchClear.className = "snap-search-clear";
    searchClear.textContent = "\u2715";
    searchClear.addEventListener("click", () => {
        searchInput.value = "";
        searchClear.classList.remove("visible");
        filterItems("");
    });

    searchInput.addEventListener("input", () => {
        const term = searchInput.value;
        searchClear.classList.toggle("visible", term.length > 0);
        filterItems(term.toLowerCase());
    });

    let hideAutoSaves = false;

    const autoFilterBtn = document.createElement("button");
    autoFilterBtn.className = "snap-filter-auto-btn";
    autoFilterBtn.textContent = "Hide Auto";
    autoFilterBtn.title = "Hide auto-save snapshots";
    autoFilterBtn.addEventListener("click", () => {
        hideAutoSaves = !hideAutoSaves;
        autoFilterBtn.classList.toggle("active", hideAutoSaves);
        autoFilterBtn.textContent = hideAutoSaves ? "Show Auto" : "Hide Auto";
        filterItems(searchInput.value.toLowerCase());
    });

    const branchToggleBtn = document.createElement("button");
    branchToggleBtn.className = "snap-filter-auto-btn active";
    branchToggleBtn.textContent = "Branch";
    branchToggleBtn.title = "Toggle snapshot branching";
    branchToggleBtn.addEventListener("click", async () => {
        branchingEnabled = !branchingEnabled;
        branchToggleBtn.classList.toggle("active", branchingEnabled);
        activeBranchSelections.clear();
        if (sidebarRefresh) await sidebarRefresh().catch(() => {});
        if (timelineRefresh) await timelineRefresh().catch(() => {});
    });

    searchRow.appendChild(searchInput);
    searchRow.appendChild(searchClear);
    searchRow.appendChild(autoFilterBtn);
    searchRow.appendChild(branchToggleBtn);

    // Workflow selector
    const selectorRow = document.createElement("div");
    selectorRow.className = "snap-workflow-selector";

    const selectorLabel = document.createElement("span");
    selectorLabel.className = "snap-workflow-selector-label";
    selectorLabel.textContent = getWorkflowKey();

    const selectorArrow = document.createElement("span");
    selectorArrow.className = "snap-workflow-selector-arrow";
    selectorArrow.textContent = "\u25BC";

    selectorRow.appendChild(selectorLabel);
    selectorRow.appendChild(selectorArrow);

    // Workflow picker list (expandable)
    const pickerList = document.createElement("div");
    pickerList.className = "snap-workflow-list";
    let pickerExpanded = false;

    async function populatePicker() {
        pickerList.innerHTML = "";
        const keys = await db_getAllWorkflowKeys();
        const effectiveKey = getEffectiveWorkflowKey();
        const currentKey = getWorkflowKey();

        if (keys.length === 0) {
            const empty = document.createElement("div");
            empty.style.cssText = "padding: 6px 18px; font-size: 11px; color: var(--descrip-text, #888);";
            empty.textContent = "No workflows found";
            pickerList.appendChild(empty);
            return;
        }

        for (const entry of keys) {
            const row = document.createElement("div");
            row.className = "snap-workflow-item";
            if (entry.workflowKey === effectiveKey) row.classList.add("active");

            const nameSpan = document.createElement("span");
            nameSpan.className = "snap-workflow-item-name";
            nameSpan.textContent = entry.workflowKey;

            const countSpanItem = document.createElement("span");
            countSpanItem.className = "snap-workflow-item-count";
            countSpanItem.textContent = `(${entry.count})`;

            row.appendChild(nameSpan);
            row.appendChild(countSpanItem);

            row.addEventListener("click", async () => {
                if (entry.workflowKey === currentKey) {
                    viewingWorkflowKey = null;
                } else {
                    viewingWorkflowKey = entry.workflowKey;
                }
                activeBranchSelections.clear();
                collapsePicker();
                await refresh(true);
            });

            pickerList.appendChild(row);
        }
        pickerDirty = false;
    }

    function collapsePicker() {
        pickerExpanded = false;
        pickerList.classList.remove("expanded");
        selectorArrow.classList.remove("expanded");
    }

    selectorRow.addEventListener("click", async () => {
        pickerExpanded = !pickerExpanded;
        if (pickerExpanded) {
            if (pickerDirty) await populatePicker();
            pickerList.classList.add("expanded");
            selectorArrow.classList.add("expanded");
        } else {
            collapsePicker();
        }
    });

    // Viewing-other-workflow banner
    const viewingBanner = document.createElement("div");
    viewingBanner.className = "snap-workflow-viewing-banner";
    viewingBanner.style.display = "none";

    const viewingLabel = document.createElement("span");
    viewingLabel.textContent = "";

    const backBtn = document.createElement("button");
    backBtn.textContent = "Back to current";
    backBtn.addEventListener("click", async () => {
        viewingWorkflowKey = null;
        await refresh(true);
    });

    viewingBanner.appendChild(viewingLabel);
    viewingBanner.appendChild(backBtn);

    // List
    const list = document.createElement("div");
    list.className = "snap-list";

    // Footer
    const footer = document.createElement("div");
    footer.className = "snap-footer";

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear All Snapshots";
    clearBtn.addEventListener("click", async () => {
        const effKey = getEffectiveWorkflowKey();
        const confirmed = await showConfirmDialog(`Delete all snapshots for "${effKey}"?`);
        if (!confirmed) return;
        try {
            const { lockedCount } = await db_deleteAllForWorkflow(effKey);
            pickerDirty = true;
            if (lockedCount > 0) {
                showToast(`Cleared snapshots (${lockedCount} locked kept)`, "info");
            } else {
                showToast("All snapshots cleared", "info");
            }
        } catch {
            // db_deleteAllForWorkflow already toasts on error
        }
        await refresh(true);
        if (timelineRefresh) {
            timelineRefresh().catch(() => {});
        }
    });
    footer.appendChild(clearBtn);

    // ─── Profiles Section ──────────────────────────────────────────
    const profilesSection = document.createElement("div");
    profilesSection.className = "snap-profiles";

    const profilesHeader = document.createElement("div");
    profilesHeader.className = "snap-profiles-header";

    const profilesArrow = document.createElement("span");
    profilesArrow.className = "snap-profiles-arrow";
    profilesArrow.textContent = "\u25B6";

    const profilesTitle = document.createElement("span");
    profilesTitle.className = "snap-profiles-title";
    profilesTitle.textContent = "Profiles";

    const profilesSaveBtn = document.createElement("button");
    profilesSaveBtn.className = "snap-profiles-save-btn";
    profilesSaveBtn.textContent = "Save";
    profilesSaveBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const name = await showPromptDialog("Profile name:", "My Profile");
        if (name == null) return;
        const trimmed = name.trim() || "My Profile";

        // Gather session workflows
        const workflows = [];
        for (const [wk, info] of sessionWorkflows) {
            workflows.push({ workflowKey: wk, displayName: wk });
        }
        if (workflows.length === 0) {
            // At least include current workflow
            const currentKey = getWorkflowKey();
            workflows.push({ workflowKey: currentKey, displayName: currentKey });
        }

        const profile = {
            id: generateId(),
            name: trimmed,
            timestamp: Date.now(),
            workflows,
            activeWorkflowKey: getWorkflowKey(),
        };

        try {
            await profile_save(profile);
            showToast(`Profile "${trimmed}" saved (${workflows.length} workflow${workflows.length === 1 ? "" : "s"})`, "success");
            await refreshProfiles();
        } catch {
            // profile_save already toasts
        }
    });

    profilesHeader.appendChild(profilesArrow);
    profilesHeader.appendChild(profilesTitle);
    profilesHeader.appendChild(profilesSaveBtn);

    const profilesBody = document.createElement("div");
    profilesBody.className = "snap-profiles-body";
    let profilesExpanded = false;

    profilesHeader.addEventListener("click", async () => {
        profilesExpanded = !profilesExpanded;
        profilesArrow.classList.toggle("expanded", profilesExpanded);
        profilesBody.classList.toggle("expanded", profilesExpanded);
        if (profilesExpanded) await refreshProfiles();
    });

    async function refreshProfiles() {
        profilesBody.innerHTML = "";
        const profiles = await profile_list();
        if (profiles.length === 0) {
            const empty = document.createElement("div");
            empty.className = "snap-profiles-empty";
            empty.textContent = "No saved profiles";
            profilesBody.appendChild(empty);
            return;
        }
        for (const p of profiles) {
            const row = document.createElement("div");
            row.className = "snap-profile-item";

            const nameSpan = document.createElement("span");
            nameSpan.className = "snap-profile-name";
            nameSpan.textContent = p.name;
            nameSpan.title = p.name;

            const countSpanP = document.createElement("span");
            countSpanP.className = "snap-profile-count";
            countSpanP.textContent = `${(p.workflows || []).length} wf`;

            const loadBtn = document.createElement("button");
            loadBtn.className = "snap-profile-load-btn";
            loadBtn.textContent = "Load";
            loadBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                loadBtn.disabled = true;
                loadBtn.textContent = "Loading...";
                try {
                    const workflows = p.workflows || [];
                    let loaded = 0;
                    let skipped = 0;
                    // Load non-active workflows first (each overwrites previous —
                    // ComfyUI can only display one workflow at a time, but loading
                    // them populates the workflow history/tabs in some frontends)
                    for (const wf of workflows) {
                        // Skip active workflow — loaded last so it ends up visible
                        if (wf.workflowKey === p.activeWorkflowKey) continue;
                        const records = await db_getAllForWorkflow(wf.workflowKey);
                        if (records.length === 0) { skipped++; continue; }
                        records.sort((a, b) => b.timestamp - a.timestamp);
                        const full = await db_getFullRecord(records[0].workflowKey, records[0].id);
                        if (!full || !full.graphData) { skipped++; continue; }
                        try {
                            await app.loadGraphData(full.graphData, true, true);
                            loaded++;
                        } catch { skipped++; }
                    }
                    // Load the active workflow last so it's the one visible
                    if (p.activeWorkflowKey) {
                        const activeRecs = await db_getAllForWorkflow(p.activeWorkflowKey);
                        if (activeRecs.length > 0) {
                            activeRecs.sort((a, b) => b.timestamp - a.timestamp);
                            const activeFull = await db_getFullRecord(activeRecs[0].workflowKey, activeRecs[0].id);
                            if (activeFull?.graphData) {
                                try {
                                    await app.loadGraphData(activeFull.graphData, true, true);
                                    loaded++;
                                } catch { skipped++; }
                            } else { skipped++; }
                        } else { skipped++; }
                    }
                    let msg = `Profile "${p.name}" loaded (${loaded} workflow${loaded === 1 ? "" : "s"})`;
                    if (skipped > 0) msg += `, ${skipped} skipped`;
                    showToast(msg, "success");
                } catch (err) {
                    console.warn(`[${EXTENSION_NAME}] Profile load failed:`, err);
                    showToast("Failed to load profile", "error");
                } finally {
                    loadBtn.disabled = false;
                    loadBtn.textContent = "Load";
                }
            });

            const deleteBtn2 = document.createElement("button");
            deleteBtn2.className = "snap-profile-delete-btn";
            deleteBtn2.textContent = "\u2715";
            deleteBtn2.title = "Delete profile";
            deleteBtn2.addEventListener("click", async (e) => {
                e.stopPropagation();
                const confirmed = await showConfirmDialog(`Delete profile "${p.name}"?`);
                if (!confirmed) return;
                await profile_delete(p.id);
                showToast(`Profile "${p.name}" deleted`, "info");
                await refreshProfiles();
            });

            row.appendChild(nameSpan);
            row.appendChild(countSpanP);
            row.appendChild(loadBtn);
            row.appendChild(deleteBtn2);
            profilesBody.appendChild(row);
        }
    }

    profilesSection.appendChild(profilesHeader);
    profilesSection.appendChild(profilesBody);

    container.appendChild(header);
    container.appendChild(selectorRow);
    container.appendChild(pickerList);
    container.appendChild(viewingBanner);
    container.appendChild(profilesSection);
    container.appendChild(searchRow);
    container.appendChild(list);
    container.appendChild(footer);
    el.appendChild(container);

    // Track items for filtering
    let itemEntries = [];

    function filterItems(term) {
        for (const entry of itemEntries) {
            const matchesSearch = !term || entry.label.toLowerCase().includes(term) || entry.notes.toLowerCase().includes(term);
            const matchesAutoFilter = !hideAutoSaves || !entry.isAuto;
            entry.element.style.display = (matchesSearch && matchesAutoFilter) ? "" : "none";
        }
    }

    function setActionButtonsDisabled(disabled) {
        const buttons = list.querySelectorAll(".snap-btn-swap, .snap-btn-restore, .snap-btn-delete");
        for (const btn of buttons) {
            btn.disabled = disabled;
        }
    }

    async function refresh(resetSearch = false) {
        svgCache.clear();
        // Hide tooltip — items are about to be destroyed so mouseleave won't fire
        if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
        tooltip.classList.remove("visible");
        const currentKey = getWorkflowKey();
        const effKey = getEffectiveWorkflowKey();
        const isViewingOther = viewingWorkflowKey != null && viewingWorkflowKey !== currentKey;

        const allRecords = await db_getAllForWorkflow(effKey);

        const regularCount = allRecords.filter(r => r.source !== "node").length;
        const nodeCount = allRecords.filter(r => r.source === "node").length;
        countSpan.textContent = nodeCount > 0
            ? `${regularCount}/${maxSnapshots} + ${nodeCount}/${maxNodeSnapshots} node`
            : `${regularCount} / ${maxSnapshots}`;

        // Update selector label and styling
        selectorLabel.textContent = effKey;
        selectorRow.classList.toggle("snap-viewing-other", isViewingOther);

        // Show/hide viewing banner
        if (isViewingOther) {
            viewingLabel.textContent = `Viewing: ${viewingWorkflowKey}`;
            viewingBanner.style.display = "";
            takeBtn.disabled = true;
        } else {
            viewingBanner.style.display = "none";
            takeBtn.disabled = false;
        }

        // Mark picker stale; only collapse on user-initiated refreshes
        pickerDirty = true;
        if (resetSearch) {
            collapsePicker();
            searchInput.value = "";
            searchClear.classList.remove("visible");
        }

        list.innerHTML = "";
        itemEntries = [];

        if (allRecords.length === 0) {
            const empty = document.createElement("div");
            empty.className = "snap-empty";
            empty.textContent = "No snapshots yet. Edit the workflow or click 'Take Snapshot'.";
            list.appendChild(empty);
            return;
        }

        let records;
        let tree = null;
        let forkPointIds = new Set();
        if (branchingEnabled) {
            // Build tree and get display path for current branch
            tree = buildSnapshotTree(allRecords);
            const displayPath = getDisplayPath(tree, activeBranchSelections);
            records = [...displayPath].reverse();

            for (const [parentId, children] of tree.childrenOf) {
                if (children.length > 1) forkPointIds.add(parentId);
            }
        } else {
            // Flat: all records newest-first
            records = [...allRecords].sort((a, b) => b.timestamp - a.timestamp);
        }

        for (const rec of records) {
            // Insert branch navigator above fork-point snapshots
            if (branchingEnabled && forkPointIds.has(rec.id)) {
                const children = tree.childrenOf.get(rec.id);
                const selectedIndex = Math.min(activeBranchSelections.get(rec.id) ?? 0, children.length - 1);
                const nav = buildBranchNavigator(rec.id, children, selectedIndex, refresh);
                list.appendChild(nav);
            }
            const item = document.createElement("div");
            item.className = rec.source === "node" ? "snap-item snap-item-node" : "snap-item";
            if (diffBaseSnapshot && diffBaseSnapshot.id === rec.id) {
                item.classList.add("snap-diff-base");
            }
            if (rec.id === activeSnapshotId) {
                item.classList.add("snap-item-active");
            }
            if (rec.id === currentSnapshotId) {
                item.classList.add("snap-item-current");
            }

            const info = document.createElement("div");
            info.className = "snap-item-info";

            const labelDiv = document.createElement("div");
            labelDiv.className = "snap-item-label";
            labelDiv.textContent = rec.label;
            if (rec.source === "node") {
                const badge = document.createElement("span");
                badge.className = "snap-node-badge";
                badge.textContent = "Node";
                labelDiv.appendChild(badge);
            }
            labelDiv.addEventListener("dblclick", (e) => {
                e.stopPropagation();
                const originalLabel = rec.label;
                const input = document.createElement("input");
                input.type = "text";
                input.className = "snap-item-label-input";
                input.value = originalLabel;
                labelDiv.textContent = "";
                labelDiv.appendChild(input);
                input.select();
                input.focus();
                let committed = false;
                const commit = async () => {
                    if (committed) return;
                    committed = true;
                    const newLabel = input.value.trim() || originalLabel;
                    if (newLabel !== originalLabel) {
                        rec.label = newLabel;
                        await db_updateMeta(rec.workflowKey, rec.id, { label: newLabel });
                        await refresh();
                    } else {
                        labelDiv.textContent = originalLabel;
                        if (rec.source === "node") {
                            const b = document.createElement("span");
                            b.className = "snap-node-badge";
                            b.textContent = "Node";
                            labelDiv.appendChild(b);
                        }
                    }
                };
                input.addEventListener("keydown", (ev) => {
                    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
                    if (ev.key === "Escape") {
                        ev.preventDefault();
                        committed = true;
                        labelDiv.textContent = originalLabel;
                        if (rec.source === "node") {
                            const b = document.createElement("span");
                            b.className = "snap-node-badge";
                            b.textContent = "Node";
                            labelDiv.appendChild(b);
                        }
                    }
                });
                input.addEventListener("blur", commit);
            });

            const time = document.createElement("div");
            time.className = "snap-item-time";
            time.textContent = formatTime(rec.timestamp);

            const date = document.createElement("div");
            date.className = "snap-item-date";
            date.textContent = formatDate(rec.timestamp);

            const meta = document.createElement("div");
            meta.className = "snap-item-meta";
            const changeLabel = (CHANGE_TYPE_ICONS[rec.changeType] || CHANGE_TYPE_ICONS.unknown).label;
            meta.textContent = `${rec.nodeCount} nodes \u00b7 ${changeLabel}`;

            const notesDiv = document.createElement("div");
            notesDiv.className = "snap-item-notes";
            if (rec.notes) {
                notesDiv.textContent = rec.notes;
                notesDiv.title = rec.notes;
            } else {
                notesDiv.style.display = "none";
            }

            info.appendChild(labelDiv);
            info.appendChild(time);
            info.appendChild(date);
            info.appendChild(meta);
            info.appendChild(notesDiv);

            const actions = document.createElement("div");
            actions.className = "snap-item-actions";

            const noteBtn = document.createElement("button");
            noteBtn.className = "snap-btn-note" + (rec.notes ? " has-note" : "");
            noteBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 11.5V14h2.5L12.06 6.44 9.56 3.94 2 11.5zM14.35 4.15a.67.67 0 000-.94l-1.56-1.56a.67.67 0 00-.94 0L10.5 3l2.5 2.5 1.35-1.35z" fill="currentColor"/></svg>';
            noteBtn.title = rec.notes ? "Edit note" : "Add note";
            noteBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                // Toggle: if textarea already open, close it
                const existing = info.querySelector(".snap-item-notes-input");
                if (existing) { existing.remove(); return; }
                const textarea = document.createElement("textarea");
                textarea.className = "snap-item-notes-input";
                textarea.value = rec.notes || "";
                info.appendChild(textarea);
                textarea.focus();
                let saved = false;
                const saveNote = async () => {
                    if (saved) return;
                    saved = true;
                    const newNotes = textarea.value.trim();
                    rec.notes = newNotes || undefined;
                    await db_updateMeta(rec.workflowKey, rec.id, { notes: newNotes || null });
                    await refresh();
                };
                textarea.addEventListener("keydown", (ev) => {
                    if (ev.key === "Enter" && ev.ctrlKey) { ev.preventDefault(); textarea.blur(); }
                    if (ev.key === "Escape") { ev.preventDefault(); saved = true; textarea.remove(); }
                });
                textarea.addEventListener("blur", saveNote);
            });

            const lockBtn = document.createElement("button");
            lockBtn.className = rec.locked ? "snap-btn-lock snap-btn-locked" : "snap-btn-lock";
            lockBtn.innerHTML = rec.locked
                ? '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor"/><path d="M5 7V5a3 3 0 016 0v2" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>'
                : '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor"/><path d="M5 7V5a3 3 0 016 0" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
            lockBtn.title = rec.locked ? "Unlock snapshot" : "Lock snapshot";
            lockBtn.addEventListener("click", async () => {
                rec.locked = !rec.locked;
                await db_updateMeta(rec.workflowKey, rec.id, { locked: rec.locked });
                await refresh();
            });

            const swapBtn = document.createElement("button");
            swapBtn.className = "snap-btn-swap";
            swapBtn.textContent = "Swap";
            swapBtn.title = "Replace current workflow in-place";
            swapBtn.addEventListener("click", async () => {
                setActionButtonsDisabled(true);
                await swapSnapshot(rec);
            });

            const restoreBtn = document.createElement("button");
            restoreBtn.className = "snap-btn-restore";
            restoreBtn.textContent = "Restore";
            restoreBtn.title = "Open as new workflow";
            restoreBtn.addEventListener("click", async () => {
                setActionButtonsDisabled(true);
                await restoreSnapshot(rec);
            });

            const deleteBtn = document.createElement("button");
            deleteBtn.className = "snap-btn-delete";
            deleteBtn.textContent = "\u2715";
            deleteBtn.title = "Delete this snapshot";
            deleteBtn.addEventListener("click", async () => {
                if (rec.locked) {
                    const confirmed = await showConfirmDialog("This snapshot is locked. Delete anyway?");
                    if (!confirmed) return;
                }
                // Fork-point deletion: rebuild tree from fresh data, then re-parent children
                if (branchingEnabled) {
                    const freshRecords = await db_getAllForWorkflow(rec.workflowKey);
                    const freshTree = buildSnapshotTree(freshRecords);
                    const children = freshTree.childrenOf.get(rec.id);
                    if (children && children.length > 0) {
                        const confirmed = await showConfirmDialog(
                            `This snapshot is a branch point with ${children.length} child snapshot(s). Deleting it will re-parent them. Continue?`
                        );
                        if (!confirmed) return;
                        const newParent = freshTree.parentOf.get(rec.id) ?? null;
                        for (const child of children) {
                            await db_updateMeta(rec.workflowKey, child.id, { parentId: newParent });
                        }
                    }
                }
                await db_delete(rec.workflowKey, rec.id);
                pickerDirty = true;
                await refresh();
                if (timelineRefresh) {
                    timelineRefresh().catch(() => {});
                }
            });

            const diffBtn = document.createElement("button");
            diffBtn.className = "snap-btn-diff" + (diffBaseSnapshot && diffBaseSnapshot.id === rec.id ? " snap-diff-base-active" : "");
            diffBtn.textContent = "Diff";
            diffBtn.title = diffBaseSnapshot && diffBaseSnapshot.id !== rec.id
                ? `Compare '${diffBaseSnapshot.label}' vs this snapshot`
                : "Compare vs current workflow (Shift+click to set as base)";
            diffBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (e.shiftKey) {
                    // Toggle base selection
                    if (diffBaseSnapshot && diffBaseSnapshot.id === rec.id) {
                        diffBaseSnapshot = null;
                        showToast("Diff base cleared", "info");
                    } else {
                        diffBaseSnapshot = rec;
                        showToast(`Diff base set: "${rec.label}"`, "info");
                    }
                    refresh();
                    return;
                }
                // Normal click — async to allow lazy graphData fetch
                (async () => {
                    let baseGraph, targetGraph, baseLabel, targetLabel;
                    if (diffBaseSnapshot && diffBaseSnapshot.id !== rec.id) {
                        // Two-snapshot compare: base vs this
                        const baseFull = diffBaseSnapshot.graphData ? diffBaseSnapshot : await db_getFullRecord(diffBaseSnapshot.workflowKey, diffBaseSnapshot.id);
                        const targetFull = rec.graphData ? rec : await db_getFullRecord(rec.workflowKey, rec.id);
                        baseGraph = (baseFull && baseFull.graphData) || {};
                        targetGraph = (targetFull && targetFull.graphData) || {};
                        baseLabel = diffBaseSnapshot.label;
                        targetLabel = rec.label;
                        diffBaseSnapshot = null;
                        refresh(); // clear highlight
                    } else {
                        // Compare this snapshot vs current live workflow
                        const full = rec.graphData ? rec : await db_getFullRecord(rec.workflowKey, rec.id);
                        baseGraph = (full && full.graphData) || {};
                        targetGraph = getGraphData() || {};
                        baseLabel = rec.label;
                        targetLabel = "Current Workflow";
                    }
                    const diff = computeDetailedDiff(baseGraph, targetGraph);
                    const allNodes = buildNodeLookup(baseGraph, targetGraph);
                    showDiffModal(baseLabel, targetLabel, diff, allNodes, baseGraph, targetGraph);
                })();
            });

            const previewBtn = document.createElement("button");
            previewBtn.className = "snap-btn-preview";
            previewBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3C4 3 1.5 8 1.5 8s2.5 5 6.5 5 6.5-5 6.5-5S12 3 8 3z" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>';
            previewBtn.title = "Preview workflow graph";
            previewBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                showPreviewModal(rec);
            });

            actions.appendChild(noteBtn);
            actions.appendChild(previewBtn);
            actions.appendChild(diffBtn);
            actions.appendChild(lockBtn);
            actions.appendChild(swapBtn);
            actions.appendChild(restoreBtn);
            actions.appendChild(deleteBtn);

            // Hover tooltip
            item.addEventListener("mouseenter", () => {
                tooltipTimer = setTimeout(async () => {
                    const svgCacheKey = `${rec.id}:240x180`;
                    let graphData = rec.graphData;
                    if (!graphData && !svgCache.has(svgCacheKey)) {
                        const full = await db_getFullRecord(rec.workflowKey, rec.id);
                        if (!full || !tooltipTimer) return; // abort if mouse already left
                        graphData = full.graphData;
                    }
                    if (!tooltipTimer) return; // abort if mouse left during fetch
                    const svg = getCachedSVG(rec.id, graphData, { width: 240, height: 180 });
                    if (!svg) return;
                    tooltip.innerHTML = "";
                    tooltip.appendChild(svg);
                    const rect = item.getBoundingClientRect();
                    let left = rect.right + 8;
                    let top = rect.top;
                    // Clamp to viewport
                    if (left + 260 > window.innerWidth) left = rect.left - 260;
                    if (top + 200 > window.innerHeight) top = window.innerHeight - 200;
                    if (top < 0) top = 0;
                    tooltip.style.left = `${left}px`;
                    tooltip.style.top = `${top}px`;
                    tooltip.classList.add("visible");
                }, 200);
            });
            item.addEventListener("mouseleave", () => {
                if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
                tooltip.classList.remove("visible");
            });

            item.appendChild(info);
            item.appendChild(actions);
            list.appendChild(item);

            itemEntries.push({ element: item, label: rec.label, notes: rec.notes || "", isAuto: rec.label === "Auto" || rec.label === "Initial" });
        }

        // Re-apply current filters to newly built items
        const currentTerm = searchInput.value.toLowerCase();
        if (currentTerm || hideAutoSaves) {
            filterItems(currentTerm);
        }
    }

    sidebarRefresh = refresh;
    sidebarTooltipEl = tooltip;
    await refresh(true);
}

// ─── Timeline Bar ────────────────────────────────────────────────────

function buildTimeline() {
    // Guard against duplicate calls
    if (timelineEl) return;

    injectStyles();

    const canvasParent = app.canvas?.canvas?.parentElement;
    if (!canvasParent) {
        console.warn(`[${EXTENSION_NAME}] Cannot build timeline: canvas parent not found`);
        return;
    }

    // Ensure parent is positioned so absolute children work
    const parentPos = getComputedStyle(canvasParent).position;
    if (parentPos === "static") {
        canvasParent.style.position = "relative";
    }

    // Create root element
    const bar = document.createElement("div");
    bar.className = "snap-timeline";
    bar.style.display = showTimeline ? "" : "none";

    const track = document.createElement("div");
    track.className = "snap-timeline-track";

    const snapBtn = document.createElement("button");
    snapBtn.className = "snap-timeline-snap-btn";
    snapBtn.textContent = "Snapshot";
    snapBtn.title = "Take a manual snapshot (Ctrl+S)";
    snapBtn.addEventListener("click", async () => {
        snapBtn.disabled = true;
        const saved = await captureSnapshot("Manual");
        if (saved) showToast("Snapshot saved", "success");
        snapBtn.disabled = false;
    });

    const expandBtn = document.createElement("button");
    expandBtn.className = "snap-timeline-snap-btn snap-timeline-expand-btn";
    expandBtn.textContent = "\u25B4";
    expandBtn.title = "Expand timeline to show all branches";
    expandBtn.addEventListener("click", () => {
        timelineExpanded = !timelineExpanded;
        expandBtn.textContent = timelineExpanded ? "\u25BE" : "\u25B4";
        expandBtn.title = timelineExpanded ? "Collapse timeline" : "Expand timeline to show all branches";
        bar.classList.toggle("snap-timeline-expanded", timelineExpanded);
        refresh();
    });

    bar.appendChild(track);
    bar.appendChild(expandBtn);
    bar.appendChild(snapBtn);

    canvasParent.appendChild(bar);
    timelineEl = bar;

    function buildMarker(rec, { onClickBranch = null } = {}) {
        const marker = document.createElement("div");
        marker.className = "snap-timeline-marker";

        const iconInfo = CHANGE_TYPE_ICONS[rec.changeType] || CHANGE_TYPE_ICONS.unknown;
        marker.style.setProperty("--snap-marker-color", iconInfo.color);
        marker.innerHTML = iconInfo.svg;

        if (rec.source === "node") {
            marker.classList.add("snap-timeline-marker-node");
            marker.style.setProperty("--snap-marker-color", "#6d28d9");
        }
        if (rec.locked) marker.classList.add("snap-timeline-marker-locked");
        if (rec.id === activeSnapshotId) marker.classList.add("snap-timeline-marker-active");
        if (rec.id === currentSnapshotId) {
            marker.classList.add("snap-timeline-marker-current");
            marker.style.setProperty("--snap-marker-color", "#10b981");
        }

        let tip = `${rec.label} — ${formatTime(rec.timestamp)}\n${iconInfo.label}`;
        if (rec.notes) tip += `\n${rec.notes}`;
        marker.title = tip;

        marker.addEventListener("click", () => {
            if (onClickBranch) onClickBranch();
            swapSnapshot(rec);
        });

        return marker;
    }

    async function refresh() {
        if (!showTimeline) return;

        // Hide/show expand button based on branching
        expandBtn.style.display = branchingEnabled ? "" : "none";
        if (!branchingEnabled && timelineExpanded) {
            timelineExpanded = false;
            bar.classList.remove("snap-timeline-expanded");
            expandBtn.textContent = "\u25B4";
        }

        const allRecords = await db_getAllForWorkflow(getWorkflowKey());

        track.innerHTML = "";

        if (allRecords.length === 0) {
            const empty = document.createElement("span");
            empty.className = "snap-timeline-empty";
            empty.textContent = "No snapshots";
            track.appendChild(empty);
            return;
        }

        let tree = null;
        if (branchingEnabled) {
            tree = buildSnapshotTree(allRecords);
        }

        // ── Expanded mode: one row per branch ──
        if (timelineExpanded && branchingEnabled) {
            const allBranches = getAllBranches(tree);
            const currentPath = getDisplayPath(tree, activeBranchSelections);
            const currentIds = new Set(currentPath.map(r => r.id));

            // Determine which branch is the active one
            const currentLeafId = currentPath.length > 0 ? currentPath[currentPath.length - 1].id : null;

            for (const branch of allBranches) {
                const row = document.createElement("div");
                row.className = "snap-timeline-branch-row";

                const branchLeafId = branch[branch.length - 1].id;
                const isActiveBranch = branchLeafId === currentLeafId;
                if (isActiveBranch) row.classList.add("snap-timeline-branch-row-active");

                let skippedCount = 0;
                for (const rec of branch) {
                    if (!isActiveBranch && currentIds.has(rec.id)) {
                        skippedCount++;
                        continue;
                    }
                    const marker = buildMarker(rec, {
                        onClickBranch: isActiveBranch ? null : () => {
                            selectBranchContaining(branchLeafId, tree);
                        },
                    });
                    row.appendChild(marker);
                }

                // Indent non-active rows so fork points align with the active branch
                if (skippedCount > 0) {
                    row.style.paddingLeft = `${6 + skippedCount * 24}px`;
                }

                track.appendChild(row);
            }
            return;
        }

        // ── Collapsed mode (default) ──
        let records;
        let forkPointSet = new Set();
        if (branchingEnabled) {
            records = getDisplayPath(tree, activeBranchSelections);
            for (const [parentId, children] of tree.childrenOf) {
                if (children.length > 1) forkPointSet.add(parentId);
            }
        } else {
            records = [...allRecords].sort((a, b) => a.timestamp - b.timestamp);
        }

        for (const rec of records) {
            const marker = buildMarker(rec);

            // Fork point: vertical stack — up arrow, marker, down arrow
            if (branchingEnabled && forkPointSet.has(rec.id)) {
                const children = tree.childrenOf.get(rec.id);
                const selectedIndex = Math.min(activeBranchSelections.get(rec.id) ?? 0, children.length - 1);

                const group = document.createElement("div");
                group.className = "snap-timeline-fork-group";

                const arrowColor = marker.style.getPropertyValue("--snap-marker-color") || "#3b82f6";

                const upBtn = document.createElement("button");
                upBtn.className = "snap-timeline-branch-btn";
                upBtn.textContent = "\u25B2";
                upBtn.style.color = arrowColor;
                upBtn.title = `Branch ${selectedIndex}/${children.length}`;
                if (selectedIndex <= 0) upBtn.style.visibility = "hidden";
                upBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    activeBranchSelections.set(rec.id, Math.max(0, selectedIndex - 1));
                    refresh();
                    if (sidebarRefresh) sidebarRefresh().catch(() => {});
                });

                const downBtn = document.createElement("button");
                downBtn.className = "snap-timeline-branch-btn";
                downBtn.textContent = "\u25BC";
                downBtn.style.color = arrowColor;
                downBtn.title = `Branch ${selectedIndex + 2}/${children.length}`;
                if (selectedIndex >= children.length - 1) downBtn.style.visibility = "hidden";
                downBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    activeBranchSelections.set(rec.id, Math.min(children.length - 1, selectedIndex + 1));
                    refresh();
                    if (sidebarRefresh) sidebarRefresh().catch(() => {});
                });

                group.appendChild(upBtn);
                group.appendChild(marker);
                group.appendChild(downBtn);
                track.appendChild(group);
            } else {
                track.appendChild(marker);
            }
        }
    }

    timelineRefresh = refresh;
    refresh().catch(() => {});
}

// ─── Extension Registration ──────────────────────────────────────────

if (window.__COMFYUI_FRONTEND_VERSION__) {
    app.registerExtension({
        name: EXTENSION_NAME,

        settings: [
            {
                id: "SnapshotManager.autoCapture",
                name: "Auto-capture on edit",
                type: "boolean",
                defaultValue: true,
                category: ["Snapshot Manager", "Capture Settings", "Auto-capture on edit"],
                onChange(value) {
                    autoCaptureEnabled = value;
                },
            },
            {
                id: "SnapshotManager.debounceSeconds",
                name: "Capture delay (seconds)",
                type: "slider",
                defaultValue: 3,
                attrs: { min: 1, max: 30, step: 1 },
                category: ["Snapshot Manager", "Capture Settings", "Capture delay (seconds)"],
                onChange(value) {
                    debounceMs = value * 1000;
                },
            },
            {
                id: "SnapshotManager.maxSnapshots",
                name: "Max snapshots per workflow",
                type: "slider",
                defaultValue: 50,
                attrs: { min: 5, max: 200, step: 5 },
                category: ["Snapshot Manager", "Capture Settings", "Max snapshots per workflow"],
                onChange(value) {
                    maxSnapshots = value;
                },
            },
            {
                id: "SnapshotManager.captureOnLoad",
                name: "Capture on workflow load",
                type: "boolean",
                defaultValue: true,
                category: ["Snapshot Manager", "Capture Settings", "Capture on workflow load"],
                onChange(value) {
                    captureOnLoad = value;
                },
            },
            {
                id: "SnapshotManager.maxNodeSnapshots",
                name: "Max node-triggered snapshots per workflow",
                type: "slider",
                defaultValue: 5,
                attrs: { min: 1, max: 50, step: 1 },
                category: ["Snapshot Manager", "Capture Settings", "Max node-triggered snapshots"],
                onChange(value) {
                    maxNodeSnapshots = value;
                },
            },
            {
                id: "SnapshotManager.showTimeline",
                name: "Show snapshot timeline on canvas",
                type: "boolean",
                defaultValue: false,
                category: ["Snapshot Manager", "Timeline", "Show snapshot timeline on canvas"],
                onChange(value) {
                    showTimeline = value;
                    if (timelineEl) timelineEl.style.display = value ? "" : "none";
                    if (value && timelineRefresh) timelineRefresh().catch(() => {});
                },
            },
        ],

        init() {
            app.extensionManager.registerSidebarTab({
                id: "snapshot-manager",
                icon: "pi pi-history",
                title: "Snapshots",
                tooltip: "Browse and restore workflow snapshots",
                type: "custom",
                render: async (el) => {
                    await buildSidebar(el);
                },
                destroy: () => {
                    sidebarRefresh = null;
                    viewingWorkflowKey = null;
                    // Clean up tooltip
                    if (sidebarTooltipEl) {
                        sidebarTooltipEl.remove();
                        sidebarTooltipEl = null;
                    }
                },
            });
        },

        async setup() {
            // Migrate old IndexedDB data to server on first load
            await migrateFromIndexedDB();

            // Listen for graph changes (dispatched by ChangeTracker via api)
            api.addEventListener("graphChanged", () => {
                scheduleCaptureSnapshot();
            });

            // Listen for node-triggered snapshot captures via WebSocket
            api.addEventListener("snapshot-manager-capture", (event) => {
                const label = event.detail?.label || "Node Trigger";
                captureNodeSnapshot(label).catch((err) => {
                    console.warn(`[${EXTENSION_NAME}] Node-triggered capture failed:`, err);
                });
            });

            // Listen for workflow switches via Pinia store action
            const workflowStore = app.extensionManager?.workflow;
            if (workflowStore?.$onAction) {
                workflowStore.$onAction(({ name, after }) => {
                    if (name === "openWorkflow") {
                        const prevKey = getWorkflowKey(); // capture BEFORE switch
                        after(() => {
                            // Cancel any pending capture from the previous workflow
                            if (captureTimer) {
                                clearTimeout(captureTimer);
                                captureTimer = null;
                            }
                            viewingWorkflowKey = null;
                            activeSnapshotId = null;
                            currentSnapshotId = null;
                            diffBaseSnapshot = null;
                            // Clear branching state for the old workflow
                            lastCapturedIdMap.delete(prevKey);
                            activeBranchSelections.clear();
                            // Track session workflow (new key, after switch)
                            trackSessionWorkflow(getWorkflowKey());
                            if (sidebarRefresh) {
                                sidebarRefresh(true).catch(() => {});
                            }
                            if (timelineRefresh) {
                                timelineRefresh().catch(() => {});
                            }
                        });
                    }
                });
            }

            // Ctrl+S / Cmd+S shortcut for manual snapshot
            document.addEventListener("keydown", (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                    captureSnapshot("Manual (Ctrl+S)").then((saved) => {
                        if (saved) showToast("Snapshot saved", "success");
                    }).catch(() => {});
                    // Don't preventDefault — let ComfyUI's own workflow save still fire
                }
            });

            // Build the timeline bar on the canvas
            buildTimeline();

            // Track initial workflow for profiles
            trackSessionWorkflow(getWorkflowKey());

            // Capture initial state after a short delay (decoupled from debounceMs)
            setTimeout(() => {
                if (!captureOnLoad) return;
                captureSnapshot("Initial").catch((err) => {
                    console.warn(`[${EXTENSION_NAME}] Initial capture failed:`, err);
                });
            }, INITIAL_CAPTURE_DELAY_MS);
        },
    });
} else {
    // Legacy frontend: register without sidebar
    app.registerExtension({
        name: EXTENSION_NAME,
        async setup() {
            console.log(`[${EXTENSION_NAME}] Sidebar requires modern ComfyUI frontend, skipping.`);
        },
    });
}
