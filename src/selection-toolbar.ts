import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  ViewPlugin,
  keymap,
  showTooltip,
  type Command,
  type Tooltip,
  type TooltipView,
} from '@codemirror/view';
import { cellFormatting } from './cell-formatting';
import { buildToolbarButtons, toolbarChromeTheme } from './toolbar-chrome';
import {
  getActiveFormats,
  inlineFormattingAllowed,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleLink,
  toggleStrikethrough,
  type InlineFormat,
} from './formatting-commands';

// Selection toolbar — a floating formatting bar that appears above a
// non-empty selection (the "bubble menu" pattern). It is intentionally
// thin: all of the "what does this selection allow / what is already
// applied / how do I toggle it" logic lives in `formatting-commands.ts`,
// so this module only owns *when to show the bar* and *how it looks*.
//
// Positioning is delegated to CM6's `showTooltip` facet rather than
// hand-rolled — the facet tracks the anchor through scrolling and flips
// the bar below the selection when it would clip the top of the
// viewport, which is fiddly to reproduce correctly by hand.

export interface SelectionToolbarConfig {
  /**
   * Which buttons to show, in display order. Defaults to all five:
   * `['bold', 'italic', 'strikethrough', 'code', 'link']`.
   */
  buttons?: readonly InlineFormat[];
}

const DEFAULT_BUTTONS: readonly InlineFormat[] = ['bold', 'italic', 'strikethrough', 'code', 'link'];

// The toggle command run when a button is clicked. Each is a no-op when
// the current selection refuses the format, so wiring them directly is
// safe even though the bar only renders when formatting is allowed. This
// stays here (not in the shared chrome) because it is the main bar's own
// click behaviour — the in-cell bar rewrites the cell's raw string
// instead.
const BUTTON_COMMANDS: Record<InlineFormat, Command> = {
  bold: toggleBold,
  italic: toggleItalic,
  strikethrough: toggleStrikethrough,
  code: toggleInlineCode,
  link: toggleLink,
};

// Toggle every one of these, regardless of which buttons render. The
// keymap is a productivity affordance independent of the visible bar;
// the commands themselves refuse where formatting is disallowed.
const TOOLBAR_KEYMAP = [
  { key: 'Mod-b', run: toggleBold },
  { key: 'Mod-i', run: toggleItalic },
  { key: 'Mod-Shift-x', run: toggleStrikethrough },
  { key: 'Mod-e', run: toggleInlineCode },
  { key: 'Mod-k', run: toggleLink },
];

// Flips the toolbar off during pointer drags and IME composition. The
// bar's own field consumes this effect, so a suppression change is just
// another transaction the field recomputes on (see `buildTooltip`).
const setSuppressed = StateEffect.define<boolean>();

// Combined state: the current suppression flag plus the derived
// tooltip. Bundling them means the tooltip is recomputed on exactly the
// transactions that can change it — a selection/doc edit OR a
// suppression flip — without one field having to read across into
// another, which would be order-sensitive.
interface ToolbarState {
  suppressed: boolean;
  tooltip: Tooltip | null;
}

/**
 * A floating formatting toolbar shown above the active selection. Bundles
 * the tooltip state (fed to CM6's `showTooltip` facet), a suppression
 * plugin (hides the bar mid-drag and during IME composition), the
 * formatting keymap (`Mod-b`/`Mod-i`/`Mod-Shift-x`/`Mod-e`/`Mod-k`), and
 * the dark-fallback base theme. Consumers restyle it via the
 * `--atomic-editor-*` CSS variables.
 */
export function selectionToolbar(config: SelectionToolbarConfig = {}): Extension {
  const buttons = config.buttons ?? DEFAULT_BUTTONS;

  // CM6 reuses a tooltip's DOM only when the `create` function is
  // identical between recomputes (it compares by reference). One stable
  // closure per extension instance means moving the selection repositions
  // the existing bar instead of tearing it down and rebuilding it.
  const create = (view: EditorView): TooltipView => createToolbarView(view, buttons);

  const field = StateField.define<ToolbarState>({
    create(state) {
      return { suppressed: false, tooltip: buildTooltip(state, false, create) };
    },
    update(value, transaction) {
      let suppressed = value.suppressed;
      let suppressionChanged = false;
      for (const effect of transaction.effects) {
        if (!effect.is(setSuppressed)) continue;
        if (effect.value !== suppressed) suppressionChanged = true;
        suppressed = effect.value;
      }

      // A StateField's `update` sees every transaction, so recompute on
      // any input that can change eligibility: the selection moved, the
      // doc changed (shifting positions / block context), or a
      // suppression flip arrived. Otherwise reuse the prior tooltip.
      if (transaction.selection || transaction.docChanged || suppressionChanged) {
        return { suppressed, tooltip: buildTooltip(transaction.state, suppressed, create) };
      }
      return value;
    },
    provide: (fieldValue) => showTooltip.from(fieldValue, (value) => value.tooltip),
  });

  // The in-cell bar covers the world the tooltip field can't see: DOM
  // selections inside a table cell's contenteditable (which never reach
  // CM's selection state). It shares this config's button list and
  // filters to the cell-eligible subset itself.
  return [
    field,
    suppressionPlugin,
    keymap.of(TOOLBAR_KEYMAP),
    toolbarChromeTheme,
    cellFormatting(buttons),
  ];
}

// The tooltip exists iff the selection is a single, non-empty range that
// permits inline formatting AND we are not suppressed.
// `inlineFormattingAllowed` already enforces single-range and that at
// least one line can be formatted — a multi-line selection now shows the
// bar (its lines are toggled individually), so nothing here filters on
// line count. The extra `!empty` guard keeps the bar off a bare cursor,
// and the explicit range-count check matches the spec.
function buildTooltip(
  state: EditorState,
  suppressed: boolean,
  create: (view: EditorView) => TooltipView,
): Tooltip | null {
  if (suppressed) return null;
  const main = state.selection.main;
  if (main.empty || state.selection.ranges.length !== 1) return null;
  if (!inlineFormattingAllowed(state)) return null;

  return {
    pos: main.from,
    end: main.to,
    above: true,
    create,
  };
}

// Builds the toolbar DOM and its live-update logic. Returns a
// `TooltipView` whose `update` re-syncs the active state each time the
// editor state changes (including right after a button's own toggle).
function createToolbarView(view: EditorView, buttons: readonly InlineFormat[]): TooltipView {
  const dom = document.createElement('div');
  dom.className = 'cm-atomic-selection-toolbar';

  // The shared builder owns button/separator DOM, icons, and aria; the
  // main bar supplies its CM-command click path here.
  const entries = buildToolbarButtons(dom, buttons, (format) => {
    BUTTON_COMMANDS[format](view);
  });

  const sync = (state: EditorState): void => {
    const active = getActiveFormats(state);
    const main = state.selection.main;
    // A multi-line link is refused (a link per line surprises the user),
    // so disable — not hide — the link button for a multi-line selection:
    // hiding would reflow the bar's width as the selection grows a line.
    const multiline = state.doc.lineAt(main.from).number !== state.doc.lineAt(main.to).number;
    for (const entry of entries) {
      entry.button.classList.toggle('cm-atomic-selection-toolbar-active', active.has(entry.format));
      entry.button.disabled = entry.format === 'link' && multiline;
    }
  };

  sync(view.state);

  return {
    dom,
    update(update) {
      sync(update.state);
    },
  };
}

// Drives the suppression effect. Mirrors `freezeMousePlugin` in
// `inline-preview.ts`: a capture-phase pointerdown on `view.dom` (so we
// win the order race against CM6's own selection handler) that only
// engages when the press lands inside the content, plus window-level
// pointerup/pointercancel because the release can happen outside the
// editor after a drag.
//
// The window release listeners are CAPTURE phase, not bubble. Suppression
// is a global latch: once a drag sets it, ONLY a release event clears it,
// so that release must reach us no matter where the pointer is let go.
// A bubble-phase window listener is the LAST thing an event reaches, so
// any ancestor between the release target and `window` that stops
// propagation permanently strands the latch — the toolbar then never
// returns after the drag. Block widgets do exactly this: they are
// self-contained editing islands whose DOM legitimately stops pointer
// events from escaping (the table cell already does so for
// pointerdown/click, and the fork's frontmatter widget is another such
// island), and host apps commonly wrap the editor in drag/modal layers
// that swallow pointerup. Capture phase runs window→target BEFORE any
// descendant handler, so it fires regardless of who stops bubbling —
// the latch always clears on release. This is generic: nothing here
// knows about tables or any specific widget.
//
// IME composition is handled through compositionstart/compositionend on
// the content DOM — those fire outside CM6's update cycle, so dispatching
// from them is safe (unlike dispatching from a ViewPlugin `update`).
const suppressionPlugin = ViewPlugin.fromClass(
  class {
    private dragging = false;
    private composing = false;
    private suppressed = false;

    private readonly onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Node) || !this.view.contentDOM.contains(target)) return;
      this.dragging = true;
      this.sync();
    };

    private readonly onUp = (): void => {
      if (!this.dragging) return;
      this.dragging = false;
      this.sync();
    };

    private readonly onCompositionStart = (): void => {
      this.composing = true;
      this.sync();
    };

    private readonly onCompositionEnd = (): void => {
      this.composing = false;
      this.sync();
    };

    constructor(readonly view: EditorView) {
      view.dom.addEventListener('pointerdown', this.onDown, true);
      view.contentDOM.addEventListener('compositionstart', this.onCompositionStart);
      view.contentDOM.addEventListener('compositionend', this.onCompositionEnd);
      // Capture phase (see the block comment above): the release must
      // clear the latch even when a widget or host wrapper stops the
      // event's propagation before it would bubble to `window`.
      window.addEventListener('pointerup', this.onUp, true);
      window.addEventListener('pointercancel', this.onUp, true);
    }

    destroy(): void {
      this.view.dom.removeEventListener('pointerdown', this.onDown, true);
      this.view.contentDOM.removeEventListener('compositionstart', this.onCompositionStart);
      this.view.contentDOM.removeEventListener('compositionend', this.onCompositionEnd);
      window.removeEventListener('pointerup', this.onUp, true);
      window.removeEventListener('pointercancel', this.onUp, true);
    }

    // Suppress while either a drag or an IME session is active. Dispatch
    // only on an actual change so we don't spam no-op transactions.
    private sync(): void {
      const next = this.dragging || this.composing;
      if (next === this.suppressed) return;
      this.suppressed = next;
      this.view.dispatch({ effects: setSuppressed.of(next) });
    }
  },
);
