import { describe, expect, it, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Compartment, type Extension } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import {
  cursorCharLeft,
  cursorCharRight,
  deleteCharBackward,
  deleteCharForward,
  undoDepth,
} from '@codemirror/commands';
import { AtomicCodeMirrorEditor } from '../AtomicCodeMirrorEditor';
import { AtomicDiffEditor } from '../AtomicDiffEditor';
import { linkWidgets, refreshLinkWidgets, type LinkWidgetLink, type LinkWidgetSpec } from '../link-widgets';

// The Workspaces decision chip is the motivating host: a `[statement](url)`
// link whose url names a decision draws as a chip instead of a link.
class ChipWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly text: string,
    readonly onClick?: () => void,
  ) {
    super();
  }

  override eq(other: ChipWidget): boolean {
    return other.url === this.url && other.text === this.text;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'test-chip';
    span.dataset.url = this.url;
    span.textContent = this.text;
    if (this.onClick) span.addEventListener('click', this.onClick);
    return span;
  }
}

function chipSpec(onClick?: () => void): LinkWidgetSpec & { calls: LinkWidgetLink[] } {
  const calls: LinkWidgetLink[] = [];
  return {
    calls,
    match(link) {
      calls.push(link);
      return link.url.startsWith('dec://') ? new ChipWidget(link.url, link.text, onClick) : null;
    },
  };
}

type Mounted = { host: HTMLElement; root: Root; view: EditorView };
const mounts: Mounted[] = [];

function mount(
  markdown: string,
  extensions: Extension[],
  props: { onLinkClick?: (url: string) => void } = {},
): Mounted {
  const host = document.createElement('div');
  host.style.width = '600px';
  host.style.height = '400px';
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <AtomicCodeMirrorEditor markdownSource={markdown} extensions={extensions} {...props} />,
    );
  });
  const editorDom = host.querySelector<HTMLElement>('.cm-editor');
  const view = editorDom ? EditorView.findFromDOM(editorDom) : null;
  if (!view) throw new Error('editor view not mounted');
  const m = { host, root, view };
  mounts.push(m);
  return m;
}

afterEach(() => {
  for (const m of mounts.splice(0)) {
    act(() => m.root.unmount());
    m.host.remove();
  }
});

function focus(view: EditorView): void {
  view.focus();
  // CM6 observes focus through DOM events; flush so `view.hasFocus`
  // and the resulting `focusChanged` update are both current.
  view.dispatch({});
  expect(view.hasFocus).toBe(true);
}

function blur(view: EditorView): void {
  view.contentDOM.blur();
  view.dispatch({});
  expect(view.hasFocus).toBe(false);
}

// happy-dom fires `selectionchange` synchronously when CM6 writes the DOM
// selection, so CM6's observer would re-enter an update in progress. A
// real browser fires it asynchronously. Swallow it around dispatches that
// put the DOM selection inside a still-drawn widget (the frozen cases).
function withoutSelectionChange(run: () => void): void {
  const swallow = (event: Event) => event.stopImmediatePropagation();
  window.addEventListener('selectionchange', swallow, true);
  try {
    run();
  } finally {
    window.removeEventListener('selectionchange', swallow, true);
  }
}

function press(target: HTMLElement): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
}

async function release(): Promise<void> {
  window.dispatchEvent(new PointerEvent('pointerup', { button: 0 }));
  // FREEZE_TAIL_MS is 100.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

const SOURCE = 'Decided: [Ship on Friday](dec://42) today.';
const LINK_FROM = SOURCE.indexOf('[');
const LINK_TO = SOURCE.indexOf(')') + 1;

function chips(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('.test-chip'));
}

describe('linkWidgets', () => {
  it('draws the widget in place of the link and keeps the bytes', () => {
    const spec = chipSpec();
    const { host, view } = mount(SOURCE, [linkWidgets(spec)]);

    expect(chips(host)).toHaveLength(1);
    expect(chips(host)[0].textContent).toBe('Ship on Friday');
    expect(spec.calls[spec.calls.length - 1]).toEqual({
      url: 'dec://42',
      text: 'Ship on Friday',
      from: LINK_FROM,
      to: LINK_TO,
    });
    expect(view.state.doc.toString()).toBe(SOURCE);
  });

  it('never draws the link mark, hidden syntax, or icon beside a widget', () => {
    const { host } = mount(SOURCE, [linkWidgets(chipSpec())]);

    const line = host.querySelector<HTMLElement>('.cm-line');
    expect(line?.querySelector('.cm-atomic-link')).toBeNull();
    expect(chips(host)[0].closest('.cm-atomic-link')).toBeNull();
    // Only the prose and the widget are in the line: no `[`, no `](url)`.
    expect(line?.textContent).toBe('Decided: Ship on Friday today.');
  });

  it('leaves unmatched links on the engine link look', () => {
    const { host } = mount('See [docs](https://example.com) and [x](dec://1).', [
      linkWidgets(chipSpec()),
    ]);

    const link = host.querySelector<HTMLElement>('.cm-atomic-link');
    expect(link?.textContent).toBe('docs');
    expect(chips(host)).toHaveLength(1);
  });

  it('passes the title without its delimiters', () => {
    const spec = chipSpec();
    mount('A [t](dec://1 "the \\"title\\"") b', [linkWidgets(spec)]);
    expect(spec.calls[spec.calls.length - 1]?.title).toBe('the \\"title\\"');
  });

  it('never offers images, reference links, autolinks, wiki links or multi-line links', () => {
    const spec = chipSpec();
    const markdown = [
      '![alt](dec://img)',
      '',
      '[ref text][ref]',
      '',
      '<dec://auto>',
      '',
      '[[dec://wiki|label]]',
      '',
      '[multi](dec://ml "first',
      'second")',
      '',
      '[ref]: dec://ref',
    ].join('\n');
    expect(() => mount(markdown, [linkWidgets(spec)])).not.toThrow();
    expect(spec.calls).toEqual([]);
  });

  it('reveals the source for a caret strictly inside or a selection overlapping it', () => {
    const { host, view } = mount(SOURCE, [linkWidgets(chipSpec())]);
    focus(view);

    view.dispatch({ selection: { anchor: LINK_FROM + 3 } });
    expect(chips(host)).toHaveLength(0);
    expect(host.querySelector('.cm-line')?.textContent).toBe(SOURCE);

    view.dispatch({ selection: { anchor: 2 } });
    expect(chips(host)).toHaveLength(1);

    view.dispatch({ selection: { anchor: 2, head: LINK_FROM + 1 } });
    expect(chips(host)).toHaveLength(0);
  });

  it('reveals on ArrowLeft/Backspace from the end and ArrowRight/Delete from the start', () => {
    const { host, view } = mount(SOURCE, [linkWidgets(chipSpec())]);
    focus(view);

    // From just past the link: one ArrowLeft lands on the link's edge,
    // which reveals the source before any delete can touch `)`.
    view.dispatch({ selection: { anchor: LINK_TO + 1 } });
    expect(chips(host)).toHaveLength(1);
    cursorCharLeft(view);
    expect(view.state.selection.main.head).toBe(LINK_TO);
    expect(chips(host)).toHaveLength(0);
    deleteCharBackward(view);
    expect(view.state.doc.toString()).toBe(SOURCE.slice(0, LINK_TO - 1) + SOURCE.slice(LINK_TO));
    expect(chips(host)).toHaveLength(0);
    view.dispatch({ changes: { from: LINK_TO - 1, insert: ')' } });

    // From just before the link: ArrowRight reaches the `[` edge.
    view.dispatch({ selection: { anchor: LINK_FROM - 1 } });
    expect(chips(host)).toHaveLength(1);
    cursorCharRight(view);
    expect(view.state.selection.main.head).toBe(LINK_FROM);
    expect(chips(host)).toHaveLength(0);
    deleteCharForward(view);
    expect(view.state.doc.toString()).toBe(SOURCE.slice(0, LINK_FROM) + SOURCE.slice(LINK_FROM + 1));
  });

  it('copies the markdown bytes across a drawn widget', async () => {
    // Why this is shaped around a press: CM6 only intercepts copy when the
    // DOM selection is inside a focused editor, and a focused selection
    // that overlaps the link reveals its source (the engine's reveal rule).
    // So the one moment a widget is on screen under a copyable selection is
    // mid-drag, while the press holds the preview frozen. The drag here
    // starts in the prose before the link, like a real one would, and the
    // copy runs both mid-drag (widget drawn) and after release (revealed).
    const { host, view } = mount(SOURCE, [linkWidgets(chipSpec())]);
    focus(view);
    view.dispatch({ selection: { anchor: 0 } });
    const copy = (): string | undefined => {
      const data = new Map<string, string>();
      const event = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          clearData: () => data.clear(),
          setData: (type: string, value: string) => data.set(type, value),
          getData: (type: string) => data.get(type) ?? '',
        },
      });
      view.contentDOM.dispatchEvent(event);
      return data.get('text/plain');
    };

    press(host.querySelector<HTMLElement>('.cm-line') as HTMLElement);
    withoutSelectionChange(() => {
      view.dispatch({ selection: { anchor: 0, head: SOURCE.length } });
    });
    expect(chips(host)).toHaveLength(1);
    expect(copy()).toBe(SOURCE);

    await release();
    expect(chips(host)).toHaveLength(0);
    expect(copy()).toBe(SOURCE);
  });

  it('draws a pasted link as the widget once the caret leaves', () => {
    const { host, view } = mount('Start ', [linkWidgets(chipSpec())]);
    focus(view);
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    const pasted = '[Pasted decision](dec://7)';
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? pasted : '') },
    });
    view.contentDOM.dispatchEvent(event);
    expect(view.state.doc.toString()).toBe(`Start ${pasted}`);
    // Caret sits on the link's end edge: revealed.
    expect(chips(host)).toHaveLength(0);

    view.dispatch({ selection: { anchor: 0 } });
    expect(chips(host).map((c) => c.textContent)).toEqual(['Pasted decision']);
  });

  it('changes no document text and adds no history from a draw or a refresh', () => {
    const docChanges = vi.fn();
    const { host, view } = mount(SOURCE, [
      linkWidgets(chipSpec()),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) docChanges();
      }),
    ]);
    expect(chips(host)).toHaveLength(1);

    view.dispatch({ effects: refreshLinkWidgets.of(null) });
    focus(view);
    view.dispatch({ selection: { anchor: LINK_FROM + 2 } });
    blur(view);
    view.dispatch({ effects: refreshLinkWidgets.of(null) });

    expect(docChanges).not.toHaveBeenCalled();
    expect(undoDepth(view.state)).toBe(0);
    expect(view.state.doc.toString()).toBe(SOURCE);
  });

  it('brings the widget back after an edit inside the link and a blur', () => {
    const spec = chipSpec();
    const { host, view } = mount(SOURCE, [linkWidgets(spec)]);
    focus(view);

    const insertAt = SOURCE.indexOf('Friday');
    view.dispatch({
      changes: { from: insertAt, insert: 'late ' },
      selection: { anchor: insertAt + 5 },
      userEvent: 'input.type',
    });
    expect(chips(host)).toHaveLength(0);

    blur(view);
    expect(chips(host).map((c) => c.textContent)).toEqual(['Ship on late Friday']);
    expect(view.state.doc.toString()).toBe(SOURCE.replace('Friday', 'late Friday'));
  });

  it('holds the widget through a pointer press and routes the click to it', async () => {
    const onChipClick = vi.fn();
    const onLinkClick = vi.fn();
    const { host, view } = mount(SOURCE, [linkWidgets(chipSpec(onChipClick))], { onLinkClick });
    focus(view);
    view.dispatch({ selection: { anchor: 0 } });
    const chip = chips(host)[0];

    press(chip);
    // Mid-press the selection lands inside the link; the frozen preview
    // keeps the widget rather than swapping to the link look or source.
    withoutSelectionChange(() => {
      view.dispatch({ selection: { anchor: LINK_FROM + 2 } });
    });
    expect(chips(host)).toEqual([chip]);
    expect(host.querySelector('.cm-atomic-link')).toBeNull();
    // A refresh mid-press waits for the release as well.
    withoutSelectionChange(() => {
      view.dispatch({ effects: refreshLinkWidgets.of(null) });
    });
    expect(chips(host)).toEqual([chip]);

    chips(host)[0].click();
    expect(onChipClick).toHaveBeenCalledOnce();
    expect(onLinkClick).not.toHaveBeenCalled();

    // After the release (and the freeze tail) the reveal rule applies.
    await release();
    expect(chips(host)).toHaveLength(0);
    expect(host.querySelector('.cm-line')?.textContent).toBe(SOURCE);
  });

  it('asks match again on refreshLinkWidgets', () => {
    const known = new Set<string>();
    const match = vi.fn((link: LinkWidgetLink) =>
      known.has(link.url) ? new ChipWidget(link.url, link.text) : null,
    );
    const { host, view } = mount(SOURCE, [linkWidgets({ match })]);
    expect(chips(host)).toHaveLength(0);
    expect(host.querySelector('.cm-atomic-link')).not.toBeNull();
    const callsBefore = match.mock.calls.length;

    known.add('dec://42');
    view.dispatch({ effects: refreshLinkWidgets.of(null) });
    expect(match.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(chips(host)).toHaveLength(1);
  });

  it('rebuilds when the facet is reconfigured', () => {
    const compartment = new Compartment();
    const { host, view } = mount(SOURCE, [compartment.of([])]);
    expect(chips(host)).toHaveLength(0);

    view.dispatch({ effects: compartment.reconfigure(linkWidgets(chipSpec())) });
    expect(chips(host)).toHaveLength(1);

    view.dispatch({ effects: compartment.reconfigure([]) });
    expect(chips(host)).toHaveLength(0);
    expect(host.querySelector('.cm-atomic-link')).not.toBeNull();
  });

  it('lets the first non-null spec win, in registration order', () => {
    const nullSpec = { match: vi.fn(() => null) };
    const first = { match: vi.fn((l: LinkWidgetLink) => new ChipWidget(l.url, `first ${l.text}`)) };
    const second = { match: vi.fn((l: LinkWidgetLink) => new ChipWidget(l.url, `second ${l.text}`)) };
    const { host } = mount(SOURCE, [linkWidgets(nullSpec, first), linkWidgets(second)]);

    expect(chips(host).map((c) => c.textContent)).toEqual(['first Ship on Friday']);
    expect(nullSpec.match).toHaveBeenCalled();
    expect(second.match).not.toHaveBeenCalled();
  });

  it('falls through a throwing spec to the next one and logs it once', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const throwing = {
        match: vi.fn(() => {
          throw new Error('host bug');
        }),
      };
      const { host, view } = mount(SOURCE, [linkWidgets(throwing, chipSpec())]);
      expect(chips(host)).toHaveLength(1);

      view.dispatch({ effects: refreshLinkWidgets.of(null) });
      view.dispatch({ effects: refreshLinkWidgets.of(null) });
      expect(throwing.match.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it('keeps the engine link when the only spec throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { host } = mount(SOURCE, [
        linkWidgets({
          match() {
            throw new Error('host bug');
          },
        }),
      ]);
      expect(host.querySelector('.cm-atomic-link')).not.toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  it('renders identically with no spec, an always-null spec, or no extension', () => {
    const markdown = [
      '# Title',
      '',
      'See [docs](https://example.com "Docs") and **[bold](x)** here.',
      '',
      '- [ ] a task with [a link](y)',
      '',
      '![img](z.png) and [ref][r] and <https://auto.example>',
      '',
      '[r]: https://ref.example',
    ].join('\n');
    const html = (extensions: Extension[]): string =>
      mount(markdown, extensions).host.querySelector('.cm-content')?.innerHTML ?? '';

    const baseline = html([]);
    expect(baseline).toContain('cm-atomic-link');
    expect(html([linkWidgets()])).toBe(baseline);
    expect(html([linkWidgets({ match: () => null })])).toBe(baseline);
  });

  it('does not offer links inside tables or links whose text holds an image', () => {
    const spec = chipSpec();
    const markdown = [
      '| Decision | Note |',
      '| --- | --- |',
      '| [Ship](dec://1) | ok |',
      '',
      '[![badge](dec://img.png)](dec://2)',
      '',
      'Outside: [Kept](dec://3).',
    ].join('\n');
    const { host } = mount(markdown, [linkWidgets(spec)]);

    expect(spec.calls.map((c) => c.url)).toEqual(['dec://3']);
    expect(chips(host).map((c) => c.textContent)).toEqual(['Kept']);
  });

  it('offers a link after a stray `[` unless a wiki link could claim it', () => {
    const spec = chipSpec();
    mount('A [[open](dec://1) and \\[[esc](dec://2) here.\n\nB [[x](dec://3)]] there.', [
      linkWidgets(spec),
    ]);
    expect(spec.calls.map((c) => c.url)).toEqual(['dec://1', 'dec://2']);
  });
});

describe('linkWidgets in AtomicDiffEditor', () => {
  it('shows the source of a diff-changed link and the widget for an unchanged one', () => {
    const host = document.createElement('div');
    host.style.width = '800px';
    host.style.height = '600px';
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(
          <AtomicDiffEditor
            originalMarkdown={'Kept [Alpha](dec://1).\n\nChanged [Beta](dec://2).\n'}
            modifiedMarkdown={'Kept [Alpha](dec://1).\n\nChanged [Gamma](dec://2).\n'}
            extensions={[linkWidgets(chipSpec())]}
          />,
        );
      });
      expect(chips(host).map((c) => c.textContent)).toEqual(['Alpha']);
      // The changed link's source stays visible as review evidence.
      const changedLine = Array.from(host.querySelectorAll('.cm-line')).find((l) =>
        l.textContent?.includes('Changed'),
      );
      expect(changedLine?.textContent).toContain('](dec://2)');
      expect(changedLine?.querySelector('.test-chip')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
