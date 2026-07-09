import { afterEach, describe, expect, it } from 'vitest';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  activeCellFormats,
  cellFormatting,
  toggleCellRaw,
  type CellFormat,
} from '../cell-formatting';
import {
  getSelectionCharRange,
  parseCellInline,
  setSelectionCharRange,
  tables,
} from '../table-widget';

// ---- pure toggle math (the byte-exact core) -------------------------

describe('toggleCellRaw — wrap', () => {
  it('wraps a plain selection in bold, selecting the content', () => {
    expect(toggleCellRaw('hello', 0, 5, 'bold')).toEqual({ raw: '**hello**', from: 2, to: 7 });
  });

  it('wraps in italic with a single star', () => {
    expect(toggleCellRaw('hello', 0, 5, 'italic')).toEqual({ raw: '*hello*', from: 1, to: 6 });
  });

  it('wraps in strikethrough', () => {
    expect(toggleCellRaw('hello', 0, 5, 'strikethrough')).toEqual({
      raw: '~~hello~~',
      from: 2,
      to: 7,
    });
  });

  it('wraps a mid-string selection, leaving the rest untouched', () => {
    // "a bold c" — select "bold" (2..6).
    expect(toggleCellRaw('a bold c', 2, 6, 'bold')).toEqual({
      raw: 'a **bold** c',
      from: 4,
      to: 8,
    });
  });

  it('trims leading/trailing whitespace so the delimiters hug the content', () => {
    // " a b " select the whole thing (0..5); markers hug "a b".
    expect(toggleCellRaw(' a b ', 0, 5, 'bold')).toEqual({ raw: ' **a b** ', from: 3, to: 6 });
  });
});

describe('toggleCellRaw — unwrap', () => {
  it('unwraps when the selection is exactly the content', () => {
    expect(toggleCellRaw('**hi**', 2, 4, 'bold')).toEqual({ raw: 'hi', from: 0, to: 2 });
  });

  it('unwraps when the selection includes the delimiters', () => {
    expect(toggleCellRaw('**hi**', 0, 6, 'bold')).toEqual({ raw: 'hi', from: 0, to: 2 });
  });

  it('unwraps the `__` bold variant byte-exact', () => {
    expect(toggleCellRaw('__hi__', 2, 4, 'bold')).toEqual({ raw: 'hi', from: 0, to: 2 });
  });

  it('unwraps the `_` italic variant byte-exact', () => {
    expect(toggleCellRaw('_i_', 1, 2, 'italic')).toEqual({ raw: 'i', from: 0, to: 1 });
  });

  it('unwraps strikethrough', () => {
    expect(toggleCellRaw('~~x~~', 2, 3, 'strikethrough')).toEqual({ raw: 'x', from: 0, to: 1 });
  });

  it('unwraps a nested inner italic without touching the outer bold', () => {
    // "**a *b* c**" — italic "b" is at index 5.
    expect(toggleCellRaw('**a *b* c**', 5, 6, 'italic')).toEqual({
      raw: '**a b c**',
      from: 4,
      to: 5,
    });
  });
});

describe('toggleCellRaw — refusals', () => {
  const cases: Array<[string, string, number, number, CellFormat]> = [
    ['empty selection', 'hello', 2, 2, 'bold'],
    ['whitespace-only selection', 'a   b', 1, 4, 'bold'],
    ['selection crossing a span boundary', '**bold** tail', 4, 11, 'bold'],
    ['same-format span adjacent to the selection', '**a**b', 5, 6, 'bold'],
    ['content containing a star for an italic wrap', 'a*b', 0, 3, 'italic'],
    ['content containing `**` for a bold wrap', 'a**b', 0, 4, 'bold'],
    ['a loose adjacent delimiter char', '*a', 1, 2, 'bold'],
    ['selection crossing a link boundary', '[text](url) x', 3, 13, 'italic'],
  ];
  for (const [name, raw, from, to, format] of cases) {
    it(`refuses: ${name}`, () => {
      expect(toggleCellRaw(raw, from, to, format)).toBeNull();
    });
  }
});

describe('toggleCellRaw — round-trip identity', () => {
  for (const format of ['bold', 'italic', 'strikethrough'] as CellFormat[]) {
    it(`wrap then unwrap restores the original raw and selection (${format})`, () => {
      const wrapped = toggleCellRaw('word', 0, 4, format);
      expect(wrapped).not.toBeNull();
      const back = toggleCellRaw(wrapped!.raw, wrapped!.from, wrapped!.to, format);
      expect(back).toEqual({ raw: 'word', from: 0, to: 4 });
    });
  }
});

describe('toggleCellRaw — escape rules (pinned to the cell parser truth)', () => {
  it('lets an escaped delimiter before the selection NOT block a wrap', () => {
    // "\*not* x" — the leading `\*` is an escaped literal, so the `*` at
    // index 5 is loose but not adjacent to "x" (a space sits between).
    // Wrapping "x" (index 7) succeeds.
    expect(toggleCellRaw('\\*not* x', 7, 8, 'italic')).toEqual({
      raw: '\\*not* *x*',
      from: 8,
      to: 9,
    });
  });

  it('refuses an italic wrap whose content holds a literal (escaped) star', () => {
    // "a\*b" — the content byte `*` (index 2) still breaks the em pair
    // under the cell regex `[^*\n]+?`, which excludes `*` regardless of
    // the escape. So the byte, not the escape, decides: refuse.
    expect(toggleCellRaw('a\\*b', 0, 4, 'italic')).toBeNull();
  });
});

describe('toggleCellRaw — parser consistency', () => {
  // Every wrap result must render as the intended mark in the cell.
  it('a bold wrap parses to one strong token wrapping the text', () => {
    const result = toggleCellRaw('hello', 0, 5, 'bold')!;
    expect(parseCellInline(result.raw)).toEqual([
      { type: 'strong', delim: '**', children: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('an italic wrap parses to one em token', () => {
    const result = toggleCellRaw('hello', 0, 5, 'italic')!;
    expect(parseCellInline(result.raw)).toEqual([
      { type: 'em', delim: '*', children: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('a strike wrap parses to one strike token', () => {
    const result = toggleCellRaw('hello', 0, 5, 'strikethrough')!;
    expect(parseCellInline(result.raw)).toEqual([
      { type: 'strike', children: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('the nested-italic unwrap still parses as bold wrapping plain text', () => {
    const result = toggleCellRaw('**a *b* c**', 5, 6, 'italic')!;
    expect(parseCellInline(result.raw)).toEqual([
      { type: 'strong', delim: '**', children: [{ type: 'text', text: 'a b c' }] },
    ]);
  });
});

describe('activeCellFormats', () => {
  it('reports the format whose span encloses the range', () => {
    expect([...activeCellFormats('**hi**', 2, 4)]).toEqual(['bold']);
  });

  it('reports both nested formats inside a bold-wrapped italic', () => {
    // "**a *b* c**" — inside "b" (index 5).
    expect([...activeCellFormats('**a *b* c**', 5, 6)].sort()).toEqual(['bold', 'italic']);
  });

  it('reports nothing for plain text', () => {
    expect([...activeCellFormats('plain', 1, 3)]).toEqual([]);
  });

  it('ignores links (never a togglable cell format)', () => {
    expect([...activeCellFormats('[text](url)', 2, 4)]).toEqual([]);
  });

  it('matches the renderer on the `___y_z__` inner-em case (scanner sync)', () => {
    // parseCellInline("___y_z__") renders bold > em("y") + "z"; a naive
    // `raw[from-1]` prev-char check would suppress the inner em. Assert the
    // scanner agrees with the renderer: italic is active inside "y".
    expect([...activeCellFormats('___y_z__', 3, 4).values()]).toContain('italic');
    expect(parseCellInline('___y_z__')).toEqual([
      {
        type: 'strong',
        delim: '__',
        children: [
          { type: 'em', delim: '_', children: [{ type: 'text', text: 'y' }] },
          { type: 'text', text: 'z' },
        ],
      },
    ]);
  });
});

// ---- selection <-> char-offset walkers over decorated DOM -----------

describe('getSelectionCharRange / setSelectionCharRange', () => {
  const hosts: HTMLElement[] = [];
  afterEach(() => {
    for (const h of hosts.splice(0)) h.remove();
  });

  // Build a cell-source-like element whose text spans a hidden delimiter
  // span, exactly as the decorated cell DOM does: "ab" + hidden "**" +
  // "cd", textContent "ab**cd".
  function decoratedSource(): HTMLElement {
    const source = document.createElement('div');
    source.className = 'cm-atomic-table-cell-source';
    source.appendChild(document.createTextNode('ab'));
    const mark = document.createElement('span');
    mark.className = 'cm-atomic-mark';
    mark.style.display = 'none';
    mark.textContent = '**';
    source.appendChild(mark);
    source.appendChild(document.createTextNode('cd'));
    document.body.appendChild(source);
    hosts.push(source);
    return source;
  }

  it('round-trips a range that spans a hidden delimiter span', () => {
    const source = decoratedSource();
    setSelectionCharRange(source, 1, 5); // "b" + "**" + "c"
    expect(getSelectionCharRange(source)).toEqual({ from: 1, to: 5 });
  });

  it('counts the hidden span in the offsets', () => {
    const source = decoratedSource();
    setSelectionCharRange(source, 0, 6); // the whole textContent, len 6
    expect(getSelectionCharRange(source)).toEqual({ from: 0, to: 6 });
  });
});

// ---- DOM-level: the live in-cell bar --------------------------------

describe('cellFormatting bar (DOM)', () => {
  const views: EditorView[] = [];
  afterEach(() => {
    for (const view of views.splice(0)) {
      const parent = view.dom.parentElement;
      view.destroy();
      parent?.remove();
    }
  });

  function makeView(doc: string): EditorView {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          markdown({ base: markdownLanguage }),
          tables(),
          cellFormatting(['bold', 'italic', 'strikethrough', 'code', 'link']),
        ],
      }),
    });
    views.push(view);
    return view;
  }

  const DOC = 'intro\n\n| a | b |\n| --- | --- |\n| c | d |\n\noutro';

  function cellSourceWithText(view: EditorView, text: string): HTMLElement | undefined {
    return Array.from(
      view.dom.querySelectorAll<HTMLElement>('.cm-atomic-table-cell-source'),
    ).find((s) => s.textContent === text);
  }

  it('renders the table cells as widgets', () => {
    const view = makeView(DOC);
    // Guard: everything below depends on the widget having rendered.
    expect(cellSourceWithText(view, 'c')).toBeTruthy();
  });

  it('shows a cell bar with only the cell-eligible buttons on a cell selection', () => {
    const view = makeView(DOC);
    const source = cellSourceWithText(view, 'c');
    if (!source) return; // reported separately by the guard test
    setSelectionCharRange(source, 0, 1);
    document.dispatchEvent(new Event('selectionchange'));

    const bar = view.dom.querySelector('.cm-atomic-selection-toolbar-cell');
    expect(bar).toBeTruthy();
    // code + link filtered out → only bold/italic/strikethrough.
    expect(bar!.querySelectorAll('button')).toHaveLength(3);
  });

  it('toggling bold updates the cell raw AND the document, leaving other bytes intact', () => {
    const view = makeView(DOC);
    const source = cellSourceWithText(view, 'c');
    if (!source) return;
    setSelectionCharRange(source, 0, 1);
    document.dispatchEvent(new Event('selectionchange'));

    const bar = view.dom.querySelector('.cm-atomic-selection-toolbar-cell')!;
    const boldButton = bar.querySelector('button')!; // first button = bold
    boldButton.click();

    const cell = source.closest('td')!;
    expect(cell.dataset.raw).toBe('**c**');

    const text = view.state.doc.toString();
    expect(text).toContain('| **c** | d |');
    // Bytes outside the table line are untouched.
    expect(text.startsWith('intro\n\n')).toBe(true);
    expect(text.endsWith('\n\noutro')).toBe(true);
  });

  it('hides the bar when the selection collapses', () => {
    const view = makeView(DOC);
    const source = cellSourceWithText(view, 'c');
    if (!source) return;
    setSelectionCharRange(source, 0, 1);
    document.dispatchEvent(new Event('selectionchange'));
    const bar = view.dom.querySelector<HTMLElement>('.cm-atomic-selection-toolbar-cell')!;
    expect(bar.style.display).not.toBe('none');

    setSelectionCharRange(source, 0, 0); // collapse
    document.dispatchEvent(new Event('selectionchange'));
    expect(bar.style.display).toBe('none');
  });
});
