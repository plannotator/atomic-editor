import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  Facet,
  Prec,
  StateField,
  Transaction,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  type DecorationSet,
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { treeGrowthEffect, treeProgressPlugin } from './tree-progress';

// GFM tables as a WYSIWYG block widget.
//
// Strategy: replace the entire Table node in the source with a block
// Decoration.replace widget. The widget renders an HTML `<table>`
// whose `<th>` / `<td>` cells are `contenteditable`. Editing flows
// DOM → source: on every cell `input` event we re-serialize the
// widget's DOM state to markdown and dispatch a single change that
// replaces the table's current source range. Source → DOM is handled
// by the StateField rebuilding a widget from the parsed tree, but
// crucially our widget's `eq` is structure-only: same row/col count
// returns true, so CM6 keeps the existing DOM across keystrokes and
// the caret / focus survive.
//
// Tab / Shift-Tab move focus between cells. Tab past the last cell
// appends a new row and focuses its first cell. Backspace/Delete
// inside a cell uses browser default (per-char). Outside the widget
// (at the table's atomic boundary), CM6's atomic-range handling
// deletes the whole table as one unit — matching Obsidian's "table
// is a unit" feel.
//
// Scope cuts deliberately left out of v1:
//   - Column alignment (`:---`, `---:`, `:---:`) — parsed but dropped;
//     all cells render left-aligned.
//   - Rich content inside cells (markdown marks, links, etc.).
//   - Context-menu operations (add/remove row/column, sort).
//   - Multi-line cell content.
// These are incremental, non-architectural adds; they can land later
// without changing the widget's core shape.

// ---- model / parse / serialize --------------------------------------

interface TableModel {
  header: string[];
  rows: string[][];
}

function collectCells(state: EditorState, rowNode: SyntaxNode): string[] {
  // Split the row's raw line on unescaped `|` rather than collecting
  // lezer `TableCell` nodes. lezer emits NO `TableCell` for an empty
  // cell, so a node-based count silently drops blank columns — which
  // is exactly what "Insert column left/right" creates. Counting cells
  // from the pipe-delimited text keeps blank columns (and their
  // positions) intact through the parse → serialize round-trip.
  return splitRowCells(state.doc.lineAt(rowNode.from).text);
}

export function splitRowCells(line: string): string[] {
  let s = line.trim();
  // Strip the optional outer pipes so they don't yield phantom empty
  // leading/trailing cells.
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);

  const cells: string[] = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // A backslash escapes the next char (e.g. `\|` is a literal pipe in
    // a GFM cell) — keep both and don't treat the pipe as a separator.
    if (ch === '\\' && i + 1 < s.length) {
      buf += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

function parseTable(state: EditorState, tableNode: SyntaxNode): TableModel | null {
  const header: string[] = [];
  const rows: string[][] = [];

  const cursor = tableNode.cursor();
  if (!cursor.firstChild()) return null;

  do {
    if (cursor.name === 'TableHeader') {
      header.push(...collectCells(state, cursor.node));
    } else if (cursor.name === 'TableRow') {
      rows.push(collectCells(state, cursor.node));
    }
    // TableDelimiter (per-row `|` and whole-line `|---|---|`) is ignored.
  } while (cursor.nextSibling());

  if (header.length === 0) return null;
  return { header, rows };
}

// Escape cell content so it can't break the row's GFM structure: an
// unescaped `|` would split the cell into two columns, and a stray
// newline would terminate the table. A pipe that's already escaped
// (`\|` — e.g. round-tripping content the parser handed us) is left
// alone so serialize is idempotent.
function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|');
}

export function serializeTable(model: TableModel): string {
  const columnCount = model.header.length;
  const lines: string[] = [];
  lines.push('| ' + model.header.map(escapeCell).join(' | ') + ' |');
  lines.push('| ' + model.header.map(() => '---').join(' | ') + ' |');
  for (const row of model.rows) {
    const padded: string[] = [];
    for (let c = 0; c < columnCount; c++) padded.push(escapeCell(row[c] ?? ''));
    lines.push('| ' + padded.join(' | ') + ' |');
  }
  return lines.join('\n');
}

function readModelFromDom(wrap: HTMLElement): TableModel {
  const header = Array.from(wrap.querySelectorAll<HTMLElement>('thead th')).map(
    readCellSource,
  );
  const rows = Array.from(wrap.querySelectorAll<HTMLElement>('tbody tr')).map(
    (tr) =>
      Array.from(tr.querySelectorAll<HTMLElement>('td')).map(readCellSource),
  );
  return { header, rows };
}

// A cell's raw markdown lives in `dataset.raw` — the source of truth
// that `readModelFromDom` reads when serializing the table back to
// markdown. The inner `.cm-atomic-table-cell-source` element displays
// an escape-stripped view of that raw text so RSS-ingested cells
// don't show `\.` / `\(` / `\-` style literal backslashes in the
// reader; the input handler pulls innerText back to dataset.raw on
// every keystroke (any escapes the user types get preserved there,
// but won't round-trip back through stripEscapes on re-render —
// acceptable tradeoff because the escapes are typically ingestion
// artifacts users don't want to preserve anyway).
function readCellSource(cell: HTMLElement): string {
  return (cell.dataset.raw ?? '').trim();
}

function getCellSource(cell: HTMLElement): HTMLElement | null {
  return cell.querySelector<HTMLElement>('.cm-atomic-table-cell-source');
}

// ---- inline-mark parsing for cell source --------------------------------

// Cells render a subset of inline markdown — bold, italic, strikethrough,
// and links. No code spans (the `|` inside a backtick would silently
// break row parsing), no lists/blocks (cells are single-line by
// construction), no images (handled by the separate cell-preview strip).
//
// The parser is recursive so `**[text](url)**` nests cleanly, but each
// mark is a straightforward delimiter pair — no CommonMark flanking
// rules. The UX inside a cell is forgiving on purpose: if a pair
// matches, it decorates.

type CellToken =
  | { type: 'text'; text: string }
  | { type: 'strong'; delim: '**' | '__'; children: CellToken[] }
  | { type: 'em'; delim: '*' | '_'; children: CellToken[] }
  | { type: 'strike'; children: CellToken[] }
  | { type: 'link'; textChildren: CellToken[]; url: string };

export function parseCellInline(raw: string): CellToken[] {
  const tokens: CellToken[] = [];
  let textBuf = '';
  let i = 0;

  const flushText = () => {
    if (textBuf.length) {
      tokens.push({ type: 'text', text: textBuf });
      textBuf = '';
    }
  };

  while (i < raw.length) {
    // CommonMark backslash escape — the following char is emitted
    // literally and can't open/close a mark. Pair is consumed.
    if (raw[i] === '\\' && i + 1 < raw.length && /[!-/:-@[-`{-~]/.test(raw[i + 1])) {
      textBuf += raw[i + 1];
      i += 2;
      continue;
    }

    const match = matchCellMarkAt(raw, i);
    if (match) {
      flushText();
      tokens.push(match.token);
      i = match.end;
      continue;
    }

    textBuf += raw[i];
    i++;
  }

  flushText();
  return tokens;
}

function matchCellMarkAt(
  raw: string,
  from: number,
): { token: CellToken; end: number } | null {
  const rest = raw.slice(from);

  // Bold with `**` or `__` — greedy on the outside, lazy on the
  // content so we catch the nearest closer.
  let m = rest.match(/^\*\*([\s\S]+?)\*\*/);
  if (m) {
    return {
      token: { type: 'strong', delim: '**', children: parseCellInline(m[1]) },
      end: from + m[0].length,
    };
  }
  m = rest.match(/^__([\s\S]+?)__/);
  if (m) {
    return {
      token: { type: 'strong', delim: '__', children: parseCellInline(m[1]) },
      end: from + m[0].length,
    };
  }

  // Strikethrough.
  m = rest.match(/^~~([\s\S]+?)~~/);
  if (m) {
    return {
      token: { type: 'strike', children: parseCellInline(m[1]) },
      end: from + m[0].length,
    };
  }

  // Link `[text](url)`. Reject empty text / url via `+` quantifiers.
  // `]` and `)` can't appear unescaped inside their respective fields.
  m = rest.match(/^\[([^\]\n]+)\]\(([^\s)"'\n]+)\)/);
  if (m) {
    return {
      token: {
        type: 'link',
        textChildren: parseCellInline(m[1]),
        url: m[2],
      },
      end: from + m[0].length,
    };
  }

  // Italic with `*`. Reject a leading `*` (that would have matched
  // the bold regex above; this guards against pathological inputs
  // like `***` that slip through).
  m = rest.match(/^\*([^*\n]+?)\*/);
  if (m) {
    return {
      token: { type: 'em', delim: '*', children: parseCellInline(m[1]) },
      end: from + m[0].length,
    };
  }

  // Italic with `_`. Avoid triggering inside words like `snake_case`
  // by requiring the char before `_` to not be a word character.
  // (Fallback to true when `_` is at start-of-input.)
  const prev = from > 0 ? raw[from - 1] : '';
  if (!/\w/.test(prev)) {
    m = rest.match(/^_([^_\n]+?)_/);
    if (m) {
      return {
        token: { type: 'em', delim: '_', children: parseCellInline(m[1]) },
        end: from + m[0].length,
      };
    }
  }

  return null;
}

// Build the decorated DOM for a cell's source. The parser strips
// CommonMark backslash escapes inline (so `\*` emits a literal `*`
// text node); the fragment's `textContent` equals the escape-stripped
// raw. The cell's input handler reads `textContent` to update
// `dataset.raw` — round-trip is one-way for escapes (same as the
// pre-markdown-in-cells behavior), but fully preserves every inline
// mark delimiter because those live in `display: none` spans inside
// the DOM rather than being derived on serialize.
function buildCellSourceDom(raw: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const tokens = parseCellInline(raw);
  for (const tok of tokens) frag.appendChild(renderCellToken(tok));
  return frag;
}

function renderCellToken(tok: CellToken): Node {
  if (tok.type === 'text') {
    return document.createTextNode(tok.text);
  }

  if (tok.type === 'strong') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-strong-wrap';
    wrap.appendChild(makeCellMark(tok.delim));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-strong';
    inner.appendChild(renderTokensTo(tok.children));
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark(tok.delim));
    return wrap;
  }

  if (tok.type === 'em') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-em-wrap';
    wrap.appendChild(makeCellMark(tok.delim));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-em';
    inner.appendChild(renderTokensTo(tok.children));
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark(tok.delim));
    return wrap;
  }

  if (tok.type === 'strike') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-strike-wrap';
    wrap.appendChild(makeCellMark('~~'));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-strike';
    inner.appendChild(renderTokensTo(tok.children));
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark('~~'));
    return wrap;
  }

  // Link. Shape mirrors the outer-editor markup: `.cm-atomic-link` on
  // the visible text (picks up link color + external-link icon via
  // `::after`), faint marks for `[`, `]`, `(`, URL, `)`. `data-url`
  // lets the cell-source click handler open the right URL without
  // re-parsing.
  const wrap = document.createElement('span');
  wrap.className = 'cm-atomic-link-wrap';
  wrap.dataset.url = tok.url;
  wrap.appendChild(makeCellMark('['));
  const inner = document.createElement('span');
  inner.className = 'cm-atomic-link';
  inner.appendChild(renderTokensTo(tok.textChildren));
  wrap.appendChild(inner);
  wrap.appendChild(makeCellMark(']'));
  wrap.appendChild(makeCellMark('('));
  const urlMark = makeCellMark(tok.url);
  urlMark.classList.add('cm-atomic-link-url');
  wrap.appendChild(urlMark);
  wrap.appendChild(makeCellMark(')'));
  // Real, clickable external-link icon. A CSS `::after` pseudo can't
  // receive a click (no event target), so the icon is its own
  // non-editable element; the source's delegated click handler opens
  // the URL. `contenteditable=false` keeps it out of caret navigation
  // and out of the cell's serialized text.
  const icon = document.createElement('span');
  icon.className = 'cm-atomic-link-icon';
  icon.contentEditable = 'false';
  icon.setAttribute('aria-hidden', 'true');
  wrap.appendChild(icon);
  return wrap;
}

function renderTokensTo(tokens: CellToken[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const tok of tokens) frag.appendChild(renderCellToken(tok));
  return frag;
}

function makeCellMark(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'cm-atomic-mark';
  el.textContent = text;
  return el;
}

// Render a cell source element in its decorated form. Safe to call
// multiple times — overwrites whatever was there.
//
// Marks start collapsed: all `.cm-atomic-mark` descendants (delimiters
// like `**`, `_`, `~~`, `[`, `]`, `(`, `)`, and URL text) are hidden
// via CSS by default. When the caret enters a mark wrap, JS adds an
// `active` class that reveals that wrap's delimiters — mirroring the
// outer editor's cursor-inside-link unfold for every inline mark.
function renderCellSourceDecorated(source: HTMLElement): void {
  const raw = source.parentElement?.dataset.raw ?? '';
  source.replaceChildren(buildCellSourceDom(raw));
}

// Caret utilities — encode positions as character offsets within the
// element's textContent so we can survive the full-DOM re-render that
// follows every keystroke (new marks need to decorate immediately;
// the whole tree rebuilds from scratch).

function getCaretCharOffset(container: HTMLElement): number | null {
  const selection = container.ownerDocument?.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(container);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function setCaretCharOffset(container: HTMLElement, offset: number): void {
  const doc = container.ownerDocument;
  if (!doc) return;
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let target: Text | null = null;
  let targetOffset = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    if (remaining <= len) {
      target = node;
      targetOffset = remaining;
      break;
    }
    remaining -= len;
    node = walker.nextNode() as Text | null;
  }
  const selection = doc.defaultView?.getSelection();
  if (!selection) return;
  const range = doc.createRange();
  if (target) {
    range.setStart(target, targetOffset);
  } else {
    // Offset past the end — place caret at the container's end.
    range.selectNodeContents(container);
    range.collapse(false);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

// ---- selection / raw utilities for in-cell formatting ---------------
//
// These three exports are the surface the in-cell formatting bar
// (`cell-formatting.ts`) drives the widget through. They deliberately
// reuse the same helpers `commit()` uses so a bar-driven edit and a
// keystroke flow through identical serialization — the only difference
// is WHERE the raw comes from (a computed toggle vs. `textContent`).

// Resolve a character offset over `container`'s textContent to a concrete
// (text node, offset) pair, using the same all-text-nodes-in-order walk
// as `setCaretCharOffset`. Factored out so `setSelectionCharRange` can
// place both endpoints without duplicating the walker. A null node means
// the offset ran past the end of the text — the caller places the
// boundary at the container's end.
function resolveCharOffset(
  container: HTMLElement,
  offset: number,
): { node: Text | null; offset: number } {
  const doc = container.ownerDocument;
  if (!doc) return { node: null, offset: 0 };
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
    node = walker.nextNode() as Text | null;
  }
  return { node: null, offset: 0 };
}

// The current DOM selection mapped to character offsets over
// `source.textContent`. Both endpoints must lie inside `source` (the same
// containment rule `getCaretCharOffset` enforces for a caret); null
// otherwise. Offsets count every text node in document order — INCLUDING
// the hidden `.cm-atomic-mark` delimiter spans — so they line up with the
// raw string the cell parser sees (which is why `textContent`, not
// `innerText`, is the reference length everywhere in this file).
export function getSelectionCharRange(
  source: HTMLElement,
): { from: number; to: number } | null {
  const selection = source.ownerDocument?.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!source.contains(range.startContainer) || !source.contains(range.endContainer)) {
    return null;
  }
  // Same technique as `getCaretCharOffset`: measure the text from the
  // container start up to each boundary. `setEnd` moves only the end of
  // the cloned range, so the start stays pinned at the container start.
  const pre = range.cloneRange();
  pre.selectNodeContents(source);
  pre.setEnd(range.startContainer, range.startOffset);
  const from = pre.toString().length;
  pre.setEnd(range.endContainer, range.endOffset);
  const to = pre.toString().length;
  return { from, to };
}

// Inverse of `getSelectionCharRange`: place a real DOM selection spanning
// [from, to] character offsets over `source`. Mirrors
// `setCaretCharOffset`'s walker for each endpoint.
export function setSelectionCharRange(source: HTMLElement, from: number, to: number): void {
  const doc = source.ownerDocument;
  if (!doc) return;
  const selection = doc.defaultView?.getSelection();
  if (!selection) return;
  const range = doc.createRange();
  const start = resolveCharOffset(source, from);
  const end = resolveCharOffset(source, to);
  if (start.node) {
    range.setStart(start.node, start.offset);
  } else {
    range.selectNodeContents(source);
    range.collapse(false);
  }
  if (end.node) {
    range.setEnd(end.node, end.offset);
  } else {
    range.setEnd(source, source.childNodes.length);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

// Commit a GIVEN raw string into a cell — the same DOM → source → model
// path `commit()` runs per keystroke, but with the raw handed in rather
// than read from `textContent`. The in-cell formatting bar computes the
// next raw with `toggleCellRaw` and then owns caret placement (via
// `setSelectionCharRange`) itself, so — unlike `commit` — this neither
// captures/restores the caret NOR re-normalizes whitespace: the caller
// passes the exact final bytes and expects them byte-preserved.
export function updateCellRaw(view: EditorView, cell: HTMLElement, raw: string): void {
  cell.dataset.raw = raw;
  const source = getCellSource(cell);
  if (source) renderCellSourceDecorated(source);
  refreshCellPreview(cell);
  dispatchModelFromDom(view, cell);
}

const MARK_WRAP_CLASSES = [
  'cm-atomic-strong-wrap',
  'cm-atomic-em-wrap',
  'cm-atomic-strike-wrap',
  'cm-atomic-link-wrap',
];

function isMarkWrap(el: Element): boolean {
  for (const c of MARK_WRAP_CLASSES) if (el.classList.contains(c)) return true;
  return false;
}

// Reveal the delimiters of whatever mark wrap(s) contain the caret,
// and collapse every other wrap in this cell. Walks from the caret
// anchor up to the source element, flagging every ancestor mark wrap
// so nested marks (bold-containing-italic) all reveal together — the
// user sees the full structure around their caret.
function updateActiveMarkForSource(source: HTMLElement): void {
  // Clear existing `active` classes within this cell only — other
  // cells track their own state via their own focus lifecycle.
  for (const el of source.querySelectorAll('.active')) {
    el.classList.remove('active');
  }

  const doc = source.ownerDocument;
  if (!doc) return;
  const selection = doc.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const anchor = selection.anchorNode;
  if (!anchor || !source.contains(anchor)) return;

  let node: Node | null = anchor;
  while (node && node !== source) {
    if (node instanceof Element && isMarkWrap(node)) {
      node.classList.add('active');
    }
    node = node.parentNode;
  }
}

function clearActiveMarksInSource(source: HTMLElement): void {
  for (const el of source.querySelectorAll('.active')) {
    el.classList.remove('active');
  }
}

interface CellImage {
  src: string;
  alt: string;
}

// Scan raw markdown for `![alt](url)` occurrences. The regex bans `]`
// inside the alt and whitespace inside the URL so we fail closed on
// malformed sources rather than embedding a broken preview.
function extractCellImages(text: string): CellImage[] {
  const imgs: CellImage[] = [];
  const re = /!\[([^\]]*)\]\(([^\s)"']+)(?:\s+["'][^)]*["'])?\)/g;
  for (const match of text.matchAll(re)) {
    imgs.push({ alt: match[1] || '', src: match[2] });
  }
  return imgs;
}

// Refresh (or remove) the image-preview strip that sits below the
// source line. Mirrors how images render outside tables: the
// `![alt](url)` markdown is the source of truth, but on an inactive
// cell (no focus inside) the raw source hides and only the rendered
// image remains visible. `data-has-image` flips on for that CSS hook.
function refreshCellPreview(cell: HTMLElement): void {
  const existing = cell.querySelector<HTMLElement>('.cm-atomic-table-cell-preview');
  if (existing) existing.remove();

  const text = cell.dataset.raw ?? '';
  const imgs = extractCellImages(text);
  if (imgs.length === 0) {
    delete cell.dataset.hasImage;
    return;
  }
  cell.dataset.hasImage = 'true';

  const preview = document.createElement('div');
  preview.className = 'cm-atomic-table-cell-preview';
  // Preview is visual only — no caret, no contenteditable scope.
  // Keeping it out of contenteditable also means clicking the image
  // won't create a phantom caret position at the preview boundary.
  preview.contentEditable = 'false';

  for (const { src, alt } of imgs) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    img.loading = 'lazy';
    img.className = 'cm-atomic-table-cell-image';
    // Clicking the image puts the caret in the source text so the
    // user can edit the underlying markdown — same affordance as
    // clicking a block-level image outside a table.
    img.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const source = getCellSource(cell);
      if (!source) return;
      source.focus();
      placeCaretAtEnd(source);
    });
    preview.appendChild(img);
  }

  cell.appendChild(preview);
}

// ---- position resolution --------------------------------------------

// posAtDOM on a block-replace widget returns the start of the replaced
// range. Walk the tree from there to find the enclosing Table node so
// our dispatch targets the current range (positions shift as the user
// types — we can't rely on the from/to captured at widget creation).
function findCurrentTableRange(
  view: EditorView,
  dom: HTMLElement,
): { from: number; to: number } | null {
  const pos = view.posAtDOM(dom);
  if (pos < 0) return null;
  const tree = syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node && node.name !== 'Table') node = node.parent;
  if (node) return { from: node.from, to: node.to };

  // Fallback: scan for the nearest Table node containing or starting
  // at pos. Rare — resolveInner + parent walk handles almost every
  // case — but guards against parser edge cases.
  let found: SyntaxNode | null = null;
  tree.iterate({
    enter: (n) => {
      if (n.name !== 'Table') return;
      if (n.from <= pos && n.to >= pos) {
        found = n.node;
        return false;
      }
    },
  });
  if (found) return { from: (found as SyntaxNode).from, to: (found as SyntaxNode).to };
  return null;
}

// ---- DOM helpers ----------------------------------------------------

function placeCaretAtEnd(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

function getAllCells(wrap: HTMLElement): HTMLElement[] {
  return Array.from(wrap.querySelectorAll<HTMLElement>('th, td'));
}

// ---- widget ---------------------------------------------------------

class TableWidget extends WidgetType {
  constructor(readonly model: TableModel) {
    super();
  }

  // Structure-only equality. Typing in a cell produces a new
  // TableWidget with the same dimensions but different cell contents.
  // Returning true here means CM6 keeps the existing DOM instead of
  // calling `toDOM` again — which is what lets the caret survive
  // across the per-keystroke dispatch cycle.
  eq(other: TableWidget): boolean {
    if (other.model.header.length !== this.model.header.length) return false;
    if (other.model.rows.length !== this.model.rows.length) return false;
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-atomic-table';

    // Positioning context for the hover affordances. The controls anchor
    // to this inner box (which hugs the table via `width: max-content`),
    // NOT the wrap — so they sit on the table's own edges even after a
    // horizontal scroll. They straddle the inner box's border (half in,
    // half out) Linear-style; the wrap reserves a static padding gutter
    // sized for that overhang, so revealing them on hover never extends
    // the wrap's scrollable overflow or its measured height (a
    // taller/wider wrap desyncs CM6's heightmap and misroutes clicks
    // below the table — see the heightmap note in inline-preview.css).
    const inner = document.createElement('div');
    inner.className = 'cm-atomic-table-inner';
    wrap.appendChild(inner);

    const table = document.createElement('table');
    inner.appendChild(table);

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const text of this.model.header) {
      headerRow.appendChild(makeCell('th', text, view));
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const colCount = this.model.header.length;
    for (const row of this.model.rows) {
      const tr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
        tr.appendChild(makeCell('td', row[c] ?? '', view));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    // Hover controls overlay the table's edges; append them last so
    // they paint above the cells.
    for (const control of makeTableAffordances(view, wrap)) {
      inner.appendChild(control);
    }

    return wrap;
  }

  // All cell interactions are handled by the listeners we attach in
  // `makeCell`; tell CM6 to stay out of events within the widget so
  // its own selection/click logic doesn't compete with contenteditable.
  ignoreEvent(): boolean {
    return true;
  }
}

// ---- hover affordances ----------------------------------------------

// Three quiet, absolutely-positioned controls overlaid on the table's
// edges: add-column (right), add-row (bottom), and a table-options
// handle (top-right). They live inside `.cm-atomic-table-inner` and are
// default-hidden via CSS, revealing on `:hover` / `:focus-within`. Every
// action flows through the same DOM → model → dispatch path as the
// context menu, so rendering/hovering never touches the document.
function makeTableAffordances(view: EditorView, wrap: HTMLElement): HTMLElement[] {
  const addCol = makeAffordanceButton('cm-atomic-table-add-col', 'Add column', '+');
  addCol.addEventListener('click', (event) => {
    event.stopPropagation();
    appendColumn(view, wrap);
  });

  const addRow = makeAffordanceButton('cm-atomic-table-add-row', 'Add row', '+');
  addRow.addEventListener('click', (event) => {
    event.stopPropagation();
    appendRow(view, wrap);
  });

  const handle = makeAffordanceButton('cm-atomic-table-handle', 'Table options', '⋯');
  handle.addEventListener('click', (event) => {
    event.stopPropagation();
    // Open the shared menu for the first body cell (row 0, col 0) so
    // "Insert row above" reads as "insert at the top" — the sensible
    // table-level default. Fall back to the first header cell when the
    // table has no body rows. Anchor at the handle's bottom-left corner.
    const anchorCell =
      wrap.querySelector<HTMLElement>('tbody td') ??
      wrap.querySelector<HTMLElement>('thead th');
    if (!anchorCell) return;
    const rect = handle.getBoundingClientRect();
    openTableMenuForCell(view, anchorCell, rect.left, rect.bottom);
  });

  return [addCol, addRow, handle];
}

function makeAffordanceButton(
  className: string,
  label: string,
  glyph: string,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.textContent = glyph;
  // Suppress the focus-move / caret placement a press would otherwise
  // trigger — the button sits over cells that have their own pointerdown
  // handlers. The action runs on the following `click`.
  btn.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  return btn;
}

function makeCell(
  tag: 'th' | 'td',
  text: string,
  view: EditorView,
): HTMLElement {
  const cell = document.createElement(tag);
  cell.dataset.raw = text;

  // The cell itself is not contenteditable — only the inner source
  // element is. This keeps the image preview strictly visual (no
  // phantom caret positions around images) while the source text
  // stays in a dedicated editable box above it.
  const source = document.createElement('div');
  source.className = 'cm-atomic-table-cell-source';
  source.contentEditable = 'true';
  source.spellcheck = true;
  // Decorated DOM on mount. Delimiters (`.cm-atomic-mark`) are
  // `display: none` by default — the caret can't navigate into them,
  // the reader sees a clean rendered view. When the caret enters a
  // mark wrap, JS adds `.active` to reveal that wrap's delimiters —
  // matching the outer-editor cursor-inside-link unfold, applied
  // uniformly to every inline mark inside cells.
  cell.appendChild(source);
  renderCellSourceDecorated(source);

  // Commit the cell's current DOM text to `dataset.raw`, re-render its
  // decorated form (so marks the user just typed — e.g. a new `**` pair
  // — decorate immediately), restore the caret across that rebuild, and
  // push the change into the document.
  const commit = () => {
    // textContent (not innerText) so `display: none` delimiters inside
    // mark wraps are still captured — otherwise a cell containing
    // `**bold**` would serialize to just `bold` on every keystroke.
    const raw = (source.textContent ?? '').replace(/\s+/g, ' ').trim();
    cell.dataset.raw = raw;
    const offset = getCaretCharOffset(source);
    renderCellSourceDecorated(source);
    if (offset != null) setCaretCharOffset(source, offset);
    updateActiveMarkForSource(source);
    refreshCellPreview(cell);
    dispatchModelFromDom(view, cell);
  };

  // IME / dead-key composition. `commit` rebuilds the contenteditable
  // DOM, and doing that mid-composition cancels the composition session
  // — dropping CJK input, accented characters, and dictation. Suppress
  // every update while composing and run one commit when it ends.
  let composing = false;
  source.addEventListener('compositionstart', () => {
    composing = true;
  });
  source.addEventListener('compositionend', () => {
    composing = false;
    commit();
  });

  source.addEventListener('input', (event) => {
    if (composing || (event as InputEvent).isComposing) return;
    commit();
  });

  // Paste: drop clipboard content in as a single line of plain text.
  // Without this, pasted rich HTML, newlines, or pipes land in the cell
  // verbatim; newlines and `|` corrupt the row. We flatten whitespace
  // and strip markup here, and `escapeCell` neutralizes any literal `|`
  // on serialize.
  source.addEventListener('paste', (event) => {
    event.preventDefault();
    const text = (event.clipboardData?.getData('text/plain') ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const sel = source.ownerDocument.defaultView?.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    commit();
  });

  // Caret-position listeners. `focus` / `mouseup` / `keyup` cover the
  // three ways the caret can land in a new mark without firing an
  // input event (click-to-place, arrow-key nav, tab-into-cell). The
  // update is idempotent — redundant calls cost nothing.
  source.addEventListener('focus', () => updateActiveMarkForSource(source));
  source.addEventListener('mouseup', () => updateActiveMarkForSource(source));
  source.addEventListener('keyup', () => updateActiveMarkForSource(source));

  // Blur: collapse every active wrap so the reader-resting state
  // hides all delimiters.
  source.addEventListener('blur', () => clearActiveMarksInSource(source));

  source.addEventListener('keydown', (event) => {
    // Enter mirrors Tab — advance to the next cell (appending a row past
    // the last one) instead of inserting a line break a single-line cell
    // can't represent. Shift reverses direction for both.
    if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      moveCellFocus(view, cell, event.shiftKey ? -1 : 1);
    }
  });

  cell.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCellMenu(view, cell, event.clientX, event.clientY);
  });

  // Link-icon open. The external-link icon is rendered as a real
  // `.cm-atomic-link-icon` element (see `renderCellToken`), not a CSS
  // `::after` pseudo — a pseudo-element has no event target, so clicking
  // its painted region dispatched no pointer event and the link never
  // opened. We open on `click` (a proper popup-activation gesture, so
  // `window.open` isn't blocked) and block the caret on `pointerdown`.
  const linkIconFromEvent = (event: Event): HTMLElement | null => {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>('.cm-atomic-link-icon');
  };

  source.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // Block focus / caret placement when pressing the icon; the open
    // happens on the following `click`.
    if (linkIconFromEvent(event)) event.preventDefault();
  });

  source.addEventListener('click', (event) => {
    const icon = linkIconFromEvent(event);
    if (!icon) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const url = icon.closest<HTMLElement>('.cm-atomic-link-wrap')?.dataset.url;
    if (!url) return;
    event.preventDefault();
    event.stopPropagation();
    view.state.facet(tableLinkClickFacet)(url);
  });

  // When the cell has an image and the source is visually hidden,
  // clicks land on the cell/image/empty space but not on the source
  // itself. Route every pointerdown inside the cell to a focus on
  // the source so the user can edit regardless of where they tapped.
  // The image's own pointerdown handler already does this, but
  // covers only image hits — this covers empty padding and the
  // space between/around images.
  cell.addEventListener('pointerdown', (event) => {
    // A click on the editable source — including its inner mark spans
    // and text — must keep the browser's native caret placement. Forcing
    // focus-at-end here would yank the caret to the end of the cell
    // whenever the user clicks a styled run (bold/italic/link). Only
    // intercept clicks that land OUTSIDE the source (cell padding, the
    // image preview, the cell box itself) to route focus into it.
    const target = event.target;
    if (target instanceof Node && source.contains(target)) return;
    event.preventDefault();
    source.focus();
    placeCaretAtEnd(source);
  });

  refreshCellPreview(cell);

  return cell;
}

// ---- context menu -------------------------------------------------

function cellRowIndex(cell: HTMLElement): number {
  // Rows are indexed within tbody (header isn't a "row" we can
  // insert-above; header context items are column-only).
  const tr = cell.closest<HTMLElement>('tr');
  const tbody = tr?.closest<HTMLElement>('tbody');
  if (!tr || !tbody) return -1;
  return Array.from(tbody.querySelectorAll<HTMLElement>('tr')).indexOf(tr);
}

function cellColIndex(cell: HTMLElement): number {
  const tr = cell.closest<HTMLElement>('tr');
  if (!tr) return -1;
  return Array.from(tr.querySelectorAll<HTMLElement>('th, td')).indexOf(cell);
}

function dispatchModel(
  view: EditorView,
  wrap: HTMLElement,
  nextModel: TableModel,
): void {
  const range = findCurrentTableRange(view, wrap);
  if (!range) return;
  const next = serializeTable(nextModel);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
  });
}

// Right-clicking a cell opens the menu at the pointer, anchored to that
// cell's context (isHeader / row / col). Kept as a thin, stable-shaped
// entry point; the table-options handle reaches the same builder via
// `openTableMenuForCell` with a synthetic anchor cell.
function openCellMenu(
  view: EditorView,
  cell: HTMLElement,
  x: number,
  y: number,
): void {
  openTableMenuForCell(view, cell, x, y);
}

function openTableMenuForCell(
  view: EditorView,
  cell: HTMLElement,
  x: number,
  y: number,
): void {
  const wrap = cell.closest<HTMLElement>('.cm-atomic-table');
  if (!wrap) return;
  const isHeader = cell.tagName === 'TH';
  const row = cellRowIndex(cell);
  const col = cellColIndex(cell);

  const menu = document.createElement('div');
  menu.className = 'cm-atomic-table-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  // The menu mounts on document.body, outside the editor's DOM, so the
  // `--atomic-editor-menu-*` chrome tokens — light-theme remaps and
  // consumer overrides alike, both scoped to the editor element — never
  // cascade to it. Copy the values resolved at the editor onto the menu
  // so it themes identically to the in-editor popups.
  const editorStyle = getComputedStyle(view.dom);
  for (const token of [
    '--atomic-editor-menu-bg',
    '--atomic-editor-menu-border',
    '--atomic-editor-menu-shadow',
    '--atomic-editor-menu-radius',
    '--atomic-editor-menu-item-hover-bg',
    '--atomic-editor-menu-fg',
    '--atomic-editor-menu-fg-muted',
    '--atomic-editor-font',
  ]) {
    const value = editorStyle.getPropertyValue(token);
    if (value) menu.style.setProperty(token, value);
  }

  type MenuItem = { label: string; action: () => void } | 'separator';
  const items: MenuItem[] = [];

  if (!isHeader) {
    items.push({
      label: 'Insert row above',
      action: () => {
        const m = readModelFromDom(wrap);
        m.rows.splice(row, 0, m.header.map(() => ''));
        dispatchModel(view, wrap, m);
      },
    });
    items.push({
      label: 'Insert row below',
      action: () => {
        const m = readModelFromDom(wrap);
        m.rows.splice(row + 1, 0, m.header.map(() => ''));
        dispatchModel(view, wrap, m);
      },
    });
    items.push({
      label: 'Delete row',
      action: () => {
        const m = readModelFromDom(wrap);
        if (row >= 0 && row < m.rows.length) m.rows.splice(row, 1);
        dispatchModel(view, wrap, m);
      },
    });
    items.push('separator');
  }

  items.push({
    label: 'Insert column left',
    action: () => {
      const m = readModelFromDom(wrap);
      m.header.splice(col, 0, '');
      for (const r of m.rows) r.splice(col, 0, '');
      dispatchModel(view, wrap, m);
    },
  });
  items.push({
    label: 'Insert column right',
    action: () => {
      const m = readModelFromDom(wrap);
      m.header.splice(col + 1, 0, '');
      for (const r of m.rows) r.splice(col + 1, 0, '');
      dispatchModel(view, wrap, m);
    },
  });
  items.push({
    label: 'Delete column',
    action: () => {
      const m = readModelFromDom(wrap);
      // Guard: don't leave the table with zero columns — lezer
      // wouldn't re-parse that as a Table and the widget would
      // vanish mid-edit. Keeping the last column as the floor.
      if (m.header.length <= 1 || col < 0) return;
      m.header.splice(col, 1);
      for (const r of m.rows) r.splice(col, 1);
      dispatchModel(view, wrap, m);
    },
  });

  const dismiss = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
  };
  const onDocDown = (event: MouseEvent) => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    dismiss();
  };
  const onDocKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') dismiss();
  };

  for (const item of items) {
    if (item === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'cm-atomic-table-menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-atomic-table-menu-item';
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      item.action();
      dismiss();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  // Clip the menu inside the viewport if it overflows.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
  }

  // Deferred listener attach so the current contextmenu→document
  // mousedown cycle doesn't immediately dismiss us.
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onDocKey, true);
  }, 0);
}

function dispatchModelFromDom(view: EditorView, cell: HTMLElement): void {
  const wrap = cell.closest<HTMLElement>('.cm-atomic-table');
  if (!wrap) return;
  const range = findCurrentTableRange(view, wrap);
  if (!range) return;

  const model = readModelFromDom(wrap);
  const next = serializeTable(model);
  // Guard against no-op dispatches.
  if (view.state.sliceDoc(range.from, range.to) === next) return;

  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
    // Tag as typing so CM6's history coalesces consecutive cell edits
    // into one undo group instead of one step per keystroke (each of
    // which rewrites the whole table range).
    annotations: Transaction.userEvent.of('input.type'),
  });
}

function moveCellFocus(view: EditorView, cell: HTMLElement, dir: 1 | -1): void {
  const wrap = cell.closest<HTMLElement>('.cm-atomic-table');
  if (!wrap) return;
  const cells = getAllCells(wrap);
  const idx = cells.indexOf(cell);
  if (idx < 0) return;

  const next = idx + dir;
  if (next < 0) {
    // Shift-Tab from the first cell — blur the source; let the
    // browser decide where focus goes next (probably the previous
    // focusable element on the page). CM6 keeps its own selection
    // where it was.
    getCellSource(cell)?.blur();
    return;
  }
  if (next >= cells.length) {
    // Tab past the last cell — append a new empty row and focus its
    // first cell. We dispatch through the same path as a cell edit,
    // then grab the new first cell after the DOM reconciles.
    appendRow(view, wrap);
    return;
  }
  const source = getCellSource(cells[next]);
  if (!source) return;
  source.focus();
  placeCaretAtEnd(source);
}

function appendRow(view: EditorView, wrap: HTMLElement): void {
  const range = findCurrentTableRange(view, wrap);
  if (!range) return;
  const model = readModelFromDom(wrap);
  model.rows.push(model.header.map(() => ''));
  const next = serializeTable(model);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
  });

  // Adding a row changes the widget's row count, so `eq` returns
  // false and CM6 rebuilds the widget DOM. The old `wrap` reference
  // is now detached. Wait for the paint that attaches the new DOM,
  // then look up the fresh widget by position and focus its new
  // last-row cell. Double-rAF because the first rAF only guarantees
  // CM6 has processed the dispatch; the second ensures the layout
  // has painted so focus commands don't get lost.
  const { from } = range;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const tables = Array.from(
        view.dom.querySelectorAll<HTMLElement>('.cm-atomic-table'),
      );
      let target: HTMLElement | null = null;
      for (const el of tables) {
        try {
          if (view.posAtDOM(el) === from) {
            target = el;
            break;
          }
        } catch {
          // posAtDOM can throw on detached/transitional DOM nodes
          // — skip and keep looking.
        }
      }
      if (!target) return;
      const rows = target.querySelectorAll<HTMLElement>('tbody tr');
      const newRow = rows[rows.length - 1];
      const firstCell = newRow?.querySelector<HTMLElement>('td');
      const firstSource = firstCell ? getCellSource(firstCell) : null;
      if (!firstSource) return;
      firstSource.focus();
      placeCaretAtEnd(firstSource);
    });
  });
}

// Append an empty trailing column. Byte-identical to the context menu's
// "Insert column right" invoked on the last column: push '' to the
// header and every body row, then dispatch through the same range
// replace. No new serialization logic — same shape as `dispatchModel`.
function appendColumn(view: EditorView, wrap: HTMLElement): void {
  const range = findCurrentTableRange(view, wrap);
  if (!range) return;
  const model = readModelFromDom(wrap);
  model.header.push('');
  for (const row of model.rows) row.push('');
  const next = serializeTable(model);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
  });
}

// Backspace at the line immediately after a table normally deletes
// the `\n` separator and merges the line-below into the table's last
// source line. Lezer then re-parses the merged content as part of
// the table (or mangles it), producing the "swallow" behavior where
// content below the table looks like it's been absorbed as new rows.
//
// Instead, when the caret sits right after a Table and the user hits
// backspace, select the whole Table range — same pattern Obsidian
// uses for treating the table as an atomic unit for deletion. The
// caller can press backspace again to actually delete the selected
// table.
function backspaceAtTableBoundary(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const pos = sel.head;
  if (pos === 0) return false;

  const tree = syntaxTree(state);
  let tableBefore: SyntaxNode | null = null;

  // Scan a few positions back for a Table whose end is adjacent to
  // the caret. `table.to` is the position just after the table's
  // last character — if the caret sits on the next line, `pos` will
  // be one past `table.to` (the \n separator at `table.to` + start
  // of the line after). Accept both.
  tree.iterate({
    from: Math.max(0, pos - 2),
    to: pos,
    enter: (n) => {
      if (n.name !== 'Table') return;
      if (n.to === pos || n.to + 1 === pos) {
        tableBefore = n.node;
      }
    },
  });

  if (!tableBefore) return false;

  const range: SyntaxNode = tableBefore;
  view.dispatch({
    selection: EditorSelection.range(range.from, range.to),
  });
  return true;
}

// ---- state field ----------------------------------------------------

// True when any selection range touches the inclusive character span
// [from, to] — used to detect the caret resting on a table's last line.
function selectionOnLine(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function buildTableWidgets(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  // Force full-doc parse so tables past the initial parsed region
  // also get the widget treatment. This StateField only rebuilds on
  // doc change; CM6's background parser advancing the tree later
  // doesn't retrigger it, so a partial tree at mount means orphaned
  // `| col |` raw lines for the rest of the session. 200ms budget
  // bounds the worst case on very long atoms.
  const tree =
    ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const doc = state.doc;

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Table') return;
      const model = parseTable(state, node.node);
      if (!model) return;

      // Block-replace needs whole-line coverage.
      const startLine = doc.lineAt(node.from);
      const endLine = doc.lineAt(node.to);

      // Cursor-on-the-last-line exemption. Reveal the table's raw source
      // (skip the widget) while the caret sits on its final line.
      //
      // WHY: the widget is an atomic block-replace. In a live EditorView,
      // the moment a just-typed trailing line becomes part of the Table
      // node (lezer absorbs `\n| … |` as a TableRow on the very next
      // keystroke), the replace range grows to cover that line. With the
      // caret at the table's end and no editable line beyond it, CM6 has
      // no text position to host the DOM selection and drops it inside
      // the widget's first contenteditable cell — so every further
      // keystroke lands in that cell and corrupts the document instead of
      // extending the row. (This never reproduces at pure-state level;
      // it needs the view's DOM selection sync.) Leaving the caret's line
      // as source keeps a real text position for it; the widget folds the
      // row in as soon as the caret leaves. This mirrors the codebase's
      // existing "reveal the block the cursor is on" convention
      // (inline-preview) and matches Obsidian's table live-preview.
      //
      // Restricting the exemption to the LAST line (not the whole table)
      // keeps the widget on mount for a document that opens with a table
      // (caret at pos 0 sits on the header, not the last line), and cell
      // editing is unaffected because it never moves CM's own selection
      // into the table range.
      if (selectionOnLine(state, endLine.from, endLine.to)) {
        return false;
      }

      ranges.push(
        Decoration.replace({
          widget: new TableWidget(model),
          block: true,
        }).range(startLine.from, endLine.to),
      );
      return false; // don't descend
    },
  });

  return Decoration.set(ranges, true);
}

// Detect whether a doc change could have added, removed, or modified
// a Table node. Two cheap signals:
//
//   1. Any existing table decoration overlaps the changed range
//      (edit to / deletion of an existing table).
//   2. Any line touched by the change contains a pipe `|`. GFM
//      tables are pipe-delimited, so every table line has one and
//      editing one without touching a pipe character is impossible.
//      Prose rarely contains pipes; the occasional false positive
//      is fine because `buildTableWidgets` fails cleanly when
//      lezer didn't emit a Table.
//
// If neither fires, skip the full-doc walk and just map existing
// decorations through the change.
function changeAffectsTables(tr: Transaction, existing: DecorationSet): boolean {
  let affected = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (affected) return;
    existing.between(fromA, toA, () => {
      affected = true;
      return false;
    });
  });
  if (affected) return true;

  const state = tr.state;
  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (affected) return;
    const startLine = state.doc.lineAt(fromB);
    const endLine = toB > startLine.to ? state.doc.lineAt(toB) : startLine;
    for (let n = startLine.number; n <= endLine.number; n++) {
      if (state.doc.line(n).text.includes('|')) {
        affected = true;
        break;
      }
    }
  });
  return affected;
}

// Whether a selection-only transaction could change which tables are
// exempted from widget rendering. The exemption keys off the caret
// sitting on a table's last line, and every table line contains a pipe,
// so a rebuild is only warranted when the caret's old or new line holds
// a `|`. Cheap (two `lineAt` lookups) and no forced parse.
function selectionMayToggleTable(tr: Transaction): boolean {
  if (tr.startState.selection.eq(tr.state.selection)) return false;
  const oldHead = tr.startState.selection.main.head;
  const newHead = tr.state.selection.main.head;
  return (
    tr.startState.doc.lineAt(oldHead).text.includes('|') ||
    tr.state.doc.lineAt(newHead).text.includes('|')
  );
}

const tableField = StateField.define<DecorationSet>({
  create: (state) => buildTableWidgets(state),
  update(deco, tr) {
    // Tree-growth effect: lezer's background parser caught up to a
    // region that wasn't parsed when we last built. Rebuild so any
    // newly-visible Table nodes get their widget.
    for (const effect of tr.effects) {
      if (effect.is(treeGrowthEffect)) return buildTableWidgets(tr.state);
    }
    if (!tr.docChanged) {
      // A caret move with no doc change can still flip a table between
      // rendered and source (the cursor-on-last-line exemption in
      // `buildTableWidgets`). Rebuild only when the caret enters or
      // leaves a pipe-bearing line — the same cheap table proxy
      // `changeAffectsTables` uses — so ordinary cursor motion through
      // prose never pays for a rebuild or a forced parse.
      if (selectionMayToggleTable(tr)) return buildTableWidgets(tr.state);
      return deco;
    }
    const mapped = deco.map(tr.changes);
    if (!changeAffectsTables(tr, deco)) return mapped;
    return buildTableWidgets(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface TablesConfig {
  /**
   * Called when the user clicks the external-link icon on a link
   * rendered inside a table cell. Defaults to `window.open(url,
   * '_blank', 'noopener,noreferrer')`.
   */
  onLinkClick?: (url: string) => void;
}

const defaultLinkOpener = (url: string): void => {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    // window.open can throw in sandboxed iframes etc.
  }
};

// Per-view facet so `makeCell`'s pointerdown handler can look up the
// current link-click callback. Avoids threading the config through the
// widget constructor and toDOM args.
export const tableLinkClickFacet = Facet.define<
  (url: string) => void,
  (url: string) => void
>({
  combine: (values) => values[0] ?? defaultLinkOpener,
});

export function tables(config: TablesConfig = {}): Extension {
  return [
    tableField,
    treeProgressPlugin,
    ...(config.onLinkClick ? [tableLinkClickFacet.of(config.onLinkClick)] : []),
    // Prec.high so we run before the default Backspace binding.
    Prec.high(keymap.of([{ key: 'Backspace', run: backspaceAtTableBoundary }])),
  ];
}
