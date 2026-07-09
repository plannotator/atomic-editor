import { describe, expect, it, afterEach } from 'vitest';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState, type EditorStateConfig, type Extension } from '@codemirror/state';
import { EditorView, runScopeHandlers, showTooltip, type Tooltip } from '@codemirror/view';
import {
  editorTooltipSpace,
  selectionToolbar,
  type SelectionToolbarConfig,
} from '../selection-toolbar';

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) {
    const parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  }
});

// A live view with the markdown language (so `inlineFormattingAllowed`
// can inspect the real syntax tree) plus the toolbar under test.
function makeView(
  doc: string,
  selection?: EditorStateConfig['selection'],
  config: SelectionToolbarConfig = {},
  extra: Extension = [],
): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection,
      extensions: [markdown({ base: markdownLanguage }), selectionToolbar(config), extra],
    }),
  });
  views.push(view);
  return view;
}

// The only showTooltip provider in these views is the toolbar, so the
// facet has a single (possibly null) entry.
function currentTooltip(view: EditorView): Tooltip | null {
  return view.state.facet(showTooltip).find((value) => value != null) ?? null;
}

// happy-dom exposes PointerEvent, but fall back to MouseEvent (with the
// pointerdown type) in case a runtime lacks the constructor.
function pointerDownEvent(): Event {
  try {
    return new PointerEvent('pointerdown', { bubbles: true, button: 0 });
  } catch {
    return new MouseEvent('pointerdown', { bubbles: true, button: 0 });
  }
}

// A bubbling pointerup, dispatched on a nested node so it traverses the
// full capture→target→bubble path (needed to exercise the capture-phase
// release listener against a subtree that stops the bubble trip).
function pointerUpEvent(): Event {
  try {
    return new PointerEvent('pointerup', { bubbles: true });
  } catch {
    return new MouseEvent('pointerup', { bubbles: true });
  }
}

describe('selectionToolbar', () => {
  it('shows a tooltip anchored to a non-empty single-line selection', () => {
    const view = makeView('hello world', EditorSelection.single(0, 5));
    const tooltip = currentTooltip(view);
    expect(tooltip).not.toBeNull();
    expect(tooltip?.pos).toBe(0);
    expect(tooltip?.end).toBe(5);
    expect(tooltip?.above).toBe(true);
  });

  it('shows nothing for an empty selection', () => {
    const view = makeView('hello world', EditorSelection.single(3));
    expect(currentTooltip(view)).toBeNull();
  });

  it('shows a tooltip for a selection spanning a line break', () => {
    // Multi-line selections now format per line, so the bar appears.
    const view = makeView('line one\nline two', EditorSelection.single(0, 12));
    expect(currentTooltip(view)).not.toBeNull();
  });

  it('shows nothing for a multi-line selection entirely inside a fence', () => {
    const doc = '```\naaa\nbbb\n```';
    const from = doc.indexOf('aaa');
    const to = doc.indexOf('bbb') + 3;
    const view = makeView(doc, EditorSelection.single(from, to));
    expect(currentTooltip(view)).toBeNull();
  });

  it('shows nothing inside a fenced code block', () => {
    const doc = '```\ncode here\n```';
    const from = doc.indexOf('code');
    const view = makeView(doc, EditorSelection.single(from, from + 4));
    expect(currentTooltip(view)).toBeNull();
  });

  it('shows nothing when there are multiple selection ranges', () => {
    const view = makeView(
      'alpha beta gamma',
      EditorSelection.create([EditorSelection.range(0, 5), EditorSelection.range(6, 10)]),
      {},
      EditorState.allowMultipleSelections.of(true),
    );
    expect(currentTooltip(view)).toBeNull();
  });

  it('suppresses the tooltip while the pointer is dragging and restores it on release', () => {
    const view = makeView('hello world', EditorSelection.single(0, 5));
    expect(currentTooltip(view)).not.toBeNull();

    view.contentDOM.dispatchEvent(pointerDownEvent());
    expect(currentTooltip(view)).toBeNull();

    window.dispatchEvent(new Event('pointerup'));
    expect(currentTooltip(view)).not.toBeNull();
  });

  it('restores the tooltip on release even when a widget stops the release from bubbling to window', () => {
    // Regression: the described bug. A block widget (a table cell, or the
    // fork's frontmatter editing island) renders inside the content and
    // legitimately stops its own pointer events from escaping. When the
    // user releases a drag that crosses such a widget OVER that widget,
    // the pointerup never bubbles to `window`. Suppression is a global
    // latch cleared only by a release event, so a bubble-phase window
    // listener would strand it — the bar would never come back and the
    // user sees "no bubble menu". Capture phase (window→target) delivers
    // the release before any descendant can stop it.
    const view = makeView('hello world', EditorSelection.single(0, 5));
    expect(currentTooltip(view)).not.toBeNull();

    // Drag begins: suppression latches on, tooltip hidden.
    view.contentDOM.dispatchEvent(pointerDownEvent());
    expect(currentTooltip(view)).toBeNull();

    // An editing-island widget: a subtree whose root swallows pointerup so
    // it cannot bubble up to `window`.
    const island = document.createElement('div');
    const inner = document.createElement('div');
    island.appendChild(inner);
    document.body.appendChild(island);
    island.addEventListener('pointerup', (event) => event.stopPropagation());

    // Release over the island's inner node. A bubble-phase listener would
    // miss this (the island blocks the trip to window); the capture-phase
    // listener still fires and clears the latch.
    inner.dispatchEvent(pointerUpEvent());
    expect(currentTooltip(view)).not.toBeNull();

    island.remove();
  });

  it('suppresses the tooltip during IME composition and restores it after', () => {
    const view = makeView('hello world', EditorSelection.single(0, 5));
    expect(currentTooltip(view)).not.toBeNull();

    view.contentDOM.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    expect(currentTooltip(view)).toBeNull();

    view.contentDOM.dispatchEvent(new Event('compositionend', { bubbles: true }));
    expect(currentTooltip(view)).not.toBeNull();
  });

  it('renders one button per configured format, in order, with accessible labels', () => {
    const view = makeView('hello world', EditorSelection.single(0, 5));
    const tooltip = currentTooltip(view);
    const dom = tooltip!.create(view).dom;
    const labels = Array.from(dom.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Bold', 'Italic', 'Strikethrough', 'Inline code', 'Link']);
    for (const button of dom.querySelectorAll('button')) {
      expect(button.getAttribute('type')).toBe('button');
    }
  });

  it('renders exactly the configured subset of buttons', () => {
    const view = makeView('hello world', EditorSelection.single(0, 5), { buttons: ['bold', 'link'] });
    const dom = currentTooltip(view)!.create(view).dom;
    const labels = Array.from(dom.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Bold', 'Link']);
  });

  it('renders exactly one separator, between the code and link buttons, by default', () => {
    const view = makeView('hello world', EditorSelection.single(0, 5));
    const dom = currentTooltip(view)!.create(view).dom;
    const separators = dom.querySelectorAll('.cm-atomic-selection-toolbar-separator');
    expect(separators).toHaveLength(1);
    // The divider sits at the text-style → link boundary: code before it,
    // link after it.
    const separator = separators[0];
    expect(separator.getAttribute('aria-hidden')).toBe('true');
    expect(separator.previousElementSibling?.getAttribute('aria-label')).toBe('Inline code');
    expect(separator.nextElementSibling?.getAttribute('aria-label')).toBe('Link');
  });

  it('renders no separator when the config has no link button', () => {
    const view = makeView('hello world', EditorSelection.single(0, 5), {
      buttons: ['bold', 'italic'],
    });
    const dom = currentTooltip(view)!.create(view).dom;
    expect(dom.querySelectorAll('.cm-atomic-selection-toolbar-separator')).toHaveLength(0);
  });

  it('renders no separator when the config has no text-style button', () => {
    const view = makeView('hello world', EditorSelection.single(0, 5), { buttons: ['link'] });
    const dom = currentTooltip(view)!.create(view).dom;
    expect(dom.querySelectorAll('.cm-atomic-selection-toolbar-separator')).toHaveLength(0);
  });

  it('marks the active format on the matching button', () => {
    const doc = '**bold** text';
    const view = makeView(doc, EditorSelection.single(2, 6));
    const dom = currentTooltip(view)!.create(view).dom;
    const boldButton = dom.querySelector('button[aria-label="Bold"]');
    expect(boldButton?.classList.contains('cm-atomic-selection-toolbar-active')).toBe(true);
    const italicButton = dom.querySelector('button[aria-label="Italic"]');
    expect(italicButton?.classList.contains('cm-atomic-selection-toolbar-active')).toBe(false);
  });

  it('disables the link button for a multi-line selection but not a single-line one', () => {
    const multi = makeView('line one\nline two', EditorSelection.single(0, 12));
    const multiDom = currentTooltip(multi)!.create(multi).dom;
    const multiLink = multiDom.querySelector<HTMLButtonElement>('button[aria-label="Link"]');
    expect(multiLink?.disabled).toBe(true);

    const single = makeView('hello world', EditorSelection.single(0, 5));
    const singleDom = currentTooltip(single)!.create(single).dom;
    const singleLink = singleDom.querySelector<HTMLButtonElement>('button[aria-label="Link"]');
    expect(singleLink?.disabled).toBe(false);
  });

  it('marks bold active when every line of a multi-line selection is bold', () => {
    const doc = '**one**\n**two**';
    const view = makeView(doc, EditorSelection.single(0, doc.length));
    const dom = currentTooltip(view)!.create(view).dom;
    const boldButton = dom.querySelector('button[aria-label="Bold"]');
    expect(boldButton?.classList.contains('cm-atomic-selection-toolbar-active')).toBe(true);
  });

  it('leaves the document byte-identical when untouched', () => {
    const original = '# Title\n\nSome **bold** and _italic_ prose.\n';
    const view = makeView(original, EditorSelection.single(9, 13));
    expect(view.state.doc.toString()).toBe(original);
  });

  it('binds Mod-b to the bold toggle via the bundled keymap', () => {
    const view = makeView('hello world', EditorSelection.single(0, 5));
    // `Mod` resolves to Cmd on mac and Ctrl elsewhere; try each single
    // modifier so the test is agnostic to the runtime's platform.
    const handled =
      runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }), 'editor') ||
      runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'b', metaKey: true }), 'editor');
    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe('**hello** world');
  });
});

describe('editorTooltipSpace', () => {
  it('returns the editor rect when it sits fully inside the window', () => {
    const editor = { top: 43, left: 10, right: 900, bottom: 700 };
    expect(editorTooltipSpace(editor, 1280, 800)).toEqual(editor);
  });

  it('clamps an editor rect that pokes past the window edges', () => {
    // Editor scrolled partially off the top-left, wider/taller than the
    // window: every edge clamps to the viewport.
    const editor = { top: -120, left: -30, right: 1400, bottom: 950 };
    expect(editorTooltipSpace(editor, 1280, 800)).toEqual({
      top: 0,
      left: 0,
      right: 1280,
      bottom: 800,
    });
  });
});
