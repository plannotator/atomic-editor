import { describe, expect, it, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EditorState, type EditorStateConfig, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { AtomicCodeMirrorEditor } from '../AtomicCodeMirrorEditor';
import { wikiLinks } from '../wiki-links';

type Mounted = { host: HTMLElement; root: Root };
const mounts: Mounted[] = [];
const views: EditorView[] = [];

function mount(markdown: string, options: Parameters<typeof wikiLinks>[0] = {}): Mounted {
  const host = document.createElement('div');
  host.style.width = '600px';
  host.style.height = '400px';
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <AtomicCodeMirrorEditor
        markdownSource={markdown}
        extensions={[
          wikiLinks({
            resolve: async (target) => ({ target, label: 'Resolved Target', status: 'resolved' }),
            ...options,
          }),
        ]}
      />,
    );
  });
  const m = { host, root };
  mounts.push(m);
  return m;
}

afterEach(() => {
  for (const m of mounts.splice(0)) {
    act(() => m.root.unmount());
    m.host.remove();
  }
  for (const view of views.splice(0)) {
    const parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  }
});

function makeView(
  doc: string,
  extensions: Extension,
  selection?: EditorStateConfig['selection'],
): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions, selection }),
  });
  views.push(view);
  return view;
}

// Resolutions land from promise callbacks, so a macrotask turn drains
// the resolve → .then(dispatch) chain and lets CM6 repaint. Wrapped in
// `act` to keep React quiet on the mount-based paths.
async function flushResolutions(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('wikiLinks', () => {
  it('renders labeled wiki links without exposing the target as visible link text', () => {
    const { host } = mount('Linked atom: [[atom-123|Project Atlas]]');

    const link = host.querySelector<HTMLElement>('.cm-atomic-wiki-link');
    expect(link).not.toBeNull();
    expect(link?.dataset.wikiLinkTarget).toBe('atom-123');
    expect(link?.textContent).toBe('Project Atlas');

    const hiddenSyntax = host.querySelector('.cm-atomic-wiki-link-hidden-syntax');
    expect(hiddenSyntax?.textContent).toContain('atom-123');
  });

  it('leaves inline-code wiki-link text untouched', () => {
    const { host } = mount('Code: `[[atom-123|Project Atlas]]`');

    expect(host.querySelector('.cm-atomic-wiki-link')).toBeNull();
    expect(host.textContent).toContain('[[atom-123|Project Atlas]]');
  });

  it('opens on plain click by default when an opener is configured', () => {
    const onOpen = vi.fn();
    const { host } = mount('Linked atom: [[atom-123|Project Atlas]]', {
      onOpen,
    });

    host.querySelector<HTMLElement>('.cm-atomic-wiki-link')?.click();
    expect(onOpen).toHaveBeenCalledWith('atom-123');
  });

  it('can require modifier-click for opening', () => {
    const onOpen = vi.fn();
    const { host } = mount('Linked atom: [[atom-123|Project Atlas]]', {
      onOpen,
      openOnClick: false,
    });

    host.querySelector<HTMLElement>('.cm-atomic-wiki-link')?.click();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not resolve a bare wiki link while the cursor is inside it', () => {
    const resolve = vi.fn(async (target: string) => ({ target, label: 'Resolved Target', status: 'resolved' as const }));
    const cursorInsideTarget = 'Draft: [['.length + 2;
    const view = makeView(
      'Draft: [[atom-123]]',
      [wikiLinks({ resolve })],
      { anchor: cursorInsideTarget },
    );

    expect(resolve).not.toHaveBeenCalled();

    view.dispatch({ selection: { anchor: view.state.doc.length } });

    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith('atom-123');
  });

  it('does not resolve or decorate bare links rejected by the resolver policy', () => {
    const resolve = vi.fn(async (target: string) => ({ target, label: 'Resolved Target', status: 'resolved' as const }));
    const view = makeView('Draft: [[not-an-atom-id]]', [
      wikiLinks({
        resolve,
        shouldResolve: () => false,
      }),
    ]);

    expect(resolve).not.toHaveBeenCalled();
    expect(view.dom.querySelector('.cm-atomic-wiki-link')).toBeNull();
    expect(view.dom.textContent).toContain('[[not-an-atom-id]]');
  });

  it('reveals a rendered bare link before backspacing through it', () => {
    const doc = 'Before [[missing-target]] after';
    const view = makeView(
      doc,
      [
        wikiLinks({
          resolve: async (target) => ({ target, label: 'Missing atom', status: 'missing' }),
        }),
      ],
      { anchor: 'Before [[missing-target]]'.length },
    );

    const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    const dispatched = view.contentDOM.dispatchEvent(event);

    expect(dispatched).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main.head).toBe('Before [[missing-target'.length);
  });

  it('registers a completion source with stable identity across languageData reads', () => {
    // CM6's autocomplete keys async query tracking on source identity;
    // a provider minting a fresh closure per languageDataAt read makes
    // every update look like a new source, so the (async) suggestion
    // result is dropped and the tooltip never appears. Regression test
    // for exactly that bug.
    const state = EditorState.create({
      extensions: [wikiLinks({ suggest: async () => [] })],
    });
    const first = state.languageDataAt<unknown>('autocomplete', 0);
    const second = state.languageDataAt<unknown>('autocomplete', 0);
    expect(first.length).toBe(1);
    expect(first[0]).toBe(second[0]);
  });

  it('prefers the resolved title for a labeled link when preferResolvedLabel is on', async () => {
    const view = makeView('Linked: [[atom-123|Old Label]]', [
      wikiLinks({
        preferResolvedLabel: true,
        resolve: async (target) => ({ target, label: 'Renamed Title', status: 'resolved' }),
      }),
    ]);

    await flushResolutions();

    const link = view.dom.querySelector<HTMLElement>('.cm-atomic-wiki-link');
    expect(link?.textContent).toBe('Renamed Title');
    expect(link?.className).toContain('cm-atomic-wiki-link-resolved');
    expect(link?.dataset.wikiLinkTarget).toBe('atom-123');
    // The stored bytes stay in the document, tucked inside a hidden-syntax
    // span rather than shown as the visible link text.
    const hidden = view.dom.querySelector('.cm-atomic-wiki-link-hidden-syntax');
    expect(hidden?.textContent).toContain('Old Label');
    expect(hidden?.textContent).toContain('atom-123');
  });

  it('keeps the stored label while a preferred resolution is pending', async () => {
    const view = makeView('Linked: [[atom-123|Old Label]]', [
      wikiLinks({
        preferResolvedLabel: true,
        resolve: () => new Promise<never>(() => {}),
      }),
    ]);

    await flushResolutions();

    const link = view.dom.querySelector<HTMLElement>('.cm-atomic-wiki-link');
    expect(link?.textContent).toBe('Old Label');
    expect(link?.className).toContain('cm-atomic-wiki-link-loading');
  });

  it('keeps the stored label with a missing class when resolve returns null', async () => {
    const view = makeView('Linked: [[atom-123|Old Label]]', [
      wikiLinks({
        preferResolvedLabel: true,
        resolve: async () => null,
      }),
    ]);

    await flushResolutions();

    const link = view.dom.querySelector<HTMLElement>('.cm-atomic-wiki-link');
    expect(link?.textContent).toBe('Old Label');
    expect(link?.className).toContain('cm-atomic-wiki-link-missing');
  });

  it('keeps the stored label with a missing class when the resolution status is missing', async () => {
    const view = makeView('Linked: [[atom-123|Old Label]]', [
      wikiLinks({
        preferResolvedLabel: true,
        resolve: async (target) => ({ target, label: 'Whatever', status: 'missing' }),
      }),
    ]);

    await flushResolutions();

    const link = view.dom.querySelector<HTMLElement>('.cm-atomic-wiki-link');
    expect(link?.textContent).toBe('Old Label');
    expect(link?.textContent).not.toBe('Whatever');
    expect(link?.className).toContain('cm-atomic-wiki-link-missing');
  });

  it('falls back to the stored label when the resolved title trims empty', async () => {
    const view = makeView('Linked: [[atom-123|Old Label]]', [
      wikiLinks({
        preferResolvedLabel: true,
        resolve: async (target) => ({ target, label: '   ', status: 'resolved' }),
      }),
    ]);

    await flushResolutions();

    const link = view.dom.querySelector<HTMLElement>('.cm-atomic-wiki-link');
    expect(link?.textContent).toBe('Old Label');
    expect(link?.className).toContain('cm-atomic-wiki-link-resolved');
  });

  it('never resolves a labeled link when preferResolvedLabel is off', async () => {
    const resolve = vi.fn(async (target: string) => ({ target, label: 'Renamed Title', status: 'resolved' as const }));
    const view = makeView('Linked: [[atom-123|Old Label]]', [wikiLinks({ resolve })]);

    await flushResolutions();

    expect(resolve).not.toHaveBeenCalled();
    const link = view.dom.querySelector<HTMLElement>('.cm-atomic-wiki-link');
    expect(link?.textContent).toBe('Old Label');
    expect(link?.className).toContain('cm-atomic-wiki-link-resolved');
  });

  it('respects the shouldResolve gate for labeled links even with the flag on', async () => {
    const resolve = vi.fn(async (target: string) => ({ target, label: 'Renamed Title', status: 'resolved' as const }));
    const view = makeView('Linked: [[atom-123|Old Label]]', [
      wikiLinks({
        preferResolvedLabel: true,
        resolve,
        shouldResolve: () => false,
      }),
    ]);

    await flushResolutions();

    expect(resolve).not.toHaveBeenCalled();
    const link = view.dom.querySelector<HTMLElement>('.cm-atomic-wiki-link');
    expect(link?.textContent).toBe('Old Label');
    expect(link?.className).toContain('cm-atomic-wiki-link-resolved');
  });

  it('never rewrites document bytes while resolving labeled links', async () => {
    const doc = 'A [[atom-1|One]] and [[atom-2|Two]] and [[atom-3|Three]].';
    const titles: Record<string, string> = { 'atom-1': 'First', 'atom-2': 'Second' };
    const view = makeView(doc, [
      wikiLinks({
        preferResolvedLabel: true,
        resolve: async (target) => {
          const label = titles[target];
          return label ? { target, label, status: 'resolved' } : null;
        },
      }),
    ]);

    await flushResolutions();

    expect(view.state.doc.toString()).toBe(doc);
  });
});
