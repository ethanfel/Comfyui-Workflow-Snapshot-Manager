# Non-Destructive Timeline — Research Report & Implementation Plan

**Date:** 2026-06-29
**Goal:** Make the Snapshot Manager timeline behave like Autodesk Fusion 360's parametric
timeline — jumping back and forth is easy, fast, and **non-destructive** — while fixing the
three reported pain points: (1) weak "what changed" info, (2) spammy autosave, (3) workflow
switching spams "now save".

This document has two parts:
- **Part 1 — Research report** (web research, 25 claims survived 3-vote adversarial verification).
- **Part 2 — Implementation plan** (each recommendation mapped to concrete changes in `js/snapshot_manager.js`).

---

# Part 1 — Research Report

## Executive summary

Across Fusion 360 (CAD), Houdini (node graph), Unreal (Blueprint diff), Final Cut Pro (NLE),
Figma and Google Docs (history panels), the tools that feel non-destructive share four moves:
**(a)** jumping back never deletes later work — it *disables and recomputes* it (Fusion) or keeps
the live state untouched while you preview (Final Cut Pro skimmer); **(b)** *preview* is decoupled
from *commit* — you can hover/scrub other states and still "return to where you were"; **(c)** a
restore/jump records the pre-jump state **once** as a checkpoint (Figma) rather than spamming
checkpoints; and **(d)** "what changed" is shown **semantically** (named parameters, fixed
color-coded change types — Unreal's red/green/cyan/grey), with trivial moves *de-emphasized* and
auto-history *coalesced* by time or by filtering out streaming/cosmetic edits (Figma's 30-min
cadence; redux-undo's `filter`/`excludeAction`/`groupBy`; Houdini's explicit warning against
over-automatic capture). These map cleanly onto a snapshot-per-state model and onto all three pain
points.

## Findings

### F1 — Non-destructive "jump back" = disable + recompute, never delete (Fusion 360) — **HIGH**
Fusion records every step in creation order and lets you "go back in time" to edit earlier
decisions without starting over. Mechanically, editing/rolling to a past feature **rolls the
history marker to just before it and disables (not deletes) all downstream nodes**, then
**recomputes them forward** when you roll back to the end — "all the features that were after that
point are preserved and will reappear." Rolling the marker back "has not deleted the features in
front of the marker." This is the load-bearing property: navigating history is a *reversible
editing surface*, not a destructive log.
*Sources: autodesk.com Fusion blog (timeline-edits, beginners-guide-part-4) — primary; help.autodesk.com Fusion-360-API CustomFeatures_UM — primary; productdesignonline.com; Ace Makerspace. Votes 3-0 (×5), 2-1 (×1).*

### F2 — Navigation gesture == edit gesture, plus a draggable marker with playback controls (Fusion) — **HIGH**
A past step is edited in place by **double-clicking** it, or **right-click → Edit Sketch/Edit
Feature**. Pure navigation is a **draggable history-marker slider** ("rolling back the design")
with **playback controls** (move-to-beginning, previous step, play, next step, move-to-end) and a
right-click **"Roll History Marker Here"** to jump the marker directly to any step. So back/forth
is a one-gesture, low-friction interaction distinct from editing.
*Sources: autodesk.com Fusion blog — primary; productdesignonline.com (blog); Noble Desktop. Votes 3-0.*

### F3 — Decouple *preview* from *committed position* — the skimmer pattern (Final Cut Pro) — **HIGH**
Final Cut Pro uses **two indicators**: a persistent **playhead** (your committed position, fixed
unless you move it) and a transient **skimmer** (a preview cursor that follows the pointer). The
skimmer "lets you preview clips… **without affecting the playhead position**," so you can "skim to
see what's in other clips but still keep your playhead position." This is the canonical
"scrub-to-preview, keep your place / return to where I was" pattern — non-destructive preview
decoupled from the committed edit position.
*Sources: support.apple.com Final Cut Pro (skimmer, intro-to-playback) — primary; Larry Jordan; Ripple Training. Votes 3-0 (×3), 2-1 (×1).*

### F4 — Semantic, color-coded "what changed" + difference navigation (Unreal Blueprint diff) — **HIGH**
Unreal's Blueprint Diff Tool communicates **change type visually** with a fixed legend:
**red = removed, green = added, cyan = changed, grey = moved nodes/comments.** It provides
**Next/Previous** buttons to cycle differences one at a time and a **clickable navigation tree** to
jump to a specific difference. The lesson: show the *kind* of change semantically (not raw
indices), and explicitly give **moves their own subdued category** (grey).
*Sources: dev.epicgames.com UE Diff Tool docs (UE 5.7) — primary. Votes 2-1 (color legend), 3-0 (navigation).*

### F5 — Scope change capture explicitly; warn against over-automatic capture (Houdini takes) — **HIGH**
Houdini "takes" are **hierarchically overlaid sets of parameter changes**: any parameter you don't
explicitly change is **inherited from the parent**, enabling non-destructive parallel variations
that preserve the original. Only **explicitly included** parameters are editable in a take (others
appear disabled), and the takes pane **shows which parameters changed** for the selected take.
Critically, SideFX **explicitly warns against overusing Auto-take mode** because it "makes it easy
to unintentionally include parameters… which… can make diagnosing problems difficult" — a
first-party anti-pattern for automatic change capture that mirrors this tool's autosave spam.
*Sources: sidefx.com/docs/houdini takes + ref/panes/takes — primary. Votes 3-0.*

### F6 — Restore/jump is non-destructive *because it checkpoints the pre-jump state once* (Figma) — **HIGH**
Restoring a previous version in Figma "is a **non-destructive action**, so you can still access the
current version." It works by adding **two autosave checkpoints**: one preserving the
current/pre-restore state, one marking the restored version. So later work is never silently lost —
it's captured as a checkpoint exactly once at the moment of restore.
*Sources: help.figma.com version-history — primary. Votes 3-0.*

### F7 — Coalesce auto-history by time; separate viewing from restoring; named vs auto (Figma, Google Docs) — **HIGH**
Figma records an auto **checkpoint every 30 minutes** (time-based coalescing) while keeping the
live "current version" continuously up to date — it does **not** snapshot on every edit. Google
Docs separates **viewing** an earlier version (read-only; a **"Back"** control returns you to
current, no state change) from **restoring** it (explicit "Restore this version"). It also supports
**named versions** distinct from auto-saved revisions, with an **"Only show named versions"** filter
to cut noise (caps: 40 named/doc, 15/spreadsheet).
*Sources: help.figma.com; support.google.com/docs/answer/190843 — primary. Votes 3-0.*

### F8 — History-noise control patterns: filter, exclude streaming actions, group into chunks (redux-undo) — **HIGH**
A `filter` keeps intermediate state changes **out of history** (`state.past`) **without affecting
the live state**. For drag-like continuous edits, `excludeAction(['MOVE_CURSOR','UPDATE_OBJECT_POS'])`
records **only the final committed state**. And undo/redo in "reasonable chunks" needs deliberate
**custom filters + `groupBy`** rather than recording every micro-action. This is the concrete
recipe for de-noising autosave: gate out cosmetic/streaming edits, coalesce a burst into one entry.
*Sources: redux-undo.js.org/main/faq — primary; GitHub README. Votes 3-0 (×2), 2-1 (×1).*

## Confidence & caveats
- **High confidence** on every finding above (primary vendor docs; mostly unanimous 3-0 votes).
- **Vendor-doc framing:** Fusion's "non-destructive" language partly comes from Autodesk marketing
  blogs, but the *mechanism* (disable + recompute, marker preserves downstream) is independently
  corroborated by API docs and third parties — solid.
- **Edge cases noted but not refuting:** editing a far-upstream Fusion feature can break downstream
  dependency references (inherent to any dependency graph; the design is still never destroyed);
  Figma history retention is tier-bounded (30 days on free); redux-undo `filter` is technically a
  warning-context API, not an endorsement (the *pattern* still holds).
- **Coverage gaps:** DAW (Ableton/Logic), DaVinci/Premiere timeline scrubbing, Photoshop history,
  and Git-GUI detached-HEAD UX were searched but produced no *separately verified* surviving claims
  beyond what Final Cut Pro / Figma / Google Docs already cover. The FCP skimmer is the strongest
  scrubbing-ergonomics result.

## Open questions
1. For a **snapshot-per-state** model (vs Fusion's parametric feature graph), should "jump back and
   edit" create a **branch** automatically, or keep the linear list and rely on non-destructive
   "Current" checkpoints? (Branching is currently hard-disabled in the build.)
2. What's the right **auto-snapshot cadence** — pure event-debounce (today: 3 s), a Figma-style
   time floor (e.g. ≥1 per N minutes), or both?
3. Should **scrub/preview** load the graph at all (expensive), or only show the SVG/thumbnail
   preview until the user explicitly commits — to keep back/forth instant on large graphs?

---

# Part 2 — Implementation Plan

Each workstream cites concrete code in `js/snapshot_manager.js`. Ordered by impact;
**Must-have → Should-have → Nice-to-have**.

## Implementation status (2026-06-29)
**Done** (all four batches landed, 19/19 unit tests on the extracted diff logic pass):
- **C1 + C2** — `seedWorkflowBaseline()` + `suppressAutoCapture(SWITCH_GUARD_MS)` on `openWorkflow`; `scheduleCaptureSnapshot` honours the suppression window.
- **B1** — `detectChangeType` now classifies move/resize/collapse(+pin) as `"cosmetic"` and never lets a cosmetic flag escalate a real edit; `mode` (mute/bypass) treated as meaningful. `_captureCore` skips `changeType==="cosmetic"` for auto-captures (`skipCosmetic`).
- **A1 + A3** — `getLiveWidgetNames()`/`widgetNameFor()` map `widgets_values` indices → names at capture; `computeDetailedDiff`/`computeCaptureMetaDiff` carry names; diff modal shows `seed:`/`text:` (meaningful first) and collapses position/size into one muted "Layout: moved, resized" line; tooltips read `KSampler (seed, cfg)`.
- **D1 + D3** — non-destructive jump confirmed (swap re-seeds hash + dedup → repeat steps are storage no-ops); `stepToSnapshot()` + **Alt+◀ / Alt+▶** keyboard step nav with a quiet swap and a `N/total · label` position toast.

**Deferred (nice-to-have, not yet built):** A2 full Unreal-style color legend per change type; B2 time-based checkpoint floor; B3 Google-Docs "only show manual/named" filter; D2 drag-scrub skimmer mode (hover preview already exists); D4 explicit "return to where I was" affordance.

## Pain-point ↔ finding map
| Pain point | Backed by | Workstreams |
|---|---|---|
| Weak "what changed" info | F4, F5, F7 | **A** |
| Spammy autosave | F5, F7, F8 | **B** |
| WF-switch spams "now save" | (codebase bug) F6 | **C** |
| Fusion-360 non-destructive feel | F1, F2, F3, F6 | **D** |

---

## Workstream A — Semantic "what changed" (MUST) — *F4, F5, F7*

**Problem (code):** `computeDetailedDiff` (`:565`) compares `widgets_values` positionally and emits
`Value[6]: "a cat" → "a dog"` (`:1370`). `getGraphData()` is `app.graph.serialize()` (`:438`), so
at capture time the **live** `app.graph._nodes[i].widgets[]` array — each with a `.name` in the
same order as `widgets_values` — is available but never used. `detectChangeType` (`:454`) only
yields a coarse single bucket.

**A1. Capture a widget index→name map (MUST).** At capture in `_captureCore` (`:1574`), walk
`app.graph._nodes`, build `{nodeId: [widgetName,…]}`, and use it so diffs read `text:`, `seed:`,
`cfg:`, `sampler_name:` instead of `Value[i]`. Store a compact, named `captureDiff` (extend
`computeCaptureMetaDiff` `:697`). Persisted per snapshot so old snapshots without it degrade
gracefully to the current `Value[i]` form.

**A2. Semantic change classification + Unreal-style legend (SHOULD).** Replace the single
`changeType` with a small set the user cares about: `prompt`, `param` (seed/cfg/sampler/steps/…),
`model` (checkpoint/LoRA names), `connection`, `node_add`/`node_remove`, and a subordinate
`cosmetic` (move/resize/collapse). Reuse `CHANGE_TYPE_ICONS` (`:2755`) with the red=removed /
green=added / cyan=changed / grey=cosmetic palette (F4). **Moves/resizes get the grey, de-emphasized
treatment** — exactly what you asked for.

**A3. De-noise the diff modal + tooltip (SHOULD).** In `showDiffModal` (`:1232`) and
`formatCaptureDiffLines` (`:720`), put position/size/move rows in a **collapsed "Cosmetic"
section** and surface prompt/param/model/connection changes first with their widget names. The
hover tooltip headline should read e.g. `~ KSampler (seed, cfg) · + CLIPTextEncode` rather than
`~ 2 values`.

## Workstream B — Tame autosave noise (MUST) — *F5, F7, F8*

**Problem (code):** every `graphChanged` schedules a capture (`:4236`→`scheduleCaptureSnapshot`
`:1671`, 3 s debounce). `_captureCore` only skips `changeType === "move"` (`:1589`), so **resize and
collapse/expand fall through as `"unknown"` and ARE saved** as snapshots — pure visual noise. No
floor on auto-snapshot frequency.

**B1. Cosmetic-change gate (MUST).** Generalize `skipMove` → `skipCosmetic`: skip auto-capture when
the *only* changes are position/size/collapse/pin (redux-undo `filter`/`excludeAction`; Houdini
Auto-take warning F5/F8). Manual snapshots (Ctrl+S `:4297`, Snapshot button `:3901`) and node-trigger
captures still save everything. This alone removes most of the spam.

**B2. Coalesce bursts; optional time floor (SHOULD).** Keep the 3 s event-debounce (already
coalesces a typing burst). Add an optional minimum interval between *auto* snapshots and/or a
Figma-style time-based fallback checkpoint (F7), configurable via the existing settings
(`debounceSeconds` lives at `:4130`).

**B3. Make auto vs manual legible + filterable (NICE).** Auto-snapshots already carry labels;
borrow Google Docs' **"Only show named/manual versions"** filter (F7) in the sidebar so the auto
stream can be hidden. The existing search/filter UI (`:2934`+) is the natural home.

## Workstream C — Fix workflow-switch "now save" spam (MUST) — *codebase bug, F6*

**Root cause (code):** the `openWorkflow` handler (`:4252`) resets state and seeds
`lastCapturedIdMap` for the new tab but **never seeds `lastCapturedHashMap` / `lastGraphData`** for
it. ComfyUI's `loadGraphData` for the freshly-opened workflow then fires `graphChanged` →
`scheduleCaptureSnapshot` → 3 s later `captureSnapshot("Auto")` runs, finds no seeded hash, **can't
dedupe**, and saves a redundant snapshot of a workflow you only just opened.

**C1. Re-seed hash on switch (MUST).** In the `openWorkflow` `after()` block (`:4255`), after the
new graph is live, set `lastCapturedHashMap`/`setLastGraphData` for `newKey` (mirror the setup
seeding at `:4309-4322`). The post-load `graphChanged` then dedupes to a no-op.

**C2. Programmatic-load suppression window (MUST).** Add a short-lived `loadingLock` flag (sibling
to `restoreLock` `:35`/`:1170`) set around tab switches and snapshot loads so `scheduleCaptureSnapshot`
(`:1671`) ignores the `graphChanged` events that *we* caused. Belt-and-suspenders with C1.

## Workstream D — Fusion-360 non-destructive navigation (SHOULD) — *F1, F2, F3, F6*

**Problem (code):** every timeline marker click calls `swapSnapshot(rec)` (`:3955`), which
`captureSnapshot("Current")` **before** loading (`:1728`). So *navigating* is what generates "now
save" and it feels destructive. There's no prev/next step nav and the current-position indicator is
subtle.

**D1. Non-destructive jump = checkpoint-once-then-load (SHOULD).** Adopt Figma's model (F6): when
leaving a dirty live state, capture the pre-jump state **once** (already hash-deduped, so browsing
between *saved* states is a no-op), then load the target. Confirm/tighten that repeated back/forth
between existing snapshots creates **zero** new "Current" snapshots. Never delete later snapshots
(we already don't) — that's the non-destructive guarantee (F1).

**D2. Preview vs commit — skimmer pattern (SHOULD).** The hover tooltip already previews via
SVG/thumbnail (`:3793`). Lean into it: hovering = preview (skimmer), clicking = commit (playhead)
(F3). Optionally a "scrub" mode where dragging along the timeline updates only the preview, and you
commit on release — keeps back/forth instant on big graphs (open question 3).

**D3. Prev/Next step + clear current marker (SHOULD).** Add **keyboard step navigation**
(`[` / `]` or arrow keys) and Fusion-style playback buttons (begin/prev/next/end) to the timeline
(`buildTimeline` `:3869`), cycling snapshots one at a time (Unreal Next/Prev F4; Fusion controls
F2). Strengthen the current-position indicator (`marker-current`/`marker-active` `:3940`) so "where
am I" is obvious.

**D4. "Return to where I was" (NICE).** Remember the snapshot you were on before scrubbing and offer
a one-click jump back (FCP playhead F3; Houdini go-back-and-forth F5). Lightweight: a single
`preScrubSnapshotId` + a "↩ return" affordance.

---

## Suggested sequencing
1. **C1 + C2** (kill wf-switch spam) — small, isolated, immediate relief.
2. **B1** (cosmetic gate) — biggest reduction in autosave noise, low risk.
3. **A1 + A3** (named semantic diffs) — the "what changed" payoff you asked for.
4. **D1 + D3** (non-destructive jump + step nav) — the Fusion-360 feel.
5. **A2, B2/B3, D2, D4** — polish / configurable refinements.

## Risks
- Widget-name mapping (A1) depends on live `_nodes`/`widgets` internals — guard for nodes whose
  widget count ≠ `widgets_values` length and for headless/serialize-only paths.
- The cosmetic gate (B1) must not swallow a *meaningful* change that co-occurs with a move — gate
  only when changes are **exclusively** cosmetic.
- Suppression window (C2) must auto-release even if a load throws (mirror `withRestoreLock` `:1170`).
