/**
 * ComfyUI Snapshot Manager
 *
 * Automatically captures workflow snapshots as you edit, stores them in
 * IndexedDB, and provides a sidebar panel to browse and restore any
 * previous version.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXTENSION_NAME = "ComfyUI.SnapshotManager";
const DB_NAME = "ComfySnapshotManager";
const STORE_NAME = "snapshots";
const RESTORE_GUARD_MS = 500;
const INITIAL_CAPTURE_DELAY_MS = 1500;

// ─── Configurable Settings (updated via ComfyUI settings UI) ────────

let maxSnapshots = 50;
let debounceMs = 3000;
let autoCaptureEnabled = true;
let captureOnLoad = true;

// ─── State ───────────────────────────────────────────────────────────

const lastCapturedHashMap = new Map();
let restoreLock = null;
let captureTimer = null;
let sidebarRefresh = null; // callback set by sidebar render

// ─── IndexedDB Layer ─────────────────────────────────────────────────

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
                store.createIndex("workflowKey", "workflowKey", { unique: false });
                store.createIndex("timestamp", "timestamp", { unique: false });
                store.createIndex("workflowKey_timestamp", ["workflowKey", "timestamp"], { unique: false });
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            db.onclose = () => { dbPromise = null; };
            db.onversionchange = () => { db.close(); dbPromise = null; };
            resolve(db);
        };
        req.onerror = () => {
            dbPromise = null;
            reject(req.error);
        };
    });
    return dbPromise;
}

async function db_put(record) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] IndexedDB write failed:`, err);
        showToast("Failed to save snapshot", "error");
        throw err;
    }
}

async function db_getAllForWorkflow(workflowKey) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const idx = tx.objectStore(STORE_NAME).index("workflowKey_timestamp");
            const range = IDBKeyRange.bound([workflowKey, 0], [workflowKey, Infinity]);
            const req = idx.getAll(range);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] IndexedDB read failed:`, err);
        showToast("Failed to read snapshots", "error");
        return [];
    }
}

async function db_delete(id) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] IndexedDB delete failed:`, err);
        showToast("Failed to delete snapshot", "error");
    }
}

async function db_deleteAllForWorkflow(workflowKey) {
    try {
        const records = await db_getAllForWorkflow(workflowKey);
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            for (const r of records) {
                store.delete(r.id);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] IndexedDB bulk delete failed:`, err);
        showToast("Failed to clear snapshots", "error");
        throw err;
    }
}

async function pruneSnapshots(workflowKey) {
    try {
        const all = await db_getAllForWorkflow(workflowKey);
        if (all.length <= maxSnapshots) return;
        // sorted ascending by timestamp (index order), oldest first
        const toDelete = all.slice(0, all.length - maxSnapshots);
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            for (const r of toDelete) {
                store.delete(r.id);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] IndexedDB prune failed:`, err);
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
        const wf = app.workflowManager?.activeWorkflow;
        return wf?.name || wf?.path || "default";
    } catch {
        return "default";
    }
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
    };

    try {
        await db_put(record);
        await pruneSnapshots(workflowKey);
    } catch {
        return false;
    }

    lastCapturedHashMap.set(workflowKey, hash);

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
            const workflow = app.workflowManager?.activeWorkflow;
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
.snap-empty {
    padding: 20px;
    text-align: center;
    color: var(--descrip-text, #666);
    font-size: 12px;
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
            takeBtn.disabled = false;
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

    // List
    const list = document.createElement("div");
    list.className = "snap-list";

    // Footer
    const footer = document.createElement("div");
    footer.className = "snap-footer";

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear All Snapshots";
    clearBtn.addEventListener("click", async () => {
        const confirmed = await showConfirmDialog("Delete all snapshots for this workflow?");
        if (!confirmed) return;
        try {
            await db_deleteAllForWorkflow(getWorkflowKey());
            showToast("All snapshots cleared", "info");
        } catch {
            // db_deleteAllForWorkflow already toasts on error
        }
        await refresh(true);
    });
    footer.appendChild(clearBtn);

    container.appendChild(header);
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
        const workflowKey = getWorkflowKey();
        const records = await db_getAllForWorkflow(workflowKey);
        // newest first
        records.sort((a, b) => b.timestamp - a.timestamp);

        countSpan.textContent = `${records.length} / ${maxSnapshots}`;

        list.innerHTML = "";
        itemEntries = [];

        if (resetSearch) {
            searchInput.value = "";
            searchClear.classList.remove("visible");
        }

        if (records.length === 0) {
            const empty = document.createElement("div");
            empty.className = "snap-empty";
            empty.textContent = "No snapshots yet. Edit the workflow or click 'Take Snapshot'.";
            list.appendChild(empty);
            return;
        }

        for (const rec of records) {
            const item = document.createElement("div");
            item.className = "snap-item";

            const info = document.createElement("div");
            info.className = "snap-item-info";

            const labelDiv = document.createElement("div");
            labelDiv.className = "snap-item-label";
            labelDiv.textContent = rec.label;

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
                await db_delete(rec.id);
                await refresh();
            });

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
                },
            });
        },

        async setup() {
            // Listen for graph changes (dispatched by ChangeTracker via api)
            api.addEventListener("graphChanged", () => {
                scheduleCaptureSnapshot();
            });

            // Listen for workflow switches
            if (app.workflowManager) {
                app.workflowManager.addEventListener("changeWorkflow", () => {
                    // Cancel any pending capture from the previous workflow
                    if (captureTimer) {
                        clearTimeout(captureTimer);
                        captureTimer = null;
                    }
                    if (sidebarRefresh) {
                        sidebarRefresh(true).catch(() => {});
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
