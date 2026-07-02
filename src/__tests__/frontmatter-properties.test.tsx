import { describe, expect, it, afterEach } from 'vitest';
import { createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EditorView } from '@codemirror/view';
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

// Set an editable cell's text and fire the input event the widget
// listens for (same commit path a real keystroke takes).
function typeInto(el: HTMLElement, text: string) {
  act(() => {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: false }));
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const DOC = `---
title: Spike Plan
tags: [a, b]
status: draft
---

# Heading

Body text.
`;

describe('frontmatter properties widget', () => {
  it('replaces parseable frontmatter with a properties grid', () => {
    const { host } = mount(DOC);
    const widget = host.querySelector('.cm-atomic-fm');
    expect(widget).not.toBeNull();
    const rows = host.querySelectorAll('.cm-atomic-fm-row');
    expect(rows.length).toBe(3);
    // Raw YAML lines are hidden behind the block widget.
    expect(host.querySelector('.cm-line.cm-atomic-frontmatter')).toBeNull();
    // tags renders as chips, scalars as text cells.
    expect(host.querySelectorAll('.cm-atomic-fm-chip').length).toBe(2);
    expect(host.querySelectorAll('.cm-atomic-fm-scalar').length).toBe(2);
  });

  it('is byte-identical with the widget active and no interaction', () => {
    const { handle } = mount(DOC);
    expect(handle.current?.getMarkdown()).toBe(DOC);
  });

  it('editing a value rewrites only that line', () => {
    const { host, handle } = mount(DOC);
    const scalar = host.querySelector<HTMLElement>('.cm-atomic-fm-scalar');
    typeInto(scalar!, 'Spike Plan v2');
    expect(handle.current?.getMarkdown()).toBe(DOC.replace('Spike Plan', 'Spike Plan v2'));
  });

  it('renaming a key rewrites only that line', () => {
    const { host, handle } = mount(DOC);
    const key = host.querySelector<HTMLElement>('.cm-atomic-fm-key');
    typeInto(key!, 'name');
    expect(handle.current?.getMarkdown()).toBe(DOC.replace('title:', 'name:'));
  });

  it('quotes values that would change meaning written bare', () => {
    const { host, handle } = mount(DOC);
    const scalar = host.querySelector<HTMLElement>('.cm-atomic-fm-scalar');
    typeInto(scalar!, 'has: colon');
    expect(handle.current?.getMarkdown()).toContain('title: "has: colon"\n');
  });

  it('removes a property row', () => {
    const { host, handle } = mount(DOC);
    const remove = host.querySelector<HTMLElement>('.cm-atomic-fm-remove');
    click(remove!);
    expect(handle.current?.getMarkdown()).toBe(DOC.replace('title: Spike Plan\n', ''));
  });

  it('adds a property with a unique key before the closing fence', () => {
    const { host, handle } = mount(DOC);
    click(host.querySelector('.cm-atomic-fm-add')!);
    expect(handle.current?.getMarkdown()).toBe(
      DOC.replace('status: draft\n---', 'status: draft\nproperty:\n---'),
    );
    expect(host.querySelectorAll('.cm-atomic-fm-row').length).toBe(4);
  });

  it('removes a list item via its chip', () => {
    const { host, handle } = mount(DOC);
    const x = host.querySelector<HTMLElement>('.cm-atomic-fm-chip-x');
    click(x!);
    expect(handle.current?.getMarkdown()).toBe(DOC.replace('tags: [a, b]', 'tags: [b]'));
  });

  it('adds a list item through the chip input', () => {
    const { host, handle } = mount(DOC);
    const input = host.querySelector<HTMLInputElement>('.cm-atomic-fm-chip-input');
    act(() => {
      input!.value = 'c';
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: false }));
    });
    expect(handle.current?.getMarkdown()).toBe(DOC.replace('tags: [a, b]', 'tags: [a, b, c]'));
  });

  it('empty frontmatter still gets a widget with just the add button', () => {
    const { host } = mount('---\n---\n\nBody.\n');
    expect(host.querySelector('.cm-atomic-fm')).not.toBeNull();
    expect(host.querySelectorAll('.cm-atomic-fm-row').length).toBe(0);
    expect(host.querySelector('.cm-atomic-fm-add')).not.toBeNull();
  });

  it('falls back to styled raw text for YAML it cannot represent', () => {
    const nested = '---\nparent:\n  child: 1\n---\n\nBody.\n';
    const { host, handle } = mount(nested);
    expect(host.querySelector('.cm-atomic-fm')).toBeNull();
    expect(host.querySelectorAll('.cm-line.cm-atomic-frontmatter').length).toBe(4);
    expect(handle.current?.getMarkdown()).toBe(nested);
  });

  it('falls back to raw text for unclosed frontmatter', () => {
    const { host } = mount('---\ntitle: typing');
    expect(host.querySelector('.cm-atomic-fm')).toBeNull();
    expect(host.querySelectorAll('.cm-line.cm-atomic-frontmatter').length).toBe(2);
  });

  it('toggles to raw source and back', () => {
    const { host } = mount(DOC);
    click(host.querySelector('.cm-atomic-fm-src')!);
    expect(host.querySelector('.cm-atomic-fm')).toBeNull();
    expect(host.querySelectorAll('.cm-line.cm-atomic-frontmatter').length).toBe(5);
    const pill = host.querySelector('.cm-atomic-fm-pill');
    expect(pill).not.toBeNull();
    click(pill!);
    expect(host.querySelector('.cm-atomic-fm')).not.toBeNull();
  });

  it('widget picks up raw-mode text edits when toggled back', () => {
    const { host } = mount(DOC);
    click(host.querySelector('.cm-atomic-fm-src')!);
    const view = EditorView.findFromDOM(host as HTMLElement);
    const closeFence = DOC.indexOf('\n---\n') + 1;
    act(() => {
      // Insert a property line just before the closing fence.
      view!.dispatch({ changes: { from: closeFence, insert: 'owner: ramos\n' } });
    });
    click(host.querySelector('.cm-atomic-fm-pill')!);
    const rows = host.querySelectorAll('.cm-atomic-fm-row');
    expect(rows.length).toBe(4);
    expect(rows[3].querySelector('.cm-atomic-fm-key')?.textContent).toBe('owner');
  });
});
