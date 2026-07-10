// Obsidian-style Properties widget for YAML frontmatter.
//
// The `Frontmatter` node (see ./frontmatter.ts) is replaced with a
// block widget rendering a key/value grid: in-place editing, add /
// remove rows, list values as chips, and an "edit as source" toggle
// that reveals the raw YAML (styled by inline-preview's fallback).
//
// Follows ./table-widget.ts architecturally — StateField-provided
// Decoration.replace, structure-only widget equality so the DOM (and
// caret) survives per-keystroke rebuilds, IME-safe contenteditable
// cells — with one deliberate difference: table edits re-serialize the
// whole table range, but property edits dispatch *single-line* changes.
// Frontmatter is metadata consumers diff against; editing one value
// must never rewrite the bytes of a neighboring line.
//
// Fallback contract: anything this widget can't faithfully represent
// (nested maps, block scalars, comments, blank lines, unclosed fence)
// renders as the raw styled text instead. The widget only appears when
// every line inside the fences is a simple `key: value`.
import { syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { intersectsAtomicDiffChange, isAtomicDiffView } from './diff-context';

// ---- model ----------------------------------------------------------

interface PropertyRow {
  key: string;
  /** Raw value text after the colon, trimmed. Verbatim from the doc. */
  value: string;
  /** Parsed entries when `value` is a simple inline list `[a, b]`. */
  items: string[] | null;
}

interface FrontmatterModel {
  rows: PropertyRow[];
}

const CLOSE_FENCE = /^---[ \t]*$/;

// A value is chip-rendered only when it's an inline list simple enough
// to split on commas without a real YAML tokenizer. Quotes or nested
// brackets push the row back to scalar display of the raw text.
function parseItems(value: string): string[] | null {
  const m = /^\[(.*)\]$/.exec(value);
  if (!m) return null;
  const inner = m[1];
  if (inner.trim() === '') return [];
  if (/["'\[\]{}]/.test(inner)) return null;
  return inner.split(',').map((s) => s.trim());
}

// One frontmatter line → one row, or null if the line is anything but
// a simple top-level `key: value`. Nulls make the whole block fall
// back to raw text — never guess at YAML we might re-serialize wrong.
function parseRow(text: string): PropertyRow | null {
  if (text.length === 0) return null;
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  const key = text.slice(0, colon);
  // No leading whitespace (nested mapping), no comment, no list item,
  // no quoted/flow keys — those all have re-serialization semantics a
  // grid row can't honor.
  if (/^[\s#-]/.test(key) || /["'{}\[\]]/.test(key) || /\s$/.test(key)) return null;
  const rest = text.slice(colon + 1);
  if (rest !== '' && !/^[ \t]/.test(rest)) return null;
  const value = rest.trim();
  if (value.startsWith('#')) return null; // whole value is a comment
  if (/\s#/.test(value)) return null; // trailing comment — raw fallback
  return { key, value, items: parseItems(value) };
}

function parseModel(state: EditorState, node: SyntaxNode): FrontmatterModel | null {
  const doc = state.doc;
  const startLine = doc.lineAt(node.from);
  const endLine = doc.lineAt(node.to);
  // Unclosed frontmatter (parser ran to EOF) has no closing fence —
  // the user is mid-typing; leave the raw text alone.
  if (startLine.number === endLine.number) return null;
  if (!CLOSE_FENCE.test(endLine.text)) return null;
  const rows: PropertyRow[] = [];
  for (let n = startLine.number + 1; n < endLine.number; n++) {
    const row = parseRow(doc.line(n).text);
    if (!row) return null;
    rows.push(row);
  }
  return { rows };
}

// ---- serialization --------------------------------------------------

// Quote a scalar only when writing it bare would change its meaning or
// get misparsed by our own parseRow. Values the user typed that are
// already fine (numbers, plain words, dates) pass through verbatim.
const NEEDS_QUOTE = /^[\s"'#\[\]{}>|*&!%@`,-]|:[ \t]|:$|[ \t]#|\s$/;

function serializeScalar(value: string): string {
  if (value === '') return '';
  if (!NEEDS_QUOTE.test(value)) return value;
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function serializeItems(items: string[]): string {
  return '[' + items.map((s) => serializeScalar(s.replace(/,/g, ' ').trim())).join(', ') + ']';
}

function serializeLine(key: string, valueText: string): string {
  return valueText === '' ? `${key}:` : `${key}: ${valueText}`;
}

// Keys must survive parseRow on the way back in. Colons and newlines
// are structural; leading `#`/`-`/space would demote the line to the
// raw fallback on the next parse.
function sanitizeKey(raw: string): string {
  return raw.replace(/[:\n\r]/g, '').replace(/^[\s#-]+/, '').trimEnd();
}

// ---- doc access -----------------------------------------------------

function findFrontmatterNode(state: EditorState): SyntaxNode | null {
  return syntaxTree(state).topNode.getChild('Frontmatter');
}

/** Absolute range of the frontmatter line for row `index` (0-based). */
function rowLineRange(
  state: EditorState,
  index: number,
): { from: number; to: number } | null {
  const node = findFrontmatterNode(state);
  if (!node) return null;
  const doc = state.doc;
  const startLine = doc.lineAt(node.from);
  const endLine = doc.lineAt(node.to);
  const lineNumber = startLine.number + 1 + index;
  if (lineNumber >= endLine.number) return null;
  const line = doc.line(lineNumber);
  return { from: line.from, to: line.to };
}

function commitRowLine(view: EditorView, index: number, text: string): void {
  const range = rowLineRange(view.state, index);
  if (!range) return;
  if (view.state.sliceDoc(range.from, range.to) === text) return;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    // Coalesce consecutive keystrokes into one undo step (mirrors the
    // table widget's cell-edit tagging).
    annotations: Transaction.userEvent.of('input.type'),
  });
}

// ---- raw-mode toggle ------------------------------------------------

const setRawMode = StateEffect.define<boolean>();

const rawModeField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setRawMode)) return effect.value;
    }
    return value;
  },
});

// ---- widgets --------------------------------------------------------

class PropertiesWidget extends WidgetType {
  constructor(readonly model: FrontmatterModel) {
    super();
  }

  // Structure-only equality: same row count and same scalar/list kind
  // per row means CM6 keeps the existing DOM, which is what lets the
  // caret survive the rebuild that follows every commit. Keys and
  // values are NOT compared — the DOM already shows what the user
  // typed. (Typing a `[...]` into a scalar cell flips its kind and
  // rebuilds; the caret drops in that edge and the value re-renders
  // as chips, which is the desired end state anyway.)
  eq(other: PropertiesWidget): boolean {
    if (other.model.rows.length !== this.model.rows.length) return false;
    for (let i = 0; i < this.model.rows.length; i++) {
      if ((other.model.rows[i].items === null) !== (this.model.rows[i].items === null)) {
        return false;
      }
    }
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-atomic-fm';
    wrap.setAttribute('contenteditable', 'false');

    const header = document.createElement('div');
    header.className = 'cm-atomic-fm-header';
    const title = document.createElement('span');
    title.className = 'cm-atomic-fm-title';
    title.textContent = 'Properties';
    header.appendChild(title);
    const readOnly = isAtomicDiffView(view.state);
    if (!readOnly) header.appendChild(makeSourceButton(view));
    wrap.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'cm-atomic-fm-grid';
    this.model.rows.forEach((row, i) => {
      grid.appendChild(readOnly ? makeReadOnlyRow(row, i) : makeRow(view, row, i));
    });
    wrap.appendChild(grid);

    if (!readOnly) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'cm-atomic-fm-add';
      add.textContent = '+ Add property';
      add.addEventListener('click', () => addProperty(view, this.model));
      wrap.appendChild(add);
    }

    return wrap;
  }
}

function makeReadOnlyRow(row: PropertyRow, index: number): HTMLElement {
  const rowEl = document.createElement('div');
  rowEl.className = 'cm-atomic-fm-row';
  rowEl.dataset.index = String(index);

  const key = document.createElement('div');
  key.className = 'cm-atomic-fm-key';
  key.textContent = row.key;
  rowEl.appendChild(key);

  const value = document.createElement('div');
  value.className = 'cm-atomic-fm-value';
  if (row.items === null) {
    const scalar = document.createElement('div');
    scalar.className = 'cm-atomic-fm-scalar';
    scalar.textContent = row.value;
    value.appendChild(scalar);
  } else {
    value.classList.add('cm-atomic-fm-chips');
    for (const item of row.items) {
      const chip = document.createElement('span');
      chip.className = 'cm-atomic-fm-chip';
      chip.textContent = item;
      value.appendChild(chip);
    }
  }
  rowEl.appendChild(value);
  return rowEl;
}

// Raw mode replaces the grid with the styled YAML text; this pill above
// the block is the way back.
class PropertiesPillWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'cm-atomic-fm-pill';
    pill.textContent = '⚙ Properties';
    pill.title = 'Show properties editor';
    pill.addEventListener('click', () => {
      view.dispatch({ effects: setRawMode.of(false) });
    });
    return pill;
  }
}

const PROPERTIES_PILL = new PropertiesPillWidget();

function makeSourceButton(view: EditorView): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cm-atomic-fm-src';
  btn.textContent = '{ }';
  btn.title = 'Edit as YAML source';
  btn.addEventListener('click', () => {
    view.dispatch({ effects: setRawMode.of(true) });
  });
  return btn;
}

// ---- editable cells (mirrors table-widget's makeCell contract) ------

function makeEditable(
  className: string,
  text: string,
  commit: (el: HTMLElement) => void,
): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.contentEditable = 'true';
  el.spellcheck = false;
  el.textContent = text;

  // IME / dead-key composition: committing mid-composition dispatches a
  // doc change whose widget rebuild would cancel the session. Suppress
  // until compositionend, then commit once.
  let composing = false;
  el.addEventListener('compositionstart', () => {
    composing = true;
  });
  el.addEventListener('compositionend', () => {
    composing = false;
    commit(el);
  });
  el.addEventListener('input', (event) => {
    if (composing || (event as InputEvent).isComposing) return;
    commit(el);
  });

  // Paste as a single flat line of plain text.
  el.addEventListener('paste', (event) => {
    event.preventDefault();
    const pasted = (event.clipboardData?.getData('text/plain') ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const sel = el.ownerDocument.defaultView?.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(pasted));
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    commit(el);
  });

  // Enter never inserts a newline in a single-line cell; it advances
  // to the next editable cell in the grid.
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const widget = el.closest<HTMLElement>('.cm-atomic-fm');
    if (!widget) return;
    const cells = Array.from(
      widget.querySelectorAll<HTMLElement>('[contenteditable="true"], .cm-atomic-fm-chip-input'),
    );
    const next = cells[cells.indexOf(el) + 1];
    next?.focus();
  });

  return el;
}

function makeRow(view: EditorView, row: PropertyRow, index: number): HTMLElement {
  const rowEl = document.createElement('div');
  rowEl.className = 'cm-atomic-fm-row';
  rowEl.dataset.index = String(index);
  rowEl.dataset.key = row.key;

  const commitFromDom = () => {
    const keyEl = rowEl.querySelector<HTMLElement>('.cm-atomic-fm-key');
    const key = sanitizeKey(keyEl?.textContent ?? '');
    if (key === '') return; // resynced on blur below
    rowEl.dataset.key = key;
    let valueText: string;
    if (row.items !== null) {
      const items = Array.from(
        rowEl.querySelectorAll<HTMLElement>('.cm-atomic-fm-chip'),
      ).map((chip) => chip.dataset.item ?? '');
      valueText = serializeItems(items);
    } else {
      const valueEl = rowEl.querySelector<HTMLElement>('.cm-atomic-fm-scalar');
      const raw = (valueEl?.textContent ?? '').replace(/[\n\r]/g, ' ').trim();
      valueText = serializeScalar(raw);
    }
    commitRowLine(view, index, serializeLine(key, valueText));
  };

  const keyEl = makeEditable('cm-atomic-fm-key', row.key, commitFromDom);
  // An emptied key can't serialize (`: value` isn't a property line);
  // no commit fires while empty, and blur restores the last good key
  // so the DOM and doc can't drift.
  keyEl.addEventListener('blur', () => {
    if (sanitizeKey(keyEl.textContent ?? '') === '') {
      keyEl.textContent = rowEl.dataset.key ?? '';
    }
  });
  rowEl.appendChild(keyEl);

  const valueWrap = document.createElement('div');
  valueWrap.className = 'cm-atomic-fm-value';
  if (row.items !== null) {
    renderChips(valueWrap, row.items, commitFromDom);
  } else {
    valueWrap.appendChild(makeEditable('cm-atomic-fm-scalar', row.value, commitFromDom));
  }
  rowEl.appendChild(valueWrap);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'cm-atomic-fm-remove';
  remove.textContent = '×';
  remove.title = 'Remove property';
  remove.addEventListener('click', () => {
    const range = rowLineRange(view.state, index);
    if (!range) return;
    // Delete the line including its trailing newline.
    view.dispatch({
      changes: { from: range.from, to: Math.min(range.to + 1, view.state.doc.length) },
      annotations: Transaction.userEvent.of('delete'),
    });
  });
  rowEl.appendChild(remove);

  return rowEl;
}

function renderChips(
  valueWrap: HTMLElement,
  items: string[],
  commitFromDom: () => void,
): void {
  valueWrap.replaceChildren();
  valueWrap.classList.add('cm-atomic-fm-chips');
  for (const item of items) {
    const chip = document.createElement('span');
    chip.className = 'cm-atomic-fm-chip';
    chip.dataset.item = item;
    const label = document.createElement('span');
    label.textContent = item;
    chip.appendChild(label);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'cm-atomic-fm-chip-x';
    x.textContent = '×';
    x.title = 'Remove';
    x.addEventListener('click', () => {
      chip.remove();
      commitFromDom();
    });
    chip.appendChild(x);
    valueWrap.appendChild(chip);
  }
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cm-atomic-fm-chip-input';
  input.placeholder = '+';
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      const text = input.value.trim();
      if (text === '') return;
      const chip = document.createElement('span');
      chip.className = 'cm-atomic-fm-chip';
      chip.dataset.item = text;
      valueWrap.insertBefore(chip, input);
      input.value = '';
      commitFromDom();
    } else if (event.key === 'Backspace' && input.value === '') {
      const chips = valueWrap.querySelectorAll('.cm-atomic-fm-chip');
      const last = chips[chips.length - 1];
      if (last) {
        last.remove();
        commitFromDom();
      }
    }
  });
  valueWrap.appendChild(input);
}

function addProperty(view: EditorView, model: FrontmatterModel): void {
  const node = findFrontmatterNode(view.state);
  if (!node) return;
  const endLine = view.state.doc.lineAt(node.to);
  const taken = new Set(model.rows.map((r) => r.key));
  let key = 'property';
  for (let n = 1; taken.has(key); n++) key = `property-${n}`;
  view.dispatch({
    changes: { from: endLine.from, insert: `${key}:\n` },
    annotations: Transaction.userEvent.of('input'),
  });
  // Focus the new row's key cell once the rebuilt widget is in the DOM.
  // Double rAF for the same reason the table widget uses one: the first
  // fires after CM6 processes the dispatch, the second after layout.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const rows = view.dom.querySelectorAll<HTMLElement>('.cm-atomic-fm-row');
      const keyEl = rows[rows.length - 1]?.querySelector<HTMLElement>('.cm-atomic-fm-key');
      keyEl?.focus();
    });
  });
}

// ---- state field ----------------------------------------------------

function buildDecorations(state: EditorState): DecorationSet {
  const node = findFrontmatterNode(state);
  if (!node) return Decoration.none;
  const model = parseModel(state, node);
  if (!model) return Decoration.none;

  if (state.field(rawModeField, false)) {
    // Raw mode: leave the styled YAML text visible, add the way back.
    return Decoration.set([
      Decoration.widget({ widget: PROPERTIES_PILL, block: true, side: -1 }).range(0),
    ]);
  }

  const endLine = state.doc.lineAt(node.to);
  if (intersectsAtomicDiffChange(state, 0, endLine.to)) {
    return Decoration.none;
  }
  const ranges: Range<Decoration>[] = [
    Decoration.replace({ widget: new PropertiesWidget(model), block: true }).range(
      0,
      endLine.to,
    ),
  ];
  return Decoration.set(ranges);
}

// Frontmatter lives at the top of the document, so only changes that
// touch (or precede) the block — plus one line of slack for edits that
// merge the following line into it — can affect the widget.
function changeAffectsFrontmatter(tr: Transaction, prevEnd: number): boolean {
  let affected = false;
  tr.changes.iterChanges((fromA) => {
    if (fromA <= prevEnd + 1) affected = true;
  });
  return affected;
}

const frontmatterField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setRawMode)) return buildDecorations(tr.state);
    }
    if (!tr.docChanged) return deco;
    let prevEnd = 0;
    deco.between(0, tr.startState.doc.length, (_from, to) => {
      prevEnd = Math.max(prevEnd, to);
      return false;
    });
    // No widget yet: any edit near the doc start could create one.
    if (prevEnd === 0) {
      const node = findFrontmatterNode(tr.startState);
      prevEnd = node ? tr.startState.doc.lineAt(node.to).to : tr.startState.doc.lineAt(0).to;
    }
    if (!changeAffectsFrontmatter(tr, prevEnd)) return deco.map(tr.changes);
    return buildDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Backspace with the cursor at the start of the line directly after the
// widget would silently eat the closing fence's newline (and then the
// fence itself), un-closing the frontmatter. Select the block instead —
// a second Backspace then deletes it whole. Mirrors the table widget's
// boundary handling.
function backspaceAtFrontmatterBoundary(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  if (view.state.field(rawModeField, false)) return false;
  const node = findFrontmatterNode(view.state);
  if (!node) return false;
  const model = parseModel(view.state, node);
  if (!model) return false;
  const endLine = view.state.doc.lineAt(node.to);
  if (sel.head !== endLine.to + 1) return false;
  view.dispatch({ selection: EditorSelection.range(0, endLine.to) });
  return true;
}

export function frontmatterProperties(): Extension {
  return [
    rawModeField,
    frontmatterField,
    Prec.high(keymap.of([{ key: 'Backspace', run: backspaceAtFrontmatterBoundary }])),
  ];
}
