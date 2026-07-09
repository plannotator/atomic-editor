import { afterEach, describe, expect, it } from 'vitest';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tables } from '../table-widget';

// A table with prose on both sides so byte-equivalence assertions can
// prove the dispatch touches ONLY the table's source range and leaves
// the surrounding document untouched.
const DOC = [
  '# Title',
  '',
  '| Name | Age |',
  '| --- | --- |',
  '| Alice | 30 |',
  '| Bob | 25 |',
  '',
  'After.',
].join('\n');

const views: EditorView[] = [];
const hosts: HTMLElement[] = [];

function makeView(doc: string): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), tables()],
    }),
  });
  views.push(view);
  return view;
}

function widget(view: EditorView): HTMLElement {
  const wrap = view.dom.querySelector<HTMLElement>('.cm-atomic-table');
  if (!wrap) throw new Error('table widget did not render');
  return wrap;
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  for (const host of hosts.splice(0)) host.remove();
  for (const menu of document.body.querySelectorAll('.cm-atomic-table-menu')) {
    menu.remove();
  }
});

describe('table hover affordances', () => {
  it('renders the three edge controls inside the inner box with aria-labels', () => {
    const view = makeView(DOC);
    const inner = widget(view).querySelector<HTMLElement>('.cm-atomic-table-inner');
    expect(inner).not.toBeNull();

    const addCol = inner!.querySelector<HTMLElement>('.cm-atomic-table-add-col');
    const addRow = inner!.querySelector<HTMLElement>('.cm-atomic-table-add-row');
    const handle = inner!.querySelector<HTMLElement>('.cm-atomic-table-handle');

    for (const btn of [addCol, addRow, handle]) {
      expect(btn).not.toBeNull();
      // Direct children of the inner box — never outside it.
      expect(btn!.parentElement).toBe(inner);
      expect(btn!.tagName).toBe('BUTTON');
      expect(btn!.getAttribute('type')).toBe('button');
    }

    expect(addCol!.getAttribute('aria-label')).toBe('Add column');
    expect(addCol!.title).toBe('Add column');
    expect(addRow!.getAttribute('aria-label')).toBe('Add row');
    expect(handle!.getAttribute('aria-label')).toBe('Table options');
    // Positioning is via class (absolute) — assert class presence, not
    // computed style (happy-dom has no real layout engine).
    expect(addCol!.classList.contains('cm-atomic-table-add-col')).toBe(true);
    expect(addRow!.classList.contains('cm-atomic-table-add-row')).toBe(true);
    expect(handle!.classList.contains('cm-atomic-table-handle')).toBe(true);
  });

  it('add-column appends an empty trailing column (byte-identical to Insert column right on the last column)', () => {
    const view = makeView(DOC);
    const addCol = widget(view).querySelector('.cm-atomic-table-add-col')!;
    click(addCol);

    // Exact serialized expectation: header + every row gain a trailing
    // empty cell; the delimiter widens to three columns.
    const expected = [
      '# Title',
      '',
      '| Name | Age |  |',
      '| --- | --- | --- |',
      '| Alice | 30 |  |',
      '| Bob | 25 |  |',
      '',
      'After.',
    ].join('\n');
    expect(view.state.doc.toString()).toBe(expected);
  });

  it('add-row appends exactly one empty row, prose above/below byte-identical', () => {
    const view = makeView(DOC);
    const addRow = widget(view).querySelector('.cm-atomic-table-add-row')!;
    click(addRow);

    const expected = [
      '# Title',
      '',
      '| Name | Age |',
      '| --- | --- |',
      '| Alice | 30 |',
      '| Bob | 25 |',
      '|  |  |',
      '',
      'After.',
    ].join('\n');
    expect(view.state.doc.toString()).toBe(expected);

    // Prose fences unmoved.
    const out = view.state.doc.toString();
    expect(out.startsWith('# Title\n\n')).toBe(true);
    expect(out.endsWith('\n\nAfter.')).toBe(true);
  });

  it('hovering the wrap and controls never mutates the document', () => {
    const view = makeView(DOC);
    const wrap = widget(view);
    const before = view.state.doc.toString();

    for (const type of ['pointerover', 'mouseover', 'pointerenter', 'mousemove']) {
      wrap.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      for (const cls of [
        '.cm-atomic-table-add-col',
        '.cm-atomic-table-add-row',
        '.cm-atomic-table-handle',
      ]) {
        wrap.querySelector(cls)!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
    }

    expect(view.state.doc.toString()).toBe(before);
  });

  it('the options handle opens the shared menu for the first body cell', async () => {
    const view = makeView(DOC);
    const handle = widget(view).querySelector('.cm-atomic-table-handle')!;
    click(handle);

    const menu = document.body.querySelector<HTMLElement>('.cm-atomic-table-menu');
    expect(menu).not.toBeNull();
    // A body-cell context includes the row items — proving the handle
    // resolved to a `<td>`, not a header cell.
    expect(menu!.textContent).toContain('Insert row above');
    expect(menu!.textContent).toContain('Insert column right');

    // Escape dismisses via the menu's own document listener (attached on
    // a deferred tick, so wait one turn first).
    await new Promise((r) => setTimeout(r, 0));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.querySelector('.cm-atomic-table-menu')).toBeNull();
  });

  it('right-click on a cell still opens the context menu (regression)', () => {
    const view = makeView(DOC);
    const cell = widget(view).querySelector<HTMLElement>('tbody td')!;
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    const menu = document.body.querySelector<HTMLElement>('.cm-atomic-table-menu');
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain('Insert row above');
  });
});
