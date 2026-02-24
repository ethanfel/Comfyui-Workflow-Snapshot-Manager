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

// ─── State ───────────────────────────────────────────────────────────

const lastCapturedHashMap = new Map();
let restoreLock = null;
let captureTimer = null;
let sidebarRefresh = null; // callback set by sidebar render
let viewingWorkflowKey = null; // null = follow active workflow; string = override
let pickerDirty = true; // forces workflow picker to re-fetch on next expand

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

async function pruneSnapshots(workflowKey) {
    try {
        const resp = await api.fetchApi("/snapshot-manager/prune", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflowKey, maxSnapshots, source: "regular" }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || resp.statusText);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Prune failed:`, err);
    }
}

async function pruneNodeSnapshots(workflowKey) {
    try {
        const resp = await api.fetchApi("/snapshot-manager/prune", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflowKey, maxSnapshots: maxNodeSnapshots, source: "node" }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || resp.statusText);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Node prune failed:`, err);
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

    const record = {
        id: generateId(),
        workflowKey,
        timestamp: Date.now(),
        label,
        nodeCount: nodes.length,
        graphData,
        locked: false,
    };

    try {
        await db_put(record);
        await pruneSnapshots(workflowKey);
    } catch {
        return false;
    }

    lastCapturedHashMap.set(workflowKey, hash);
    pickerDirty = true;

    if (sidebarRefresh) {
        sidebarRefresh().catch(() => {});
    }
    return true;
}

async function captureNodeSnapshot(label = "Node Trigger") {
    if (restoreLock) return false;

    const graphData = getGraphData();
    if (!graphData) return false;

    const nodes = graphData.nodes || [];
    if (nodes.length === 0) return false;

    const workflowKey = getWorkflowKey();

    const record = {
        id: generateId(),
        workflowKey,
        timestamp: Date.now(),
        label,
        nodeCount: nodes.length,
        graphData,
        locked: false,
        source: "node",
    };

    try {
        await db_put(record);
        await pruneNodeSnapshots(workflowKey);
    } catch {
        return false;
    }

    pickerDirty = true;

    if (sidebarRefresh) {
        sidebarRefresh().catch(() => {});
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
    await withRestoreLock(async () => {
        if (!validateSnapshotData(record.graphData)) {
            showToast("Invalid snapshot data", "error");
            return;
        }
        try {
            await app.loadGraphData(record.graphData, true, true);
            lastCapturedHashMap.set(getWorkflowKey(), quickHash(JSON.stringify(record.graphData)));
            showToast("Snapshot restored", "success");
        } catch (err) {
            console.warn(`[${EXTENSION_NAME}] Restore failed:`, err);
            showToast("Failed to restore snapshot", "error");
        }
    });
}

async function swapSnapshot(record) {
    await withRestoreLock(async () => {
        if (!validateSnapshotData(record.graphData)) {
            showToast("Invalid snapshot data", "error");
            return;
        }
        try {
            const workflow = app.extensionManager?.workflow?.activeWorkflow;
            await app.loadGraphData(record.graphData, true, true, workflow);
            lastCapturedHashMap.set(getWorkflowKey(), quickHash(JSON.stringify(record.graphData)));
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
    text-align: center;
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
`;

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

async function buildSidebar(el) {
    injectStyles();
    el.innerHTML = "";

    const container = document.createElement("div");
    container.className = "snap-sidebar";

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

    searchRow.appendChild(searchInput);
    searchRow.appendChild(searchClear);

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
    });
    footer.appendChild(clearBtn);

    container.appendChild(header);
    container.appendChild(selectorRow);
    container.appendChild(pickerList);
    container.appendChild(viewingBanner);
    container.appendChild(searchRow);
    container.appendChild(list);
    container.appendChild(footer);
    el.appendChild(container);

    // Track items for filtering
    let itemEntries = [];

    function filterItems(term) {
        for (const entry of itemEntries) {
            const match = !term || entry.label.toLowerCase().includes(term);
            entry.element.style.display = match ? "" : "none";
        }
    }

    function setActionButtonsDisabled(disabled) {
        const buttons = list.querySelectorAll(".snap-btn-swap, .snap-btn-restore, .snap-btn-delete");
        for (const btn of buttons) {
            btn.disabled = disabled;
        }
    }

    async function refresh(resetSearch = false) {
        const currentKey = getWorkflowKey();
        const effKey = getEffectiveWorkflowKey();
        const isViewingOther = viewingWorkflowKey != null && viewingWorkflowKey !== currentKey;

        const records = await db_getAllForWorkflow(effKey);
        // newest first
        records.sort((a, b) => b.timestamp - a.timestamp);

        const regularCount = records.filter(r => r.source !== "node").length;
        const nodeCount = records.filter(r => r.source === "node").length;
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

        if (records.length === 0) {
            const empty = document.createElement("div");
            empty.className = "snap-empty";
            empty.textContent = "No snapshots yet. Edit the workflow or click 'Take Snapshot'.";
            list.appendChild(empty);
            return;
        }

        for (const rec of records) {
            const item = document.createElement("div");
            item.className = rec.source === "node" ? "snap-item snap-item-node" : "snap-item";

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

            const time = document.createElement("div");
            time.className = "snap-item-time";
            time.textContent = formatTime(rec.timestamp);

            const date = document.createElement("div");
            date.className = "snap-item-date";
            date.textContent = formatDate(rec.timestamp);

            const meta = document.createElement("div");
            meta.className = "snap-item-meta";
            meta.textContent = `${rec.nodeCount} nodes`;

            info.appendChild(labelDiv);
            info.appendChild(time);
            info.appendChild(date);
            info.appendChild(meta);

            const actions = document.createElement("div");
            actions.className = "snap-item-actions";

            const lockBtn = document.createElement("button");
            lockBtn.className = rec.locked ? "snap-btn-lock snap-btn-locked" : "snap-btn-lock";
            lockBtn.textContent = rec.locked ? "\uD83D\uDD12" : "\uD83D\uDD13";
            lockBtn.title = rec.locked ? "Unlock snapshot" : "Lock snapshot";
            lockBtn.addEventListener("click", async () => {
                rec.locked = !rec.locked;
                await db_put(rec);
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
                await db_delete(rec.workflowKey, rec.id);
                pickerDirty = true;
                await refresh();
            });

            actions.appendChild(lockBtn);
            actions.appendChild(swapBtn);
            actions.appendChild(restoreBtn);
            actions.appendChild(deleteBtn);

            item.appendChild(info);
            item.appendChild(actions);
            list.appendChild(item);

            itemEntries.push({ element: item, label: rec.label });
        }

        // Re-apply current search filter to newly built items
        const currentTerm = searchInput.value.toLowerCase();
        if (currentTerm) {
            filterItems(currentTerm);
        }
    }

    sidebarRefresh = refresh;
    await refresh(true);
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
                        after(() => {
                            // Cancel any pending capture from the previous workflow
                            if (captureTimer) {
                                clearTimeout(captureTimer);
                                captureTimer = null;
                            }
                            viewingWorkflowKey = null;
                            if (sidebarRefresh) {
                                sidebarRefresh(true).catch(() => {});
                            }
                        });
                    }
                });
            }

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
