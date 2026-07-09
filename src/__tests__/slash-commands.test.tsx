import { describe, expect, it, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EditorState, type EditorStateConfig, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import {
  CompletionContext,
  startCompletion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle,
} from '../AtomicCodeMirrorEditor';
import {
  slashCommands,
  slashCommandSource,
  defaultSlashCommands,
  type SlashCommandItem,
} from '../slash-commands';
import { wikiLinks } from '../wiki-links';

type Mounted = { host: HTMLElement; root: Root };
const mounts: Mounted[] = [];
const views: EditorView[] = [];

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

// Runs a completion source against a fresh state built with real
// markdown nodes, mirroring how CM6 would invoke it in the editor.
function runSource(
  source: CompletionSource,
  doc: string,
  pos: number,
  explicit = false,
): CompletionResult | null {
  const state = EditorState.create({ doc, extensions: [markdown()] });
  return source(new CompletionContext(state, pos, explicit)) as CompletionResult | null;
}

// Mounts a real EditorView on `doc`, drives the labeled option's
// `apply` through the range the source would hand CM6, and returns the
// mutated view for byte / selection assertions.
function applyCommand(
  doc: string,
  label: string,
  pos: number,
  config?: Parameters<typeof slashCommands>[0],
): EditorView {
  const view = makeView(doc, [markdown(), slashCommands(config)]);
  const result = runSource(slashCommandSource(config), doc, pos);
  if (!result) throw new Error(`source returned null for ${JSON.stringify(doc)}`);
  const option = result.options.find((o) => o.label === label);
  if (!option) throw new Error(`no option labeled ${label}`);
  if (typeof option.apply !== 'function') throw new Error('apply is not a function');
  option.apply(view, option, result.from, pos);
  return view;
}

describe('slashCommandSource trigger conditions', () => {
  const source = slashCommandSource();

  it('fires on a lone slash at document start', () => {
    const result = runSource(source, '/', 1);
    expect(result).not.toBeNull();
    expect(result?.from).toBe(1);
    expect(result?.options.length).toBe(12);
  });

  it('fires after leading whitespace, with from just past the slash', () => {
    const result = runSource(source, '  /he', 5);
    expect(result).not.toBeNull();
    expect(result?.from).toBe(3);
  });

  it('stays quiet mid-line after text', () => {
    expect(runSource(source, 'text /', 6)).toBeNull();
  });

  it('stays quiet when a non-whitespace list marker precedes the slash', () => {
    expect(runSource(source, '- /', 3)).toBeNull();
  });

  it('stays quiet inside a fenced code block', () => {
    expect(runSource(source, '```\n/\n```', 5)).toBeNull();
  });

  it('stays quiet inside an HTML block', () => {
    expect(runSource(source, '<div>\n/\n</div>', 7)).toBeNull();
  });

  it('stays quiet inside an indented code block', () => {
    const doc = 'text\n\n    /code';
    expect(runSource(source, doc, doc.length)).toBeNull();
  });

  it('does nothing on explicit activation without a typed slash', () => {
    expect(runSource(source, '', 0, true)).toBeNull();
  });

  it('fires for a slash opening a later line', () => {
    const result = runSource(source, 'a\n/', 3);
    expect(result).not.toBeNull();
    expect(result?.from).toBe(3);
  });
});

describe('slashCommandSource inserted bytes', () => {
  const cases: Array<[string, string]> = [
    ['Heading 1', '# '],
    ['Heading 2', '## '],
    ['Heading 3', '### '],
    ['Bulleted list', '- '],
    ['Numbered list', '1. '],
    ['Task list', '- [ ] '],
    ['Quote', '> '],
    ['Divider', '---'],
    ['Image', '![alt](url)'],
  ];

  for (const [label, expected] of cases) {
    it(`inserts ${JSON.stringify(expected)} for ${label}`, () => {
      const view = applyCommand('/', label, 1);
      expect(view.state.doc.toString()).toBe(expected);
    });
  }

  it('inserts a code block and lands the cursor at the fence-info tab stop', () => {
    const view = applyCommand('/', 'Code block', 1);
    expect(view.state.doc.toString()).toBe('```\n\n```');
    expect(view.state.selection.main.head).toBe(3);
    expect(view.state.selection.main.empty).toBe(true);
  });

  it('inserts a 2×2 table and selects the first column placeholder', () => {
    const view = applyCommand('/', 'Table', 1);
    expect(view.state.doc.toString()).toBe(
      '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |',
    );
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(10);
  });

  it('inserts a link and selects the text placeholder', () => {
    const view = applyCommand('/', 'Link', 1);
    expect(view.state.doc.toString()).toBe('[text](url)');
    expect(view.state.selection.main.from).toBe(1);
    expect(view.state.selection.main.to).toBe(5);
  });
});

describe('slashCommandSource query-text replacement', () => {
  it('consumes the whole /query including the slash, preserving leading whitespace', () => {
    const doc = '  /hea';
    const pos = 6;
    const result = runSource(slashCommandSource(), doc, pos);
    expect(result?.from).toBe(3);
    const view = makeView(doc, [markdown(), slashCommands()]);
    const option = result?.options.find((o) => o.label === 'Heading 1');
    if (typeof option?.apply !== 'function') throw new Error('apply is not a function');
    option.apply(view, option, result!.from, pos);
    expect(view.state.doc.toString()).toBe('  # ');
  });
});

describe('slashCommandSource config surface', () => {
  it('appends custom items after the defaults', () => {
    const items: SlashCommandItem[] = [{ label: 'Callout', snippet: '> [!note] ' }];
    const result = runSource(slashCommandSource({ items }), '/', 1);
    expect(result?.options.length).toBe(13);
    expect(result?.options.some((o) => o.label === 'Callout')).toBe(true);
  });

  it('applies a custom item snippet', () => {
    const items: SlashCommandItem[] = [{ label: 'Callout', snippet: '> [!note] ' }];
    const view = applyCommand('/', 'Callout', 1, { items });
    expect(view.state.doc.toString()).toBe('> [!note] ');
  });

  it('replaces the defaults entirely with replaceDefaults', () => {
    const items: SlashCommandItem[] = [{ label: 'Callout', snippet: '> [!note] ' }];
    const result = runSource(slashCommandSource({ items, replaceDefaults: true }), '/', 1);
    expect(result?.options.length).toBe(1);
  });

  it('leaks no default labels when replaceDefaults empties the set', () => {
    const result = runSource(slashCommandSource({ replaceDefaults: true }), '/', 1);
    // Implementation returns a non-null result with an empty option list.
    expect(result).not.toBeNull();
    expect(result?.options.length).toBe(0);
    const defaultLabels = new Set(defaultSlashCommands.map((c) => c.label));
    for (const option of result?.options ?? []) {
      expect(defaultLabels.has(option.label)).toBe(false);
    }
  });

  it('exposes the twelve default commands in stable order', () => {
    expect(defaultSlashCommands.length).toBe(12);
    expect(defaultSlashCommands.map((c) => c.label)).toEqual([
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Bulleted list',
      'Numbered list',
      'Task list',
      'Quote',
      'Code block',
      'Table',
      'Divider',
      'Link',
      'Image',
    ]);
  });
});

describe('slashCommands byte fidelity', () => {
  const doc = '/heading\ntext /mid\n- /item\n```\n/fence\n```\nhttps://example.com\n/';

  it('never mutates slash-heavy content in a bare view without user input', () => {
    const view = makeView(doc, [markdown(), slashCommands()]);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('never mutates slash-heavy content mounted in the React editor', () => {
    const handleRef: { current: AtomicCodeMirrorEditorHandle | null } = { current: null };
    const onMarkdownChange = vi.fn();
    const host = document.createElement('div');
    host.style.width = '600px';
    host.style.height = '400px';
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <AtomicCodeMirrorEditor
          markdownSource={doc}
          editorHandleRef={handleRef}
          onMarkdownChange={onMarkdownChange}
          extensions={[slashCommands()]}
        />,
      );
    });
    mounts.push({ host, root });

    expect(handleRef.current?.getMarkdown()).toBe(doc);
    expect(onMarkdownChange).not.toHaveBeenCalled();
  });
});

async function openSlashTooltip(view: EditorView): Promise<Element> {
  view.focus();
  view.dispatch({
    changes: { from: 0, insert: '/' },
    selection: { anchor: 1 },
    userEvent: 'input.type',
  });
  startCompletion(view);

  return vi.waitFor(
    () => {
      const el =
        view.dom.querySelector('.cm-tooltip-autocomplete') ??
        document.body.querySelector('.cm-tooltip-autocomplete');
      if (!el) throw new Error('tooltip not yet rendered');
      return el;
    },
    { timeout: 2000, interval: 20 },
  );
}

describe('slashCommands DOM integration', () => {
  it('renders the twelve options in boost order after typing a slash', async () => {
    const view = makeView('', [markdown(), slashCommands()]);
    const tooltip = await openSlashTooltip(view);

    const labels = Array.from(tooltip.querySelectorAll('li .cm-completionLabel')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(defaultSlashCommands.map((c) => c.label));
  });

  it('coexists with wikiLinks suggestions without a config merge conflict', async () => {
    // The demo runs exactly this pairing; before the language-data
    // registration change, two `override`-based autocompletion configs
    // threw 'Config merge conflict' at state creation.
    const view = makeView('', [
      markdown(),
      slashCommands(),
      wikiLinks({ suggest: async () => [{ target: 'atom-1', label: 'Atom One' }] }),
    ]);
    const tooltip = await openSlashTooltip(view);

    expect(tooltip.querySelectorAll('li').length).toBe(12);
  });
});
