# UX Rework Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Three focused UX improvements: hide branching UI, skip move-only autosaves, and show specific diff details on hover.

**Architecture:** All changes are in `js/snapshot_manager.js`. No backend changes needed. Diff summary is computed at capture time and stored in snapshot metadata so hover display is instant (no extra fetch).

**Tech Stack:** Vanilla JS, ComfyUI extension API, existing `computeDetailedDiff()` function (line 485).

---

### Task 1: Hide branching UI

**Files:**
- Modify: `js/snapshot_manager.js:27` (branchingDefault)
- Modify: `js/snapshot_manager.js:350-354` (isBranchingEnabled)
- Modify: `js/snapshot_manager.js:2847-2866` (branchToggleBtn)

**Step 1: Add BRANCHING_ENABLED constant**

At the very top of the file (after the opening comment block, around line 1-30), add this constant near the other state variables:

```js
const BRANCHING_ENABLED = false;
```

Place it just before line 27 (`let branchingDefault = true;`).

**Step 2: Short-circuit isBranchingEnabled()**

Current code at line 350:
```js
function isBranchingEnabled(wk) {
    if (!wk) wk = getEffectiveWorkflowKey();
    if (workflowBranchOverrides.has(wk)) return workflowBranchOverrides.get(wk);
    return branchingDefault;
}
```

Add an early return at the top of the function:
```js
function isBranchingEnabled(wk) {
    if (!BRANCHING_ENABLED) return false;
    if (!wk) wk = getEffectiveWorkflowKey();
    if (workflowBranchOverrides.has(wk)) return workflowBranchOverrides.get(wk);
    return branchingDefault;
}
```

This makes all 14 existing `isBranchingEnabled()` callsites automatically behave as if branching is off — no other changes needed in capture, sidebar, or timeline code.

**Step 3: Hide the branch toggle button in the sidebar**

The button is created at line 2847 and appended at line 2866. Hide it:

Current (line 2847):
```js
const branchToggleBtn = document.createElement("button");
branchToggleBtn.className = "snap-filter-auto-btn" + (isBranchingEnabled() ? " active" : "");
```

Change to:
```js
const branchToggleBtn = document.createElement("button");
branchToggleBtn.className = "snap-filter-auto-btn" + (isBranchingEnabled() ? " active" : "");
branchToggleBtn.style.display = "none";
```

**Step 4: Verify manually in browser**
- Open ComfyUI, open snapshot manager sidebar
- Confirm "Branch" button is not visible
- Create 2-3 snapshots, confirm no branch navigator (`< 1/2 >`) appears
- Confirm timeline has no expand button

**Step 5: Commit**
```bash
git add js/snapshot_manager.js
git commit -m "Hide branching UI (BRANCHING_ENABLED = false)"
```

---

### Task 2: Skip move-only autosaves

**Files:**
- Modify: `js/snapshot_manager.js:1459-1460`

**Step 1: Add move filter in _captureSnapshotInner**

Current code at lines 1458-1460:
```js
const prevGraph = lastGraphDataMap.get(workflowKey);
const changeType = detectChangeType(prevGraph, graphData);

// Determine parentId for branching
```

Add one line after the changeType computation:
```js
const prevGraph = lastGraphDataMap.get(workflowKey);
const changeType = detectChangeType(prevGraph, graphData);
if (changeType === "move") return false;

// Determine parentId for branching
```

**Step 2: Verify manually in browser**
- Open ComfyUI, move several nodes around
- Confirm no new snapshots appear in the sidebar/timeline while moving
- Add a node → confirm a snapshot IS created
- Change a parameter → confirm a snapshot IS created

**Step 3: Commit**
```bash
git add js/snapshot_manager.js
git commit -m "Skip autosave for move-only changes"
```

---

### Task 3: Store diff summary at capture time

**Files:**
- Modify: `js/snapshot_manager.js:614` (after computeDetailedDiff, add new helper)
- Modify: `js/snapshot_manager.js:1471-1481` (record construction in _captureSnapshotInner)
- Modify: `js/snapshot_manager.js:1550-1562` (record construction in captureNodeSnapshot)

**Step 1: Add computeCaptureMetaDiff() and formatCaptureDiffLines() helpers**

Insert these two functions right after `computeDetailedDiff` ends (after line 614, before the SVG section comment at line 616):

```js
// Compact diff stored in snapshot metadata for hover display
function computeCaptureMetaDiff(prevGraph, currGraph) {
    if (!prevGraph || !currGraph) return null;
    const diff = computeDetailedDiff(prevGraph, currGraph);
    const result = {};
    if (diff.addedNodes.length > 0)
        result.added = diff.addedNodes.map(n => n.title);
    if (diff.removedNodes.length > 0)
        result.removed = diff.removedNodes.map(n => n.title);
    // Nodes with param/property changes (ignore pure position/size changes)
    const paramChanged = diff.modifiedNodes.filter(n =>
        n.changes.widgetValues || n.changes.properties || n.changes.title || n.changes.mode
    );
    if (paramChanged.length > 0)
        result.params = paramChanged.map(n => {
            const count = (n.changes.widgetValues?.length ?? 0) + (n.changes.properties?.length ?? 0);
            return count > 0 ? `${n.title} (${count} value${count > 1 ? "s" : ""})` : n.title;
        });
    if (diff.addedLinks.length > 0 || diff.removedLinks.length > 0)
        result.links = { added: diff.addedLinks.length, removed: diff.removedLinks.length };
    return Object.keys(result).length > 0 ? result : null;
}

function formatCaptureDiffLines(captureDiff) {
    if (!captureDiff) return [];
    const lines = [];
    if (captureDiff.added?.length)
        lines.push(`+ ${captureDiff.added.join(", ")}`);
    if (captureDiff.removed?.length)
        lines.push(`− ${captureDiff.removed.join(", ")}`);
    if (captureDiff.params?.length)
        lines.push(`~ ${captureDiff.params.join(", ")}`);
    if (captureDiff.links) {
        const parts = [];
        if (captureDiff.links.added) parts.push(`+${captureDiff.links.added} link${captureDiff.links.added > 1 ? "s" : ""}`);
        if (captureDiff.links.removed) parts.push(`−${captureDiff.links.removed} link${captureDiff.links.removed > 1 ? "s" : ""}`);
        if (parts.length) lines.push(parts.join(", "));
    }
    return lines;
}
```

**Step 2: Add captureDiff to record in _captureSnapshotInner**

Current record construction at lines 1471-1481:
```js
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
```

Add `captureDiff` field:
```js
const captureDiff = computeCaptureMetaDiff(prevGraph, graphData);
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
    ...(captureDiff ? { captureDiff } : {}),
};
```

**Step 3: Same for captureNodeSnapshot**

Current record construction at lines 1550-1562:
```js
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
    ...(thumbnail ? { thumbnail } : {}),
};
```

Change to:
```js
const captureDiff = computeCaptureMetaDiff(prevGraph, graphData);
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
    ...(captureDiff ? { captureDiff } : {}),
    ...(thumbnail ? { thumbnail } : {}),
};
```

**Step 4: Commit**
```bash
git add js/snapshot_manager.js
git commit -m "Compute and store diff summary at capture time"
```

---

### Task 4: Show diff in sidebar hover tooltip

**Files:**
- Modify: `js/snapshot_manager.js:3573-3603` (mouseenter handler in sidebar)

**Step 1: Add diff lines to tooltip**

Current mouseenter callback (lines 3572-3608) renders an SVG or thumbnail then positions/shows the tooltip. After the SVG/thumbnail is appended (right before the `rect` / positioning block), add diff lines:

Locate this block in the mouseenter callback:
```js
                    if (!tooltipTimer) return;
                    const svg = getCachedSVG(rec.id, graphData, { width: 240, height: 180 });
                    if (!svg) return;
                    tooltip.appendChild(svg);
                }
                const rect = item.getBoundingClientRect();
```

Change to:
```js
                    if (!tooltipTimer) return;
                    const svg = getCachedSVG(rec.id, graphData, { width: 240, height: 180 });
                    if (!svg) return;
                    tooltip.appendChild(svg);
                }
                // Diff summary lines
                const diffLines = formatCaptureDiffLines(rec.captureDiff);
                if (diffLines.length > 0) {
                    const diffEl = document.createElement("div");
                    diffEl.style.cssText = "margin-top:6px;font-size:11px;line-height:1.5;color:#ccc;white-space:pre;";
                    diffEl.textContent = diffLines.join("\n");
                    tooltip.appendChild(diffEl);
                }
                const rect = item.getBoundingClientRect();
```

**Step 2: Verify manually in browser**
- Create a snapshot by adding a node → hover it in sidebar → tooltip shows SVG preview + diff lines like `+ KSampler`
- Create a snapshot by changing a param → hover it → tooltip shows `~ KSampler (1 value)`
- Hover an old snapshot without captureDiff → tooltip shows SVG only (no crash)

**Step 3: Commit**
```bash
git add js/snapshot_manager.js
git commit -m "Show diff summary in sidebar hover tooltip"
```

---

### Task 5: Show diff in timeline marker tooltip

**Files:**
- Modify: `js/snapshot_manager.js:3715-3717` (buildMarker tip construction)

**Step 1: Append diff lines to marker title**

Current code at lines 3715-3717:
```js
        let tip = `${rec.label} — ${formatTime(rec.timestamp)}\n${iconInfo.label}`;
        if (rec.notes) tip += `\n${rec.notes}`;
        marker.title = tip;
```

Change to:
```js
        let tip = `${rec.label} — ${formatTime(rec.timestamp)}\n${iconInfo.label}`;
        const diffLines = formatCaptureDiffLines(rec.captureDiff);
        if (diffLines.length > 0) tip += `\n${diffLines.join("\n")}`;
        if (rec.notes) tip += `\n${rec.notes}`;
        marker.title = tip;
```

**Step 2: Verify manually in browser**
- Hover a timeline marker → native tooltip shows label, time, change type, then diff lines

**Step 3: Commit**
```bash
git add js/snapshot_manager.js
git commit -m "Show diff summary in timeline marker tooltip"
```
