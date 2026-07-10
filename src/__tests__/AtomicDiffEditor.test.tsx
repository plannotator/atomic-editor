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
      collapseUnchanged: false,
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
      collapseUnchanged: false,
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
      collapseUnchanged: false,
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
      collapseUnchanged: false,
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
      collapseUnchanged: false,
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
      collapseUnchanged: false,
      extensions: [wikiLinks()],
    });

    const renderedLinks = host.querySelectorAll<HTMLElement>('.cm-atomic-wiki-link');
    expect(renderedLinks).toHaveLength(1);
    expect(renderedLinks[0]?.textContent).toBe('Roadmap');
    expect(handleRef.current?.getMarkdown()).toContain('[[atlas|New title]]');
    expect(host.querySelector('.cm-content')?.textContent).toContain('[[atlas|OldNew title]]');
    expect(host.querySelector('.cm-changedText')?.textContent).toContain('New');
  });

  it('makes unchanged-region collapse controls keyboard accessible', async () => {
    const originalLines = Array.from({ length: 32 }, (_, index) => `Line ${index + 1}`);
    const modifiedLines = [...originalLines];
    modifiedLines[15] = 'Line 16 changed';
    const { host, handleRef } = mountDiff({
      originalMarkdown: originalLines.join('\n'),
      modifiedMarkdown: modifiedLines.join('\n'),
      collapseUnchanged: { margin: 2, minSize: 6 },
    });

    await act(async () => Promise.resolve());

    const collapsed = host.querySelector<HTMLElement>('.cm-collapsedLines');
    expect(collapsed).not.toBeNull();
    expect(collapsed?.getAttribute('role')).toBe('button');
    expect(collapsed?.tabIndex).toBe(0);
    expect(collapsed?.getAttribute('aria-label')).toMatch(/^Expand \d+ unchanged lines$/);

    act(() => {
      collapsed?.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
      }));
    });

    expect(handleRef.current?.getMarkdown()).toBe(modifiedLines.join('\n'));
  });

  it('navigates changed regions through the public handle', () => {
    const { host, handleRef } = mountDiff({
      originalMarkdown: 'Alpha\n\nBeta\n\nGamma',
      modifiedMarkdown: 'Alpha changed\n\nBeta\n\nGamma changed',
      collapseUnchanged: false,
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
