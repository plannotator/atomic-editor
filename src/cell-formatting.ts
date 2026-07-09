import { type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type PluginValue } from '@codemirror/view';
import { buildToolbarButtons } from './toolbar-chrome';
import {
  getSelectionCharRange,
  setSelectionCharRange,
  updateCellRaw,
} from './table-widget';

// In-cell formatting for the table widget's contenteditable cells.
//
// A table cell is NOT part of CM6's document text — it is a widget's own
// contenteditable, whose raw markdown lives in `dataset.raw` and is
// re-serialized into the table's source range on every edit. So the main
// `selectionToolbar` (which reasons over the lezer tree and the document
// selection) can't touch a cell. This module is the parallel bar for that
// world: it toggles `**`/`*`/`~~` on a DOM selection inside one cell by
// rewriting the cell's raw string and pushing it back through
// `updateCellRaw`.
//
// The formats are the subset the cell renderer knows how to draw — no
// code (a backtick's `|` would break row parsing) and no link (a bare
// wrap can't invent a URL), matching the cell parser in `table-widget.ts`.

export type CellFormat = 'bold' | 'italic' | 'strikethrough';

const CELL_FORMATS: readonly CellFormat[] = ['bold', 'italic', 'strikethrough'];

// ---- span scanner ---------------------------------------------------

// A formatted (or link) span with ABSOLUTE offsets into the raw string:
// `[from, to)` covers the delimiters too, `[contentFrom, contentTo)` is
// the inner text between them.
interface CellSpan {
  format: CellFormat | 'link';
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
}

// !! KEEP IN SYNC WITH `matchCellMarkAt` in table-widget.ts !!
//
// This scanner deliberately DUPLICATES the cell parser's delimiter rules
// (the same regexes, the same bold→strike→link→em-star→em-underscore
// precedence, the same backslash-escape skipping, the same "`_` is not
// intra-word emphasis" guard). It does not call `parseCellInline`, and
// that is on purpose: `parseCellInline` strips escapes and keeps NO byte
// offsets, so the tokens it emits can't tell us WHERE a `**` lives. The
// toggle math needs exact offsets. Making the upstream parser
// position-aware would swell a file we merge from upstream; a small,
// clearly-marked mirror here keeps that file a clean delta. Any change to
// `matchCellMarkAt`'s rules MUST be echoed here (the parser-consistency
// tests in cell-formatting.test.ts are the tripwire).
//
// One faithful subtlety: `parseCellInline` recurses on the SUBSTRING of a
// mark's content, so inside a nested span the "char before" test for the
// `_` rule sees an empty string at the content's first byte. We scan the
// full raw with a `[start, end)` window instead of slicing, so we must
// reproduce that by treating `prev` as empty at the window start
// (`from > start`), not merely at raw index 0. Using the true previous
// byte would diverge on inputs like `___y_z__`, where the renderer emits
// an inner em but a naive `raw[from - 1]` check would suppress it.
function scanCellSpans(raw: string): CellSpan[] {
  const spans: CellSpan[] = [];

  const scan = (start: number, end: number): void => {
    let i = start;
    while (i < end) {
      // Backslash escape: the next byte is literal and can't open a mark.
      // Bounded to the window end (`i + 1 < end`) exactly as recursing on
      // the substring would bound it.
      if (raw[i] === '\\' && i + 1 < end && /[!-/:-@[-`{-~]/.test(raw[i + 1])) {
        i += 2;
        continue;
      }
      const span = matchSpanAt(raw, i, start, end);
      if (span) {
        spans.push(span);
        // Recurse into the content window so nested marks (bold-in-italic,
        // a mark inside link text) are recorded with raw-absolute offsets.
        scan(span.contentFrom, span.contentTo);
        i = span.to;
        continue;
      }
      i++;
    }
  };

  scan(0, raw.length);
  return spans;
}

function makeSpan(
  format: CellFormat | 'link',
  from: number,
  to: number,
  contentFrom: number,
  contentTo: number,
): CellSpan {
  return { format, from, to, contentFrom, contentTo };
}

// Mirror of `matchCellMarkAt`, but returns offsets instead of a token.
// `start` is the enclosing window's start (for the `_` prev-char rule);
// `end` bounds the closer so a lazy match can't reach past the content.
function matchSpanAt(raw: string, from: number, start: number, end: number): CellSpan | null {
  const rest = raw.slice(from, end);

  // Bold `**` / `__`.
  let m = rest.match(/^\*\*([\s\S]+?)\*\*/);
  if (m) return makeSpan('bold', from, from + m[0].length, from + 2, from + m[0].length - 2);
  m = rest.match(/^__([\s\S]+?)__/);
  if (m) return makeSpan('bold', from, from + m[0].length, from + 2, from + m[0].length - 2);

  // Strikethrough `~~`.
  m = rest.match(/^~~([\s\S]+?)~~/);
  if (m) {
    return makeSpan('strikethrough', from, from + m[0].length, from + 2, from + m[0].length - 2);
  }

  // Link `[text](url)` — content window is the text field only.
  m = rest.match(/^\[([^\]\n]+)\]\(([^\s)"'\n]+)\)/);
  if (m) return makeSpan('link', from, from + m[0].length, from + 1, from + 1 + m[1].length);

  // Italic `*`.
  m = rest.match(/^\*([^*\n]+?)\*/);
  if (m) return makeSpan('italic', from, from + m[0].length, from + 1, from + m[0].length - 1);

  // Italic `_`, unless the previous byte is a word char (avoids
  // `snake_case`). Empty at the window start — see the header note.
  const prev = from > start ? raw[from - 1] : '';
  if (!/\w/.test(prev)) {
    m = rest.match(/^_([^_\n]+?)_/);
    if (m) return makeSpan('italic', from, from + m[0].length, from + 1, from + m[0].length - 1);
  }

  return null;
}

// ---- toggle math ----------------------------------------------------

// The canonical delimiter this package writes for each format (matching
// `formatting-commands.ts`: `*` for italic since `_` won't toggle
// intra-word, `**` for bold, `~~` for strike).
const DELIMITER: Record<CellFormat, string> = {
  bold: '**',
  italic: '*',
  strikethrough: '~~',
};

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * Toggle `format` over `[from, to]` in a cell's raw markdown, returning
 * the rewritten raw and the selection that should cover the same content
 * afterwards — or `null` when the toggle refuses.
 *
 * Pure and byte-exact: it never re-serializes or normalizes surrounding
 * bytes, only inserts or deletes the exact delimiter bytes it owns. This
 * is the cell-scoped analogue of `applyFormat`, but where that reasons
 * over a lezer tree this reasons over the same forgiving delimiter-pair
 * rules the cell renderer uses (see `scanCellSpans`).
 */
export function toggleCellRaw(
  raw: string,
  from: number,
  to: number,
  format: CellFormat,
): { raw: string; from: number; to: number } | null {
  // Trim whitespace off the range so delimiters hug content (`** x **` is
  // not emphasis). A whitespace-only or empty selection has nothing to
  // mark, and v1 does NOT insert an empty marker pair inside a cell.
  let tf = from;
  let tt = to;
  while (tf < tt && isWhitespace(raw[tf])) tf++;
  while (tt > tf && isWhitespace(raw[tt - 1])) tt--;
  if (tf >= tt) return null;

  const spans = scanCellSpans(raw);

  // UNWRAP: a same-format span that fully encloses the trimmed range
  // (delimiters included) toggles OFF. Innermost (narrowest) such span
  // wins — matters for same-format nesting.
  const enclosing = spans
    .filter((s) => s.format === format && s.from <= tf && tt <= s.to)
    .sort((a, b) => a.to - a.from - (b.to - b.from));
  if (enclosing.length > 0) {
    const span = enclosing[0];
    const openLen = span.contentFrom - span.from;
    const newRaw =
      raw.slice(0, span.from) + raw.slice(span.contentFrom, span.contentTo) + raw.slice(span.to);
    // The content now sits at [span.from, span.from + contentLen). Shift
    // the ORIGINAL selection left by the deleted opener and clamp it into
    // that content so a second toggle round-trips byte-exact.
    const contentLen = span.contentTo - span.contentFrom;
    const lo = span.from;
    const hi = span.from + contentLen;
    return {
      raw: newRaw,
      from: clamp(from - openLen, lo, hi),
      to: clamp(to - openLen, lo, hi),
    };
  }

  // WRAP branch — refuse anything the cell parser would mis-pair.
  for (const span of spans) {
    // Any span (link included) that strictly crosses exactly one endpoint
    // would have our new delimiter split its pair. A span enclosing BOTH
    // endpoints (nesting) is fine; one fully inside is fine.
    const crossesFrom = span.from < tf && tf < span.to;
    const crossesTo = span.from < tt && tt < span.to;
    if (crossesFrom !== crossesTo) return null;
    // A same-format span that merely touches or intersects the range
    // (e.g. `**a**b` selecting `b`) yields adjacent doubled delimiters
    // that parse unpredictably.
    if (span.format === format && span.from <= tt && span.to >= tf) return null;
  }

  const content = raw.slice(tf, tt);
  // Content bytes that would break the wrap under the parser's lazy
  // matching: a `**` inside a bold wrap closes it early, ANY `*` inside an
  // italic wrap does, a `~~` inside a strike wrap does. Raw bytes, not
  // escape-processed — the cell em regex `[^*\n]+?` excludes `*` entirely,
  // so a `\*` in the content is still a literal `*` byte that breaks the
  // pair (pinned by the `a\*b` test).
  if (format === 'bold' && content.includes('**')) return null;
  if (format === 'italic' && content.includes('*')) return null;
  if (format === 'strikethrough' && content.includes('~~')) return null;

  // A loose delimiter char immediately adjacent to the range could pair
  // with the one we're about to write.
  const before = tf > 0 ? raw[tf - 1] : '';
  const after = tt < raw.length ? raw[tt] : '';
  const loose = format === 'strikethrough' ? '~' : '*';
  if (before === loose || after === loose) return null;

  const delim = DELIMITER[format];
  const newRaw = raw.slice(0, tf) + delim + content + delim + raw.slice(tt);
  // Select the content (delimiters hug it on the outside) so toggling the
  // same format twice round-trips to the original raw + selection.
  return { raw: newRaw, from: tf + delim.length, to: tt + delim.length };
}

/**
 * The cell formats whose span encloses `[from, to]`, per the same scanner
 * `toggleCellRaw` uses. Drives the in-cell bar's active-button state.
 */
export function activeCellFormats(raw: string, from: number, to: number): Set<CellFormat> {
  const active = new Set<CellFormat>();
  for (const span of scanCellSpans(raw)) {
    if (span.format === 'link') continue;
    if (span.from <= from && to <= span.to) active.add(span.format);
  }
  return active;
}

// ---- the floating in-cell bar --------------------------------------

// Walk up from a selection endpoint to the cell source that contains it.
function closestCellSource(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return el?.closest<HTMLElement>('.cm-atomic-table-cell-source') ?? null;
}

// The single cell source that fully contains a non-collapsed selection,
// or null when the selection is collapsed, spans two cells, or lands
// outside a cell / outside this view.
function selectionCellSource(root: HTMLElement, selection: Selection): HTMLElement | null {
  const anchor = closestCellSource(selection.anchorNode);
  const focus = closestCellSource(selection.focusNode);
  if (!anchor || anchor !== focus) return null;
  if (!root.contains(anchor)) return null;
  return anchor;
}

class CellFormattingBar implements PluginValue {
  private bar: HTMLDivElement | null = null;
  private readonly entries: { format: CellFormat; button: HTMLButtonElement }[] = [];
  private source: HTMLElement | null = null;

  // The DOM selection inside a widget's contenteditable is invisible to
  // CM6's own update cycle, so we listen to the document's native
  // `selectionchange` — the only signal that fires when the user drags a
  // selection inside a cell.
  private readonly onSelectionChange = (): void => this.refresh();
  private readonly onScroll = (): void => {
    if (this.bar && this.source) this.reposition();
  };

  constructor(
    private readonly view: EditorView,
    private readonly formats: readonly CellFormat[],
  ) {
    if (this.formats.length === 0) return; // no eligible buttons → inert
    this.view.dom.ownerDocument.addEventListener('selectionchange', this.onSelectionChange);
    this.view.scrollDOM.addEventListener('scroll', this.onScroll);
  }

  destroy(): void {
    this.view.dom.ownerDocument.removeEventListener('selectionchange', this.onSelectionChange);
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.bar?.remove();
    this.bar = null;
    this.source = null;
  }

  // Recompute from the live DOM selection: show + position + sync when the
  // selection is a non-collapsed range inside one cell, hide otherwise.
  private refresh(): void {
    if (this.formats.length === 0) return;
    const selection = this.view.dom.ownerDocument.defaultView?.getSelection();
    if (!selection || selection.rangeCount === 0) return this.hide();
    const source = selectionCellSource(this.view.dom, selection);
    if (!source) return this.hide();
    const range = getSelectionCharRange(source);
    if (!range || range.from === range.to) return this.hide();

    this.source = source;
    this.ensureBar();
    this.syncActive(source, range);
    this.reposition();
  }

  private hide(): void {
    this.source = null;
    if (this.bar) this.bar.style.display = 'none';
  }

  private ensureBar(): void {
    if (this.bar) {
      this.bar.style.display = 'flex';
      return;
    }
    const bar = document.createElement('div');
    // Same chrome classes as the main bar (visual styling is shared); the
    // `-cell` class only adds absolute-positioning basics in this module's
    // baseTheme.
    bar.className = 'cm-tooltip cm-atomic-selection-toolbar cm-atomic-selection-toolbar-cell';
    bar.style.position = 'absolute';

    // Identical chrome to the main bar (icons, aria, the selection-
    // preserving pointerdown) via the shared builder; the cell bar
    // supplies its own raw-rewriting click path. Only text-style formats
    // reach here, so the builder never emits a separator.
    this.entries.push(...buildToolbarButtons(bar, this.formats, (format) => this.apply(format)));

    this.view.dom.appendChild(bar);
    this.bar = bar;
  }

  private apply(format: CellFormat): void {
    const source = this.source;
    if (!source) return;
    const cell = source.closest<HTMLElement>('th, td');
    if (!cell) return;
    const range = getSelectionCharRange(source);
    if (!range) return;
    const result = toggleCellRaw(source.textContent ?? '', range.from, range.to, format);
    if (!result) return; // refused — leave the cell untouched
    updateCellRaw(this.view, cell, result.raw);
    // `updateCellRaw` re-rendered the source (destroying the selection);
    // restore it over the new decorated DOM, then re-sync the bar.
    setSelectionCharRange(source, result.from, result.to);
    this.refresh();
  }

  private syncActive(source: HTMLElement, range: { from: number; to: number }): void {
    const active = activeCellFormats(source.textContent ?? '', range.from, range.to);
    for (const entry of this.entries) {
      entry.button.classList.toggle(
        'cm-atomic-selection-toolbar-active',
        active.has(entry.format),
      );
    }
  }

  // Place the bar above the selection rect, in coordinates relative to
  // `view.dom`, flipping below the selection when above would poke past
  // the editor's top edge (see `cellBarTop`). happy-dom returns zeroed
  // rects (no layout), which is fine: the bar lands near the editor
  // origin in tests and we only guard against NaN so nothing throws.
  private reposition(): void {
    if (!this.bar) return;
    const selection = this.view.dom.ownerDocument.defaultView?.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const host = this.view.dom.getBoundingClientRect();
    let left = rect.left - host.left + this.view.dom.scrollLeft;
    let top =
      cellBarTop(rect.top, rect.bottom, host.top, this.bar.offsetHeight) + this.view.dom.scrollTop;
    if (!Number.isFinite(left)) left = 0;
    if (!Number.isFinite(top)) top = 0;
    this.bar.style.left = `${Math.max(0, left)}px`;
    this.bar.style.top = `${Math.max(0, top)}px`;
  }
}

/**
 * The bar's `top` within the host element: above the selection when it
 * fits, flipped below when placing it above would poke past the host's
 * top edge (the previous clamp-to-zero parked the bar OVER the first
 * table row's selection instead of dodging it). Pure — exported for
 * tests. Mirrors the main bar's flip-below behavior (which CM6 does for
 * us there via the clamped `tooltipSpace`).
 */
export function cellBarTop(
  rectTop: number,
  rectBottom: number,
  hostTop: number,
  barHeight: number,
  gap = 6,
): number {
  const above = rectTop - hostTop - barHeight - gap;
  return above >= 0 ? above : rectBottom - hostTop + gap;
}

// Positioning basics only — all visual chrome comes from the shared
// `.cm-atomic-selection-toolbar*` classes (declared in
// `selection-toolbar.ts`'s baseTheme).
const cellBarTheme = EditorView.baseTheme({
  '.cm-atomic-selection-toolbar-cell': {
    position: 'absolute',
    zIndex: '20',
  },
});

/**
 * The floating in-cell formatting bar. `buttons` is the host's configured
 * button list; only the cell-eligible subset (`bold`, `italic`,
 * `strikethrough`) renders — an empty intersection makes the plugin
 * inert. The lead wires this into `selectionToolbar()` alongside the main
 * bar.
 */
export function cellFormatting(buttons: readonly string[]): Extension {
  const formats = buttons.filter((b): b is CellFormat =>
    (CELL_FORMATS as readonly string[]).includes(b),
  );
  return [ViewPlugin.define((view) => new CellFormattingBar(view, formats)), cellBarTheme];
}
