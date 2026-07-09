import { afterEach, describe, expect, it } from 'vitest';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tables } from '../table-widget';

// Regression: typing a new row directly beneath a rendered table used to
// corrupt the document. In a live view, the instant lezer absorbs the
// just-typed `| … |` line into the Table node, the atomic block-replace
// widget grew to cover the caret's line; with no editable text position
// left for the caret, CM6 dropped the DOM selection inside the widget's
// first contenteditable cell and every further keystroke landed there,
// scrambling the source (observed in the browser; see the scratchpad
// Playwright repro).
//
// The fix reveals a table's raw source while the caret sits on its LAST
// line, so the caret always has a real text position to live on; the
// widget folds the finished row in as soon as the caret leaves. That
// caret-trap itself needs a real DOM selection sync (it does not surface
// in happy-dom), so these tests assert the deterministic decision that
// prevents it: whether the widget is rendered or the source is revealed,
// keyed off the selection — plus that selection moves never touch the
// bytes.

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

const hasWidget = (view: EditorView): boolean =>
  view.dom.querySelector('.cm-atomic-table') != null;
const tbodyRows = (view: EditorView): number =>
  view.dom.querySelectorAll('.cm-atomic-table tbody tr').length;

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  for (const host of hosts.splice(0)) host.remove();
});

describe('table row absorption (caret-on-last-line source reveal)', () => {
  it('renders the widget when the caret is not on the table', () => {
    // Caret on the leading prose line, off the table entirely.
    const view = makeView('intro\n\n| Name | Role |\n| --- | --- |\n| Ada | Math |');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(hasWidget(view)).toBe(true);
    expect(tbodyRows(view)).toBe(1);
  });

  it('reveals source (no widget) while the caret sits on the table last line', () => {
    const doc = 'intro\n\n| Name | Role |\n| --- | --- |\n| Ada | Math |';
    const view = makeView(doc);
    const lastLine = view.state.doc.line(view.state.doc.lines);
    view.dispatch({ selection: EditorSelection.cursor(lastLine.from + 3) });
    expect(hasWidget(view)).toBe(false);
    // Selection-only moves never edit the document.
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('does not exempt a table on mount when the doc opens with one (caret at 0 is the header line)', () => {
    // A document that begins with a multi-row table must still render as a
    // widget with the default caret at position 0 (the header, not the
    // last line) — the exemption is last-line-only for exactly this.
    const view = makeView('| Name | Role |\n| --- | --- |\n| Ada | Math |');
    expect(hasWidget(view)).toBe(true);
    expect(tbodyRows(view)).toBe(1);
  });

  it('absorbs a row typed below the table without corrupting the source', () => {
    // Rendered table with a trailing empty line; caret parked on it.
    const view = makeView('intro\n\n| Name | Role |\n| --- | --- |\n');
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    expect(hasWidget(view)).toBe(true);
    expect(tbodyRows(view)).toBe(0);

    // Type the row one character at a time, keeping the caret on that
    // line — the same shape as the real keystroke flow.
    for (const ch of '| Ada | Math |') {
      const at = view.state.doc.length;
      view.dispatch({
        changes: { from: at, insert: ch },
        selection: EditorSelection.cursor(at + 1),
      });
      // Throughout absorption the caret owns its own editable line, so
      // the widget yields to source and the bytes stay exactly typed.
      expect(hasWidget(view)).toBe(false);
    }
    expect(view.state.doc.toString()).toBe(
      'intro\n\n| Name | Role |\n| --- | --- |\n| Ada | Math |',
    );

    // Caret leaves the table -> the finished row folds into the widget.
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(hasWidget(view)).toBe(true);
    expect(tbodyRows(view)).toBe(1);
    expect(view.state.doc.toString()).toBe(
      'intro\n\n| Name | Role |\n| --- | --- |\n| Ada | Math |',
    );
  });
});
