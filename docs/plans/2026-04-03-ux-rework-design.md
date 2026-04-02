# UX Rework Design — 2026-04-03

## Context

After regular use, three pain points emerged:
1. Autosave generates too many snapshots (moves spam the timeline bar)
2. Branching UI is confusing and never used
3. No way to know what specifically changed when hovering a snapshot

## Changes

### 1. Autosave — Skip move-only snapshots

**Problem:** Moving nodes triggers auto-captures as frequently as structural changes, filling the timeline fast.

**Solution:** Add a guard in the capture path: if `detectChangeType()` returns `'move'`, skip the save and return early. No new config, no debounce changes.

Existing snapshots are unaffected.

### 2. Detailed diff metadata on hover

**Problem:** Snapshot icons show a change type icon but not *what* specifically changed.

**Solution:** At capture time, after `detectChangeType()`, run a new `computeDetailedDiff(prevGraph, currentGraph)` that produces:

```json
{
  "added": ["CLIPTextEncode", "KSampler"],
  "removed": ["VAEDecode"],
  "params": ["KSampler: steps 20→30", "KSampler: cfg 7→9"]
}
```

This object is stored in snapshot metadata. On hover in the sidebar or timeline, a tooltip renders these lines as plain text.

For snapshots captured before this change (no `diff` field), the tooltip falls back to the existing change type label.

**Diff computation:**
- Added/removed nodes: compare node sets by ID, label by title+type
- Changed params: compare `widgets_values` per node between previous and current graph

### 3. Hide branching UI

**Problem:** Branch navigation is confusing and adds visual noise.

**Solution:** Add `const BRANCHING_ENABLED = false` at the top of `snapshot_manager.js`. All branch UI rendering (the `< 1/2 >` navigator, branch buttons, `activeBranchSelections` sidebar/timeline logic) checks this flag and skips when false.

Underlying data and code (parentId, buildSnapshotTree, etc.) are left intact.

## Out of Scope

- Removing branching code
- Making branching a user-facing settings toggle
- Changing debounce timing
- Retroactively hiding or deleting move-type snapshots
