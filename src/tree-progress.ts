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

// How much must the parsed range grow before we dispatch a rebuild
// effect. A too-small threshold means a storm of tiny rebuilds while
// the parser chews through the doc; too large means the user might
// scroll past an unparsed region before it catches up. 8KB is roughly
// two viewport-heights of text and reliably contains several table/
// image blocks in our sample content. The threshold is adaptive: it
// starts here and doubles after every dispatched rebuild, up to
// `MAX_GROWTH_THRESHOLD`, so the region just past the mount window
// fills in quickly while a 300KB document costs a handful of
// whole-tree rebuilds rather than dozens.
export const INITIAL_GROWTH_THRESHOLD = 8192;
export const MAX_GROWTH_THRESHOLD = 65_536;

// Budget per idle tick — short enough to keep the main thread
// responsive, long enough to make real progress. rIC/rAF fire at
// 16ms+, so 30ms is "push a bit past one frame" rather than "steal a
// whole frame."
const TICK_BUDGET_MS = 30;

type IdleHandle = { kind: 'idle'; id: number } | { kind: 'raf'; id: number };

function scheduleIdle(cb: () => void): IdleHandle {
  if (typeof window.requestIdleCallback === 'function') {
    return { kind: 'idle', id: window.requestIdleCallback(() => cb()) };
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
 * View plugin that monitors lezer's parse progress and dispatches a
 * `treeGrowthEffect` whenever the tree has grown enough that
 * downstream decoration builders should re-run. Include this in your
 * extension set alongside the state fields that depend on tree
 * coverage — it's a no-op for small docs where the initial parse
 * already covers everything.
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
      this._lastTreeLen = syntaxTree(view.state).length;
      this._schedule();
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        // Doc edits invalidate everything we knew about tree length;
        // lezer re-parses from the edit point. Reset and kick the
        // loop so new content gets picked up.
        this._lastTreeLen = syntaxTree(update.state).length;
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

      // Push the parser further. `ensureSyntaxTree` returns null if
      // the budget expires before reaching the target — in that case
      // we still want to read whatever progress was made.
      const ensured = ensureSyntaxTree(state, docLen, TICK_BUDGET_MS);
      const newLen = (ensured ?? syntaxTree(state)).length;

      if (newLen >= this._lastTreeLen + this._threshold || newLen >= docLen) {
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
