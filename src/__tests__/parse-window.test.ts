import { afterEach, describe, expect, it } from 'vitest';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { imageBlocks } from '../image-blocks';
import { inlinePreview } from '../inline-preview';
import { tables } from '../table-widget';
import {
  decorationTree,
  MOUNT_PARSE_WINDOW,
  mountParseTarget,
} from '../tree-progress';
import { frontmatter } from '../frontmatter';

// A deterministic document that is far larger than the mount window,
// with one pipe table and one image per section so widget counts are
// exact. Sections are roughly 1 KB, so a 300 KB document holds about
// 300 of each.
function bigDocument(targetBytes: number): { text: string; tables: number; images: number } {
  const parts: string[] = ['---\ntitle: Parse window fixture\n---\n\n# Parse window fixture\n\n'];
  let bytes = parts[0].length;
  let n = 0;
  while (bytes < targetBytes) {
    n += 1;
    const filler = `Section ${n} prose that keeps the parser busy with **bold**, *emphasis*, \`code\` and a [link](https://example.com/${n}). `;
    const section =
      `## Section ${n}\n\n${filler.repeat(6)}\n\n` +
      `| Name | Value |\n| --- | --- |\n| row ${n} | ${n * 2} |\n| other | ${n * 3} |\n\n` +
      `- item one\n- item two\n- [ ] task\n\n` +
      `![figure ${n}](https://example.com/${n}.png)\n\n` +
      `> quote ${n}\n\n`;
    parts.push(section);
    bytes += section.length;
  }
  return { text: parts.join(''), tables: n, images: n };
}

// Block widgets from every decoration source the view knows about.
// Table widgets are block replacements (from < to); image widgets are
// block widgets inserted at a point (from === to).
function countBlockWidgets(view: EditorView): { tables: number; images: number } {
  let tablesSeen = 0;
  let imagesSeen = 0;
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === 'function' ? source(view) : source;
    const iter = set.iter();
    while (iter.value) {
      const spec = iter.value.spec as { block?: boolean; widget?: unknown };
      if (spec.block && spec.widget) {
        if (iter.from < iter.to) tablesSeen += 1;
        else imagesSeen += 1;
      }
      iter.next();
    }
  }
  return { tables: tablesSeen, images: imagesSeen };
}

// `syntaxTree(state)` is the snapshot the language field took when the
// state was built; `ensureSyntaxTree` advances the shared parse context
// and hands back its live tree. Asking it for position 1 with no budget
// is the cheapest way to read the context's current reach.
function parsedLength(state: EditorState): number {
  return (ensureSyntaxTree(state, 1, 0) ?? syntaxTree(state)).length;
}

function countTablesBefore(text: string, pos: number): number {
  return text.slice(0, pos).split('\n| --- | --- |\n').length - 1;
}

const extensions = () => [
  markdown({ base: markdownLanguage, extensions: [frontmatter] }),
  tables(),
  imageBlocks(),
  inlinePreview(),
];

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the tree to grow');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('mountParseTarget', () => {
  it('never exceeds the document and never falls below the window or the viewport', () => {
    const small = EditorState.create({ doc: 'short' });
    expect(mountParseTarget(small)).toBe(5);
    expect(mountParseTarget(small, 10_000)).toBe(5);

    const big = EditorState.create({ doc: 'x'.repeat(MOUNT_PARSE_WINDOW * 4) });
    expect(mountParseTarget(big)).toBe(MOUNT_PARSE_WINDOW);
    expect(mountParseTarget(big, MOUNT_PARSE_WINDOW / 2)).toBe(MOUNT_PARSE_WINDOW);
    expect(mountParseTarget(big, MOUNT_PARSE_WINDOW * 2)).toBe(MOUNT_PARSE_WINDOW * 2);
  });
});

describe('mount-time parse window', () => {
  it('bounds the synchronous parse at state creation to the window', () => {
    const { text } = bigDocument(300 * 1024);
    const state = EditorState.create({ doc: text, extensions: extensions() });
    const treeLen = parsedLength(state);
    // The three decoration fields have run their mount build by now.
    // Lezer finishes the block it is in, so allow one section of slack
    // past the window; the failure this guards is a whole-document
    // parse (treeLen === doc.length) sneaking back into mount.
    expect(treeLen).toBeGreaterThanOrEqual(MOUNT_PARSE_WINDOW);
    expect(treeLen).toBeLessThan(MOUNT_PARSE_WINDOW + 4096);
    expect(treeLen).toBeLessThan(text.length);
  });

  it('a growth rebuild never forces the parser; an edit rebuild reaches the end', () => {
    const { text } = bigDocument(120 * 1024);
    const state = EditorState.create({ doc: text, extensions: extensions() });
    const before = parsedLength(state);
    expect(before).toBeLessThan(text.length);
    // Growth walks what is there and must not push the parser.
    decorationTree(state, 'growth');
    expect(parsedLength(state)).toBe(before);
    // A cursor or focus rebuild stays inside the window.
    expect(decorationTree(state, 'selection').length).toBe(before);
    expect(parsedLength(state)).toBe(before);
    // An edit rebuild forces the whole document, as it always did.
    expect(decorationTree(state, 'edit').length).toBe(text.length);
  });

  it('decorates the window immediately and the rest as the tree grows, with no permanent gap', async () => {
    const { text, tables: tableCount, images: imageCount } = bigDocument(300 * 1024);
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: text, extensions: extensions() }),
      parent,
    });
    views.push(view);

    const treeLen = parsedLength(view.state);
    const initial = countBlockWidgets(view);
    const tablesInWindow = countTablesBefore(text, treeLen);
    expect(tablesInWindow).toBeGreaterThan(0);
    // Every table the tree covers is already a widget, none beyond it.
    expect(initial.tables).toBe(tablesInWindow);
    expect(initial.tables).toBeLessThan(tableCount);

    await waitFor(() => parsedLength(view.state) >= text.length);
    // The final growth effect is dispatched by the same tick that
    // reached the end; give it one more turn to land.
    await waitFor(() => countBlockWidgets(view).tables === tableCount);
    const settled = countBlockWidgets(view);
    expect(settled.tables).toBe(tableCount);
    expect(settled.images).toBe(imageCount);

    // An edit inside the window keeps the document bytes and every
    // widget: decorations are view-only and the edit path forces the
    // whole document exactly as it did before the window existed.
    view.dispatch({ changes: { from: 0, insert: '' }, selection: { anchor: 0 } });
    view.dispatch({ changes: { from: text.indexOf('\n\n## Section 1'), insert: '\n\nInserted line.' } });
    expect(view.state.doc.toString()).toBe(
      text.slice(0, text.indexOf('\n\n## Section 1')) +
        '\n\nInserted line.' +
        text.slice(text.indexOf('\n\n## Section 1')),
    );
    const afterEdit = countBlockWidgets(view);
    expect(afterEdit.tables).toBe(tableCount);
    expect(afterEdit.images).toBe(imageCount);
    parent.remove();
  });

  it('a small document is fully parsed at mount, exactly as before', () => {
    const text = '# Small\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n![x](https://example.com/x.png)\n';
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: text, extensions: extensions() }),
      parent,
    });
    views.push(view);
    expect(parsedLength(view.state)).toBe(text.length);
    expect(countBlockWidgets(view)).toEqual({ tables: 1, images: 1 });
    parent.remove();
  });
});
