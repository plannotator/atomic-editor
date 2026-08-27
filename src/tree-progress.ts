import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { StateEffect, type EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

// Broadcasts that lezer's incremental parser has advanced past where
// it was last observed. Consumers (tables, images, inline-preview)
// watch for this effect and rebuild their decorations so content
// parsed into existence during idle time actually renders.
//
// Needed because:
//  - Our StateField builders only force a bounded prefix of the
//    document at mount (see `decorationTree` below), so for any
//    document longer than that window the tree covers only a prefix
//    of the doc at mount.
//  - StateFields only recompute on transactions. Without a transaction
//    carrying a signal, the background parser can advance all it
//    wants and the decorations never catch up — late tables and
//    images stay as raw `| col |` / `![…](…)` text forever.
//  - The inline-preview ViewPlugin has the same shape: it walks a
//    possibly-partial tree and caches the result.
export const treeGrowthEffect = StateEffect.define<null>();

// ---- parse window policy --------------------------------------------
//
// Every decoration builder (tables, images, inline-preview) gets its
// tree through `decorationTree` so the "how far do we force the parser
// before walking" decision lives in exactly one place and the three
// builders always agree on it. Two cases:
//
//  - `mount` and `selection`: the initial render and cursor/focus
//    driven rebuilds. Only guarantee a bounded prefix, `MOUNT_PARSE_WINDOW`
//    characters or the view's current viewport end, whichever is larger,
//    inside `MOUNT_PARSE_BUDGET_MS`. This is what keeps entering the
//    editor on a large document from paying a synchronous whole-document
//    Lezer parse inside the click. Everything past the window is
//    decorated as the idle loop below grows the tree.
//  - `edit`: a document change. Force the whole document with the
//    historical `EDIT_PARSE_BUDGET_MS` so an edit behaves exactly as it
//    always has; by the time a user types, the idle loop has normally
//    finished and the call short-circuits.
//  - `growth`: a rebuild triggered by `treeGrowthEffect`. Never force;
//    walk whatever the idle tick already parsed, otherwise the first
//    tick would drag the full parse back onto the main thread.

/** Characters the mount-time parse must cover, regardless of viewport. */
export const MOUNT_PARSE_WINDOW = 16_384;

/** Synchronous budget for the mount-time window parse. */
export const MOUNT_PARSE_BUDGET_MS = 20;

/** Synchronous budget for a whole-document parse after a doc change. */
export const EDIT_PARSE_BUDGET_MS = 200;

export type DecorationTreeReason = 'mount' | 'selection' | 'edit' | 'growth';

/**
 * How far the mount-time parse reaches for a document: the fixed
 * window, or the viewport end when the view has scrolled past it,
 * clamped to the document length.
 */
export function mountParseTarget(state: EditorState, viewportTo = 0): number {
  return Math.min(state.doc.length, Math.max(MOUNT_PARSE_WINDOW, viewportTo));
}

/**
 * The syntax tree a decoration builder should walk. See the policy
 * comment above for what each `reason` forces.
 */
export function decorationTree(
  state: EditorState,
  reason: DecorationTreeReason,
  viewportTo = 0,
): Tree {
  switch (reason) {
    case 'growth':
      return syntaxTree(state);
    case 'edit':
      return ensureSyntaxTree(state, state.doc.length, EDIT_PARSE_BUDGET_MS) ?? syntaxTree(state);
    case 'mount':
    case 'selection':
      return (
        ensureSyntaxTree(state, mountParseTarget(state, viewportTo), MOUNT_PARSE_BUDGET_MS) ??
        syntaxTree(state)
      );
  }
}

/**
 * How far the parser has actually reached for this state. `syntaxTree`
 * returns the snapshot the language field took when the state was
 * built; `ensureSyntaxTree` hands back the shared parse context's live
 * tree, and asking it for position 0 with no budget never parses.
 */
export function parsedLength(state: EditorState): number {
  return (ensureSyntaxTree(state, 0, 0) ?? syntaxTree(state)).length;
}

// Each idle tick asks the parser for one bounded segment: from the
// last observed tree length to `lastTreeLen + threshold`, clamped to
// the document. Targeting a bounded position matters because the
// parse context only publishes a new tree when a parse COMPLETES; a
// tick that aims at the whole document and runs out of budget leaves
// the tree exactly where it was, and nothing downstream ever hears
// about the progress. Aiming at a segment the budget can finish means
// every tick lands a longer tree and dispatches one rebuild for it.
//
// The segment size is adaptive: 8KB (roughly two viewport-heights, so
// the region just past the mount window fills in within one or two
// ticks) doubling after every dispatched rebuild up to 64KB, reset on
// every doc change. A 300KB document therefore costs about eight
// whole-tree rebuilds rather than one per 8KB, and never a single
// late rebuild at the very end.
export const INITIAL_GROWTH_THRESHOLD = 8192;
export const MAX_GROWTH_THRESHOLD = 65_536;

// Budget per idle tick: short enough to keep the main thread
// responsive, long enough to finish a segment. rIC/rAF fire at 16ms+,
// so 30ms is "push a bit past one frame" rather than "steal a whole
// frame." A segment the budget cannot finish is simply retried by the
// next tick; the parser keeps its fragments, so no work is lost.
const TICK_BUDGET_MS = 30;

// Every document longer than the mount window depends on this loop to
// get decorated, so a starved `requestIdleCallback` on a busy host
// would mean visibly raw content. The timeout forces the tick to run
// after 400ms even when the browser never reports idle time, the same
// bound CodeMirror's own parse worker uses.
const IDLE_TIMEOUT_MS = 400;

type IdleHandle = { kind: 'idle'; id: number } | { kind: 'raf'; id: number };

function scheduleIdle(cb: () => void): IdleHandle {
  if (typeof window.requestIdleCallback === 'function') {
    return {
      kind: 'idle',
      id: window.requestIdleCallback(() => cb(), { timeout: IDLE_TIMEOUT_MS }),
    };
  }
  return { kind: 'raf', id: window.requestAnimationFrame(() => cb()) };
}

function cancelIdle(handle: IdleHandle): void {
  if (handle.kind === 'idle' && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle.id);
  } else if (handle.kind === 'raf') {
    window.cancelAnimationFrame(handle.id);
  }
}

/**
 * View plugin that grows lezer's tree one bounded segment per idle
 * tick and dispatches a `treeGrowthEffect` after each completed
 * segment so downstream decoration builders re-run. Include this in
 * your extension set alongside the state fields that depend on tree
 * coverage; it is a no-op for documents the mount window already
 * covers.
 */
// TS caveat: ViewPlugin.fromClass takes an anonymous class, and
// tsc's declaration emit (for the exported plugin constant) rejects
// `private` / `protected` / `readonly` modifiers on its members
// ("property may not be private or protected on an exported
// anonymous class type"). Underscore prefix keeps the "don't touch"
// convention without tripping that check.
export const treeProgressPlugin = ViewPlugin.fromClass(
  class {
    view: EditorView;
    _lastTreeLen: number;
    _threshold = INITIAL_GROWTH_THRESHOLD;
    _idleHandle: IdleHandle | null = null;
    _destroyed = false;

    constructor(view: EditorView) {
      this.view = view;
      this._lastTreeLen = parsedLength(view.state);
      this._schedule();
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        // Doc edits invalidate everything we knew about tree length;
        // lezer re-parses from the edit point. Reset and kick the
        // loop so new content gets picked up.
        this._lastTreeLen = parsedLength(update.state);
        this._threshold = INITIAL_GROWTH_THRESHOLD;
        this._schedule();
      }
    }

    destroy() {
      this._destroyed = true;
      if (this._idleHandle !== null) {
        cancelIdle(this._idleHandle);
        this._idleHandle = null;
      }
    }

    _schedule() {
      if (this._idleHandle !== null) return;
      this._idleHandle = scheduleIdle(() => {
        this._idleHandle = null;
        if (!this._destroyed) this._tick();
      });
    }

    _tick() {
      const state = this.view.state;
      const docLen = state.doc.length;
      if (this._lastTreeLen >= docLen) return;

      // One segment per tick. `ensureSyntaxTree` returns null when the
      // budget expires before the target; the tree is then unchanged
      // and the next tick retries the same segment.
      const target = Math.min(docLen, this._lastTreeLen + this._threshold);
      const ensured = ensureSyntaxTree(state, target, TICK_BUDGET_MS);
      const newLen = ensured ? ensured.length : this._lastTreeLen;

      if (newLen > this._lastTreeLen) {
        const previous = this._lastTreeLen;
        this._lastTreeLen = newLen;
        this._threshold = Math.min(this._threshold * 2, MAX_GROWTH_THRESHOLD);
        try {
          this.view.dispatch({ effects: treeGrowthEffect.of(null) });
        } catch {
          // View destroyed mid-flight; revert the baseline so a
          // subsequent tick (if any) still has something to report.
          this._lastTreeLen = previous;
          return;
        }
      }

      if (newLen < docLen) this._schedule();
    }
  },
);
