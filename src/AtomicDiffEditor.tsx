import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { type LanguageDescription } from '@codemirror/language';
import {
  getChunks,
  unifiedMergeView,
  type DiffConfig,
} from '@codemirror/merge';
import { EditorState, type Extension, type Transaction } from '@codemirror/state';
import {
  EditorView,
  ViewPlugin,
  highlightSpecialChars,
} from '@codemirror/view';

import { atomicEditorTheme, atomicMarkdownSyntax } from './atomic-theme';
import { atomicDiffView } from './diff-context';
import { frontmatterProperties } from './frontmatter-properties';
import { frontmatter } from './frontmatter';
import { imageBlocks } from './image-blocks';
import { inlinePreview } from './inline-preview';
import { tables } from './table-widget';

const EMPTY_CODE_LANGUAGES: readonly LanguageDescription[] = [];
const EMPTY_EXTENSIONS: readonly Extension[] = [];
const DEFAULT_COLLAPSE_UNCHANGED: AtomicDiffCollapseOptions = {
  margin: 3,
  minSize: 8,
};
const DEFAULT_DIFF_CONFIG: DiffConfig = {
  scanLimit: 500_000,
  timeout: 1_000,
};

/** Controls how much context remains around collapsed unchanged regions. */
export interface AtomicDiffCollapseOptions {
  /** Lines of context retained on each side of a change. Defaults to 3. */
  readonly margin?: number;
  /** Minimum unchanged line count eligible for collapse. Defaults to 8. */
  readonly minSize?: number;
}

/** Imperative navigation and inspection surface for a frozen diff editor. */
export interface AtomicDiffEditorHandle {
  /** Move the review cursor to the next changed region. */
  goToNextChange: () => boolean;
  /** Move the review cursor to the previous changed region. */
  goToPreviousChange: () => boolean;
  /** Return the exact newer text supplied by the caller. */
  getMarkdown: () => string;
  /** Return the exact older text supplied by the caller. */
  getOriginalMarkdown: () => string;
  /** Return the number of changed regions in the current comparison. */
  getChangeCount: () => number;
  /** Return CodeMirror's content element for host-level inspection. */
  getContentDOM: () => HTMLElement | null;
}

/** Configuration for the frozen, unified Markdown diff surface. */
export interface AtomicDiffEditorProps {
  /** The older document revision. */
  readonly originalMarkdown: string;
  /** The newer document revision rendered as the main document. */
  readonly modifiedMarkdown: string;
  /**
   * Optional comparison identity. Changing it forces a remount even when the
   * two document strings are unchanged. Either document changing also
   * remounts the view.
   */
  readonly documentId?: string;
  /** Accessible label for the review region. Defaults to "Document changes". */
  readonly ariaLabel?: string;
  /** Whether to show the built-in change count and navigation. Defaults to true. */
  readonly showToolbar?: boolean;
  /** Whether to show the change gutter. Defaults to true. */
  readonly gutter?: boolean;
  /** Whether small edits render deletions inline. Defaults to true. */
  readonly allowInlineDiffs?: boolean;
  /** Whether changed spans receive character/word emphasis. Defaults to true. */
  readonly highlightChanges?: boolean;
  /** Whether deleted fragments receive Markdown syntax highlighting. Defaults to true. */
  readonly syntaxHighlightDeletions?: boolean;
  /**
   * Collapse long unchanged regions by default. Pass false to keep the entire
   * document expanded, or provide context thresholds.
   */
  readonly collapseUnchanged?: false | AtomicDiffCollapseOptions;
  /** Diff-algorithm safeguards for large or highly divergent documents. */
  readonly diffConfig?: DiffConfig;
  /** Grammars to use in fenced code blocks. */
  readonly codeLanguages?: readonly LanguageDescription[];
  /**
   * Consumer extensions appended after the built-ins. This is the same seam
   * used by wiki links and other domain decorations.
   */
  readonly extensions?: readonly Extension[];
  /** Handles rendered links without enabling document edits. */
  readonly onLinkClick?: (url: string) => void;
  /** Receives the frozen view's imperative navigation surface. */
  readonly editorHandleRef?: MutableRefObject<AtomicDiffEditorHandle | null>;
}

/**
 * Render two Markdown revisions as a frozen unified diff. The newer text is
 * the main document; insertions stay in place and deletions are projected at
 * their original positions. Document-changing transactions are rejected at
 * both the state and view dispatch boundaries.
 */
export function AtomicDiffEditor({
  originalMarkdown,
  modifiedMarkdown,
  documentId,
  ariaLabel = 'Document changes',
  showToolbar = true,
  gutter = true,
  allowInlineDiffs = true,
  highlightChanges = true,
  syntaxHighlightDeletions = true,
  collapseUnchanged = DEFAULT_COLLAPSE_UNCHANGED,
  diffConfig = DEFAULT_DIFF_CONFIG,
  codeLanguages = EMPTY_CODE_LANGUAGES,
  extensions = EMPTY_EXTENSIONS,
  onLinkClick,
  editorHandleRef,
}: AtomicDiffEditorProps) {
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const activeChangeRef = useRef<number | null>(null);
  const onLinkClickRef = useRef(onLinkClick);
  const [changeCount, setChangeCount] = useState(0);
  const [activeChange, setActiveChange] = useState<number | null>(null);

  useEffect(() => {
    onLinkClickRef.current = onLinkClick;
  }, [onLinkClick]);

  useEffect(() => {
    const root = editorRootRef.current;
    if (!root) return;

    const collapseConfig = collapseUnchanged === false ? undefined : collapseUnchanged;
    const view = new EditorView({
      parent: root,
      dispatchTransactions: rejectDocumentChanges,
      state: EditorState.create({
        doc: modifiedMarkdown,
        extensions: [
          highlightSpecialChars(),
          EditorState.readOnly.of(true),
          EditorState.changeFilter.of(() => false),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          EditorView.editorAttributes.of({
            'aria-label': ariaLabel,
            'aria-readonly': 'true',
            role: 'document',
          }),
          markdown({
            base: markdownLanguage,
            codeLanguages: [...codeLanguages],
            extensions: [frontmatter],
          }),
          atomicMarkdownSyntax,
          atomicEditorTheme,
          unifiedMergeView({
            original: originalMarkdown,
            allowInlineDiffs,
            collapseUnchanged: collapseConfig,
            diffConfig,
            gutter,
            highlightChanges,
            mergeControls: false,
            syntaxHighlightDeletions,
          }),
          atomicDiffView,
          tables({
            onLinkClick: (url) => onLinkClickRef.current?.(url),
          }),
          frontmatterProperties(),
          imageBlocks(),
          inlinePreview({
            onLinkClick: (url) => onLinkClickRef.current?.(url),
          }),
          accessibleCollapsedRegions,
          EditorView.updateListener.of((update) => {
            if (!update.selectionSet) return;
            const nextActiveChange = findActiveChange(update.state);
            activeChangeRef.current = nextActiveChange;
            setActiveChange(nextActiveChange);
          }),
          ...extensions,
        ],
      }),
    });
    viewRef.current = view;
    setChangeCount(getChunks(view.state)?.chunks.length ?? 0);
    activeChangeRef.current = null;
    setActiveChange(null);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Extensions are captured at mount time, just like AtomicCodeMirrorEditor.
    // Either revision changing always remounts because a version-reader may
    // compare multiple revisions of the same documentId in one session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, modifiedMarkdown, originalMarkdown]);

  useEffect(() => {
    if (!editorHandleRef) return;
    editorHandleRef.current = {
      goToNextChange: () => navigateChange(viewRef.current, 'next', activeChangeRef),
      goToPreviousChange: () => navigateChange(viewRef.current, 'previous', activeChangeRef),
      getMarkdown: () => modifiedMarkdown,
      getOriginalMarkdown: () => originalMarkdown,
      getChangeCount: () => {
        const view = viewRef.current;
        return view ? getChunks(view.state)?.chunks.length ?? 0 : 0;
      },
      getContentDOM: () => viewRef.current?.contentDOM ?? null,
    };
    return () => {
      editorHandleRef.current = null;
    };
  }, [editorHandleRef, modifiedMarkdown, originalMarkdown]);

  const currentLabel = activeChange === null
    ? formatChangeCount(changeCount)
    : `Change ${activeChange + 1} of ${changeCount}`;

  return (
    <section
      className={`atomic-cm-editor atomic-cm-diff-editor${gutter ? ' atomic-cm-diff-gutter' : ''}`}
      aria-label={ariaLabel}
    >
      {showToolbar && (
        <div className="cm-atomic-diff-toolbar" role="toolbar" aria-label="Change navigation">
          <span className="cm-atomic-diff-status" aria-live="polite">
            <span className="cm-atomic-diff-status-dot" aria-hidden="true" />
            {currentLabel}
          </span>
          <div className="cm-atomic-diff-navigation">
            <button
              type="button"
              className="cm-atomic-diff-button"
              disabled={changeCount === 0}
              onClick={() => navigateChange(viewRef.current, 'previous', activeChangeRef)}
              aria-label="Previous change"
            >
              <DiffArrow direction="previous" />
              <span>Previous</span>
            </button>
            <button
              type="button"
              className="cm-atomic-diff-button"
              disabled={changeCount === 0}
              onClick={() => navigateChange(viewRef.current, 'next', activeChangeRef)}
              aria-label="Next change"
            >
              <span>Next</span>
              <DiffArrow direction="next" />
            </button>
          </div>
        </div>
      )}
      <div ref={editorRootRef} className="cm-atomic-diff-surface" />
    </section>
  );
}

function rejectDocumentChanges(
  transactions: readonly Transaction[],
  view: EditorView,
): void {
  if (transactions.some((transaction) => transaction.docChanged)) return;
  view.update(transactions);
}

function navigateChange(
  view: EditorView | null,
  direction: 'next' | 'previous',
  activeChangeRef: MutableRefObject<number | null>,
): boolean {
  if (!view) return false;
  const chunks = getChunks(view.state)?.chunks ?? [];
  if (chunks.length === 0) return false;

  const current = activeChangeRef.current;
  const nextIndex = current === null
    ? direction === 'next' ? 0 : chunks.length - 1
    : direction === 'next'
      ? (current + 1) % chunks.length
      : (current - 1 + chunks.length) % chunks.length;
  const chunk = chunks[nextIndex];
  if (!chunk) return false;

  activeChangeRef.current = nextIndex;
  view.dispatch({
    selection: { anchor: Math.min(chunk.fromB, view.state.doc.length) },
    effects: EditorView.scrollIntoView(chunk.fromB, { y: 'center' }),
  });
  return true;
}

function findActiveChange(state: EditorState): number | null {
  const result = getChunks(state);
  if (!result) return null;
  const cursor = state.selection.main.head;
  const index = result.chunks.findIndex((chunk) => (
    cursor >= chunk.fromB && cursor <= chunk.endB
  ));
  return index >= 0 ? index : null;
}

function formatChangeCount(count: number): string {
  return `${count} ${count === 1 ? 'change' : 'changes'}`;
}

function DiffArrow({ direction }: { readonly direction: 'next' | 'previous' }) {
  const points = direction === 'next' ? '9 5 16 12 9 19' : '15 5 8 12 15 19';
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

const accessibleCollapsedRegions = ViewPlugin.fromClass(
  class {
    private readonly observer: MutationObserver;

    constructor(view: EditorView) {
      this.observer = new MutationObserver(() => patchCollapsedRegions(view));
      this.observer.observe(view.dom, { childList: true, subtree: true });
      patchCollapsedRegions(view);
    }

    destroy(): void {
      this.observer.disconnect();
    }
  },
);

function patchCollapsedRegions(view: EditorView): void {
  for (const element of view.dom.querySelectorAll<HTMLElement>('.cm-collapsedLines')) {
    if (element.dataset.atomicAccessible === 'true') continue;
    element.dataset.atomicAccessible = 'true';
    element.role = 'button';
    element.tabIndex = 0;
    element.setAttribute('aria-label', `Expand ${element.textContent ?? 'unchanged lines'}`);
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      element.click();
    });
  }
}
