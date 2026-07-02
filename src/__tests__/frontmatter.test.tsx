import { describe, expect, it, afterEach } from 'vitest';
import { createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle,
} from '../AtomicCodeMirrorEditor';

type Mounted = {
  host: HTMLElement;
  root: Root;
  handle: { current: AtomicCodeMirrorEditorHandle | null };
};
const mounts: Mounted[] = [];

function mount(markdown: string): Mounted {
  const host = document.createElement('div');
  host.style.width = '600px';
  host.style.height = '400px';
  document.body.appendChild(host);
  const root = createRoot(host);
  const handle = createRef<AtomicCodeMirrorEditorHandle | null>() as {
    current: AtomicCodeMirrorEditorHandle | null;
  };
  act(() => {
    root.render(
      <AtomicCodeMirrorEditor markdownSource={markdown} editorHandleRef={handle} />,
    );
  });
  const m = { host, root, handle };
  mounts.push(m);
  return m;
}

afterEach(() => {
  for (const m of mounts.splice(0)) {
    act(() => m.root.unmount());
    m.host.remove();
  }
});

// Parser-level probe: node names in the syntax tree. Presentation is
// covered by frontmatter-properties.test.tsx (the block is normally
// hidden behind the Properties widget, so class-based assertions on
// the raw lines only hold in fallback modes).
function treeNames(host: HTMLElement): string[] {
  const view = EditorView.findFromDOM(host);
  const names: string[] = [];
  syntaxTree(view!.state).iterate({
    enter(node) {
      names.push(node.name);
    },
  });
  return names;
}

const WITH_FRONTMATTER = `---
title: Spike Plan
tags: [a, b]
status: draft
---

# Heading

Body text.
`;

describe('frontmatter parsing', () => {
  it('round-trips frontmatter byte-identically', () => {
    const { handle } = mount(WITH_FRONTMATTER);
    expect(handle.current?.getMarkdown()).toBe(WITH_FRONTMATTER);
  });

  it('parses frontmatter as a dedicated node, not HR + heading', () => {
    const { host } = mount(WITH_FRONTMATTER);
    const names = treeNames(host);
    expect(names).toContain('Frontmatter');
    expect(names.filter((n) => n === 'FrontmatterMark').length).toBe(2);
    // The old misparse: opening `---` → HorizontalRule, YAML body +
    // closing `---` → SetextHeading2. Neither may appear.
    expect(names).not.toContain('HorizontalRule');
    expect(names).not.toContain('SetextHeading2');
    expect(host.querySelector('.cm-atomic-hr')).toBeNull();
    expect(host.querySelector('.cm-atomic-h2')).toBeNull();
    // The real heading below the block still works.
    expect(host.querySelector('.cm-atomic-h1')).not.toBeNull();
  });

  it('does not parse markdown inside the frontmatter body', () => {
    const { host } = mount('---\nkey: *not emphasis*\n---\n');
    // Frontmatter body is an unparsed leaf: no emphasis node inside.
    expect(treeNames(host)).not.toContain('Emphasis');
  });

  it('leaves a mid-document `---` as a horizontal rule', () => {
    const { host, handle } = mount('Intro paragraph.\n\n---\n\nAfter the rule.\n');
    expect(host.querySelector('.cm-atomic-frontmatter')).toBeNull();
    expect(host.querySelector('.cm-atomic-hr')).not.toBeNull();
    expect(handle.current?.getMarkdown()).toBe('Intro paragraph.\n\n---\n\nAfter the rule.\n');
  });

  it('leaves setext headings alone when the doc does not open with ---', () => {
    const { host } = mount('Title line\n---\n\nBody.\n');
    expect(host.querySelector('.cm-atomic-frontmatter')).toBeNull();
    expect(host.querySelector('.cm-atomic-h2')).not.toBeNull();
  });

  it('does not treat a longer dash run (thematic break) as frontmatter', () => {
    const { host } = mount('----\n\nBody.\n');
    expect(host.querySelector('.cm-atomic-frontmatter')).toBeNull();
    expect(host.querySelector('.cm-atomic-hr')).not.toBeNull();
  });

  it('round-trips an unclosed opening fence byte-identically', () => {
    const unclosed = '---\ntitle: still typing';
    const { handle } = mount(unclosed);
    expect(handle.current?.getMarkdown()).toBe(unclosed);
  });

  it('handles an empty frontmatter block', () => {
    const { host, handle } = mount('---\n---\n\nBody.\n');
    expect(treeNames(host)).toContain('Frontmatter');
    expect(handle.current?.getMarkdown()).toBe('---\n---\n\nBody.\n');
  });

  // Incremental-reparse coverage: the block parser only fires at
  // lineStart 0, so it must keep firing when lezer reparses after
  // edits inside (or around) the block, not just on a fresh mount.
  it('survives an edit inside the frontmatter body', () => {
    const { host, handle } = mount(WITH_FRONTMATTER);
    const view = EditorView.findFromDOM(host as HTMLElement);
    expect(view).not.toBeNull();
    act(() => {
      // Append to the `title:` line (offset 21 = end of "Spike Plan").
      view!.dispatch({ changes: { from: 21, insert: ' v2' } });
    });
    expect(handle.current?.getMarkdown()).toBe(
      WITH_FRONTMATTER.replace('Spike Plan', 'Spike Plan v2'),
    );
    const names = treeNames(host);
    expect(names).toContain('Frontmatter');
    expect(names).not.toContain('SetextHeading2');
    expect(host.querySelector('.cm-atomic-h2')).toBeNull();
    expect(host.querySelector('.cm-atomic-hr')).toBeNull();
  });

  it('snaps an unclosed fence into frontmatter once the close is typed', () => {
    const { host, handle } = mount('---\ntitle: draft\n# Heading\n');
    const view = EditorView.findFromDOM(host as HTMLElement);
    act(() => {
      // Type the closing fence between the YAML line and the heading
      // (position 17 = just after the newline that ends `title: draft`).
      view!.dispatch({ changes: { from: 17, insert: '---\n' } });
    });
    expect(handle.current?.getMarkdown()).toBe('---\ntitle: draft\n---\n# Heading\n');
    expect(treeNames(host)).toContain('Frontmatter');
    // The heading is outside the block again.
    expect(host.querySelector('.cm-atomic-h1')).not.toBeNull();
  });

  it('reverts to plain markdown when the opening fence is deleted', () => {
    const { host, handle } = mount(WITH_FRONTMATTER);
    const view = EditorView.findFromDOM(host as HTMLElement);
    act(() => {
      // Delete the opening `---\n`.
      view!.dispatch({ changes: { from: 0, to: 4 } });
    });
    expect(handle.current?.getMarkdown()).toBe(WITH_FRONTMATTER.slice(4));
    expect(host.querySelector('.cm-atomic-frontmatter')).toBeNull();
  });
});
