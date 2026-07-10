import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ViewPlugin } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AtomicDiffEditor,
  type AtomicDiffEditorHandle,
  type AtomicDiffEditorProps,
} from '../AtomicDiffEditor';
import { wikiLinks } from '../wiki-links';

interface MountedDiff {
  readonly handleRef: { current: AtomicDiffEditorHandle | null };
  readonly host: HTMLElement;
  readonly root: Root;
}

const mounts: MountedDiff[] = [];

function mountDiff(props: AtomicDiffEditorProps): MountedDiff {
  const host = document.createElement('div');
  host.style.width = '800px';
  host.style.height = '600px';
  document.body.appendChild(host);
  const root = createRoot(host);
  const handleRef = createRef<AtomicDiffEditorHandle | null>() as {
    current: AtomicDiffEditorHandle | null;
  };

  act(() => {
    root.render(<AtomicDiffEditor {...props} editorHandleRef={handleRef} />);
  });

  const mounted = { handleRef, host, root };
  mounts.push(mounted);
  return mounted;
}

function rerenderDiff(mounted: MountedDiff, props: AtomicDiffEditorProps): void {
  act(() => {
    mounted.root.render(
      <AtomicDiffEditor {...props} editorHandleRef={mounted.handleRef} />,
    );
  });
}

afterEach(() => {
  for (const mounted of mounts.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.host.remove();
  }
});

describe('AtomicDiffEditor', () => {
  it('returns both caller-owned revisions without normalizing bytes', () => {
    const original = '# Before\r\n\r\nExact bytes.\r\n';
    const modified = '# After\r\n\r\nExact bytes.  \r\n';
    const { handleRef } = mountDiff({
      originalMarkdown: original,
      modifiedMarkdown: modified,
    });

    expect(handleRef.current?.getOriginalMarkdown()).toBe(original);
    expect(handleRef.current?.getMarkdown()).toBe(modified);
  });

  it('renders newer text with inline insertion and deletion emphasis', () => {
    const { host, handleRef } = mountDiff({
      originalMarkdown: 'The quick brown fox.',
      modifiedMarkdown: 'The quick agile fox.',
    });

    expect(handleRef.current?.getChangeCount()).toBe(1);
    expect(host.querySelector('.cm-changedText')?.textContent).toContain('agile');
    expect(host.querySelector('.cm-deletedText')?.textContent).toContain('brown');
    expect(host.querySelector('.cm-deletedText')?.tagName).toBe('DEL');
  });

  it('keeps unchanged Markdown syntax rendered while exposing changed syntax', () => {
    const { host } = mountDiff({
      originalMarkdown: '# Earlier heading\n\n- [ ] Task',
      modifiedMarkdown: '# New heading\n\n- [x] Task',
    });

    const heading = host.querySelector<HTMLElement>('.cm-atomic-h1');
    expect(heading?.textContent?.trim().startsWith('#')).toBe(false);
    expect(host.querySelector('.cm-content')?.textContent).toContain('- [');
    const emphasizedText = Array.from(host.querySelectorAll('.cm-changedText'))
      .map((element) => element.textContent)
      .join('');
    expect(emphasizedText).toContain('x');
  });

  it('rejects document changes dispatched by a consumer extension', async () => {
    const modified = 'Immutable review text.\r\n';
    const hostileExtension = ViewPlugin.define((view) => {
      queueMicrotask(() => {
        view.dispatch({ changes: { from: 0, to: 0, insert: 'MUTATED ' } });
      });
      return {};
    });
    const { handleRef } = mountDiff({
      originalMarkdown: 'Earlier review text.\r\n',
      modifiedMarkdown: modified,
      extensions: [hostileExtension],
    });

    await act(async () => Promise.resolve());

    expect(handleRef.current?.getMarkdown()).toBe(modified);
    expect(handleRef.current?.getContentDOM()?.textContent).not.toContain('MUTATED');
  });

  it('keeps unchanged tables rendered and exposes changed tables as source', () => {
    const original = [
      '| Name | Status |',
      '| --- | --- |',
      '| Atlas | Stable |',
      '',
      '| Key | Value |',
      '| --- | --- |',
      '| Owner | Docs |',
    ].join('\n');
    const modified = original.replace('Stable', 'In review');
    const { host, handleRef } = mountDiff({
      originalMarkdown: original,
      modifiedMarkdown: modified,
    });

    const tables = host.querySelectorAll<HTMLElement>('.cm-atomic-table');
    expect(tables).toHaveLength(1);
    expect(tables[0]?.textContent).toContain('Owner');
    expect(tables[0]?.dataset.readonly).toBe('true');
    expect(tables[0]?.querySelector<HTMLElement>('.cm-atomic-table-cell-source')?.contentEditable).toBe('false');
    expect(host.querySelector('.cm-changedText')?.textContent).toContain('In review');
    expect(handleRef.current?.getMarkdown()).toContain('| Atlas | In review |');
  });

  it('keeps links in frozen table widgets navigable through the consumer seam', () => {
    const openedUrls: string[] = [];
    const original = [
      'Earlier introduction.',
      '',
      '| Resource |',
      '| --- |',
      '| [Docs](https://example.com/docs) |',
    ].join('\n');
    const { host } = mountDiff({
      originalMarkdown: original,
      modifiedMarkdown: original.replace('Earlier', 'Current'),
      onLinkClick: (url) => openedUrls.push(url),
    });

    act(() => {
      host.querySelector<HTMLElement>('.cm-atomic-link-icon')?.click();
    });

    expect(openedUrls).toEqual(['https://example.com/docs']);
  });

  it('keeps unchanged images rendered and exposes changed image source', () => {
    const original = [
      '![Old diagram](https://example.com/old.png)',
      '',
      '![Stable diagram](https://example.com/stable.png)',
    ].join('\n');
    const modified = original.replace('old.png', 'new.png');
    const { host, handleRef } = mountDiff({
      originalMarkdown: original,
      modifiedMarkdown: modified,
    });

    const renderedImages = host.querySelectorAll<HTMLElement>('.cm-atomic-image');
    expect(renderedImages).toHaveLength(1);
    expect(renderedImages[0]?.querySelector('img')?.alt).toBe('Stable diagram');
    expect(handleRef.current?.getMarkdown()).toContain('new.png');
    expect(host.querySelector('.cm-changedText')?.textContent).toContain('new');
  });

  it('keeps unchanged wiki links rendered and changed wiki links visible as source', () => {
    const original = 'Changed: [[atlas|Old title]] and unchanged: [[roadmap|Roadmap]]';
    const modified = original.replace('Old title', 'New title');
    const { host, handleRef } = mountDiff({
      originalMarkdown: original,
      modifiedMarkdown: modified,
      extensions: [wikiLinks()],
    });

    const renderedLinks = host.querySelectorAll<HTMLElement>('.cm-atomic-wiki-link');
    expect(renderedLinks).toHaveLength(1);
    expect(renderedLinks[0]?.textContent).toBe('Roadmap');
    expect(handleRef.current?.getMarkdown()).toContain('[[atlas|New title]]');
    expect(host.querySelector('.cm-content')?.textContent).toContain('[[atlas|OldNew title]]');
    expect(host.querySelector('.cm-changedText')?.textContent).toContain('New');
  });

  it('composes preferred resolved labels without rewriting frozen bytes', async () => {
    const modified = 'Current introduction.\n\nSee [[roadmap|Stored title]].';
    const { host, handleRef } = mountDiff({
      originalMarkdown: modified.replace('Current', 'Earlier'),
      modifiedMarkdown: modified,
      extensions: [
        wikiLinks({
          preferResolvedLabel: true,
          resolve: async (target) => ({ target, label: 'Current roadmap', status: 'resolved' }),
        }),
      ],
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.querySelector('.cm-atomic-wiki-link')?.textContent).toBe('Current roadmap');
    expect(handleRef.current?.getMarkdown()).toBe(modified);
  });

  it('keeps unchanged frontmatter rendered as a static properties widget', () => {
    const original = [
      '---',
      'title: Review plan',
      'tags: [editor, spike]',
      '---',
      '',
      'Earlier body.',
    ].join('\n');
    const { host } = mountDiff({
      originalMarkdown: original,
      modifiedMarkdown: original.replace('Earlier', 'Current'),
    });

    const properties = host.querySelector<HTMLElement>('.cm-atomic-fm');
    expect(properties?.textContent).toContain('Review plan');
    expect(properties?.textContent).toContain('editor');
    expect(properties?.querySelector('[contenteditable="true"]')).toBeNull();
    expect(properties?.querySelector('button')).toBeNull();
  });

  it('exposes changed frontmatter as source with inline evidence', () => {
    const original = [
      '---',
      'title: Review plan',
      'status: draft',
      '---',
      '',
      'Stable body.',
    ].join('\n');
    const modified = original.replace('draft', 'ready');
    const { host, handleRef } = mountDiff({
      originalMarkdown: original,
      modifiedMarkdown: modified,
    });

    expect(host.querySelector('.cm-atomic-fm')).toBeNull();
    expect(host.querySelector('.cm-content')?.textContent).toContain('status: draftready');
    expect(handleRef.current?.getMarkdown()).toBe(modified);
  });

  it('keeps the complete document visible without collapsed regions', () => {
    const originalLines = Array.from({ length: 32 }, (_, index) => `Line ${index + 1}`);
    const modifiedLines = [...originalLines];
    modifiedLines[15] = 'Line 16 changed';
    const { host, handleRef } = mountDiff({
      originalMarkdown: originalLines.join('\n'),
      modifiedMarkdown: modifiedLines.join('\n'),
    });

    expect(host.querySelector('.cm-collapsedLines')).toBeNull();
    expect(host.querySelector('.cm-content')?.textContent).toContain('Line 1');
    expect(host.querySelector('.cm-content')?.textContent).toContain('Line 32');
    expect(handleRef.current?.getMarkdown()).toBe(modifiedLines.join('\n'));
  });

  it('maps every change into a keyboard-traversable overview rail', () => {
    const originalLines = Array.from({ length: 40 }, (_, index) => `Stable line ${index + 1}`);
    const modifiedLines = [...originalLines];
    modifiedLines.splice(5, 0, 'Added line');
    modifiedLines.splice(modifiedLines.indexOf('Stable line 18'), 1);
    modifiedLines[modifiedLines.indexOf('Stable line 30')] = 'Changed line 30';

    const { host, handleRef } = mountDiff({
      originalMarkdown: originalLines.join('\n'),
      modifiedMarkdown: modifiedLines.join('\n'),
    });

    const overview = host.querySelector<HTMLButtonElement>('.cm-atomic-diff-overview');
    const markers = host.querySelectorAll('.cm-atomic-diff-overview-marker');
    expect(overview?.getAttribute('aria-label')).toContain('3 changes');
    expect(markers).toHaveLength(handleRef.current?.getChangeCount() ?? 0);
    expect(host.querySelector('.cm-atomic-diff-overview-marker.addition')).not.toBeNull();
    expect(host.querySelector('.cm-atomic-diff-overview-marker.deletion')).not.toBeNull();
    expect(host.querySelector('.cm-atomic-diff-overview-marker.replacement')).not.toBeNull();

    act(() => {
      overview?.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'ArrowDown',
      }));
    });

    expect(host.querySelector('.cm-atomic-diff-status')?.textContent).toContain('Change 1 of 3');
  });

  it('positions overview markers by document line rather than character offset', () => {
    const originalLines = [
      'x'.repeat(10_000),
      ...Array.from({ length: 9 }, (_, index) => `Line ${index + 2}`),
    ];
    const modifiedLines = [...originalLines];
    modifiedLines[5] = 'Line 6 changed';

    const { host } = mountDiff({
      originalMarkdown: originalLines.join('\n'),
      modifiedMarkdown: modifiedLines.join('\n'),
    });

    const marker = host.querySelector<HTMLElement>('.cm-atomic-diff-overview-marker');
    const top = Number.parseFloat(marker?.style.top ?? 'NaN');
    const height = Number.parseFloat(marker?.style.height ?? 'NaN');

    expect(top).toBeGreaterThan(50);
    expect(top).toBeLessThan(60);
    expect(height).toBe(10);
  });

  it('lets hosts hide the built-in overview rail', () => {
    const { host } = mountDiff({
      originalMarkdown: 'Before',
      modifiedMarkdown: 'After',
      showOverview: false,
    });

    expect(host.querySelector('.cm-atomic-diff-overview')).toBeNull();
  });

  it('reacts to primitive review-policy props without changing either revision', () => {
    const revisions = {
      originalMarkdown: 'Before review',
      modifiedMarkdown: 'After review',
    } as const;
    const mounted = mountDiff({
      ...revisions,
      ariaLabel: 'Initial comparison',
      gutter: true,
    });

    expect(mounted.host.querySelector('.cm-changeGutter')).not.toBeNull();
    expect(mounted.handleRef.current?.getContentDOM()?.closest('.cm-editor')?.getAttribute('aria-label'))
      .toBe('Initial comparison');

    rerenderDiff(mounted, {
      ...revisions,
      ariaLabel: 'Updated comparison',
      gutter: false,
    });

    expect(mounted.host.querySelector('.cm-changeGutter')).toBeNull();
    expect(mounted.handleRef.current?.getContentDOM()?.closest('.cm-editor')?.getAttribute('aria-label'))
      .toBe('Updated comparison');
    expect(mounted.handleRef.current?.getOriginalMarkdown()).toBe(revisions.originalMarkdown);
    expect(mounted.handleRef.current?.getMarkdown()).toBe(revisions.modifiedMarkdown);
  });

  it('navigates changed regions through the public handle', () => {
    const { host, handleRef } = mountDiff({
      originalMarkdown: 'Alpha\n\nBeta\n\nGamma',
      modifiedMarkdown: 'Alpha changed\n\nBeta\n\nGamma changed',
    });

    expect(handleRef.current?.getChangeCount()).toBe(2);
    act(() => {
      expect(handleRef.current?.goToNextChange()).toBe(true);
    });
    expect(host.querySelector('.cm-atomic-diff-status')?.textContent).toContain('Change 1 of 2');
    act(() => {
      expect(handleRef.current?.goToNextChange()).toBe(true);
    });
    expect(host.querySelector('.cm-atomic-diff-status')?.textContent).toContain('Change 2 of 2');
  });
});
