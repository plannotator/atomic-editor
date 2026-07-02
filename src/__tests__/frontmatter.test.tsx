import { describe, expect, it, afterEach } from 'vitest';
import { createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
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

  it('renders frontmatter as a metadata block, not HR + heading', () => {
    const { host } = mount(WITH_FRONTMATTER);
    const fmLines = host.querySelectorAll('.cm-line.cm-atomic-frontmatter');
    // Opening fence, three YAML lines, closing fence.
    expect(fmLines.length).toBe(5);
    // The old misparse: opening `---` → HorizontalRule, YAML body +
    // closing `---` → SetextHeading2. Neither may appear.
    expect(host.querySelector('.cm-atomic-hr')).toBeNull();
    expect(host.querySelector('.cm-atomic-h2')).toBeNull();
    // The fences stay visible, faded.
    const marks = host.querySelectorAll('.cm-atomic-frontmatter-mark');
    expect(marks.length).toBe(2);
    // The real heading below the block still works.
    expect(host.querySelector('.cm-atomic-h1')).not.toBeNull();
  });

  it('does not swallow YAML-lookalike inline markdown into previews', () => {
    const { host } = mount('---\nkey: *not emphasis*\n---\n');
    // Frontmatter body is an unparsed leaf: no emphasis mark inside.
    expect(host.querySelector('.cm-atomic-frontmatter .cm-atomic-em')).toBeNull();
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
    expect(host.querySelectorAll('.cm-line.cm-atomic-frontmatter').length).toBe(2);
    expect(handle.current?.getMarkdown()).toBe('---\n---\n\nBody.\n');
  });
});
