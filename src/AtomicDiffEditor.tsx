import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from 'react';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { type LanguageDescription } from '@codemirror/language';
import {
  getChunks,
  unifiedMergeView,
  type Chunk,
  type DiffConfig,
} from '@codemirror/merge';
import {
  EditorState,
  type Extension,
  type Text,
  type Transaction,
} from '@codemirror/state';
import {
  EditorView,
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
const DEFAULT_DIFF_CONFIG: DiffConfig = {
  scanLimit: 500_000,
  timeout: 1_000,
};

type DiffOverviewMarkerKind = 'addition' | 'deletion' | 'replacement';

interface DiffOverviewMarker {
  readonly index: number;
  readonly kind: DiffOverviewMarkerKind;
  readonly position: number;
  readonly size: number;
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
  /** Whether to show the clickable change overview rail. Defaults to true. */
  readonly showOverview?: boolean;
  /** Whether to show the change gutter. Defaults to true. */
  readonly gutter?: boolean;
  /** Whether small edits render deletions inline. Defaults to true. */
  readonly allowInlineDiffs?: boolean;
  /** Whether changed spans receive character/word emphasis. Defaults to true. */
  readonly highlightChanges?: boolean;
  /** Whether deleted fragments receive Markdown syntax highlighting. Defaults to true. */
  readonly syntaxHighlightDeletions?: boolean;
  /**
   * Diff-algorithm safeguards for large or highly divergent documents.
   * Captured by the mounted comparison. Pass a stable object; change
   * `documentId` to deliberately rebuild when only this value changes.
   */
  readonly diffConfig?: DiffConfig;
  /**
   * Grammars to use in fenced code blocks. Captured by the mounted comparison;
   * pass a stable array and change `documentId` to deliberately rebuild when
   * only this value changes.
   */
  readonly codeLanguages?: readonly LanguageDescription[];
  /**
   * Consumer extensions appended after the built-ins. This is the same seam
   * used by wiki links and other domain decorations. Captured by the mounted
   * comparison; pass a stable array and feed changing data through extension
   * callbacks that close over live state. Change `documentId` to deliberately
   * rebuild when only this array changes.
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
  showOverview = true,
  gutter = true,
  allowInlineDiffs = true,
  highlightChanges = true,
  syntaxHighlightDeletions = true,
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
  const [overviewMarkers, setOverviewMarkers] = useState<readonly DiffOverviewMarker[]>([]);

  useEffect(() => {
    onLinkClickRef.current = onLinkClick;
  }, [onLinkClick]);

  useEffect(() => {
    const root = editorRootRef.current;
    if (!root) return;

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
    const chunks = getChunks(view.state)?.chunks ?? [];
    setChangeCount(chunks.length);
    setOverviewMarkers(createOverviewMarkers(chunks, view.state.doc));
    activeChangeRef.current = null;
    setActiveChange(null);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Caller-provided extensions, language descriptions, and diffConfig are
    // captured at mount time, just like AtomicCodeMirrorEditor. Primitive UI
    // policy remains reactive below so a host setting cannot leave the React
    // chrome disagreeing with CodeMirror's internal configuration.
    // Either revision changing always remounts because a version-reader may
    // compare multiple revisions of the same documentId in one session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allowInlineDiffs,
    ariaLabel,
    documentId,
    gutter,
    highlightChanges,
    modifiedMarkdown,
    originalMarkdown,
    syntaxHighlightDeletions,
  ]);

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
      <div className="cm-atomic-diff-surface">
        <div ref={editorRootRef} className="cm-atomic-diff-editor-host" />
        {showOverview && overviewMarkers.length > 0 && (
          <DiffOverview
            markers={overviewMarkers}
            activeChange={activeChange}
            viewRef={viewRef}
            activeChangeRef={activeChangeRef}
          />
        )}
      </div>
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
  return navigateChangeAtIndex(view, nextIndex, activeChangeRef);
}

function navigateChangeAtIndex(
  view: EditorView | null,
  index: number,
  activeChangeRef: MutableRefObject<number | null>,
): boolean {
  if (!view) return false;
  const chunk = getChunks(view.state)?.chunks[index];
  if (!chunk) return false;

  activeChangeRef.current = index;
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

function createOverviewMarkers(
  chunks: readonly Chunk[],
  document: Text,
): readonly DiffOverviewMarker[] {
  const lineCount = Math.max(document.lines, 1);
  const lastLineIndex = Math.max(lineCount - 1, 1);

  return chunks.map((chunk, index) => {
    const startPosition = Math.min(chunk.fromB, document.length);
    const endPosition = Math.min(chunk.endB, document.length);
    const startLineIndex = document.lineAt(startPosition).number - 1;
    const endLineIndex = document.lineAt(endPosition).number - 1;
    const changedLineCount = Math.max(endLineIndex - startLineIndex + 1, 1);

    return {
      index,
      kind: getOverviewMarkerKind(chunk),
      position: clampOverviewPosition(startLineIndex / lastLineIndex),
      size: Math.min(Math.max((changedLineCount / lineCount) * 100, 0.45), 100),
    };
  });
}

function getOverviewMarkerKind(chunk: Chunk): DiffOverviewMarkerKind {
  if (chunk.fromA === chunk.toA) return 'addition';
  if (chunk.fromB === chunk.toB) return 'deletion';
  return 'replacement';
}

function clampOverviewPosition(position: number): number {
  return Math.min(Math.max(position * 100, 0.6), 99.4);
}

interface DiffOverviewProps {
  readonly markers: readonly DiffOverviewMarker[];
  readonly activeChange: number | null;
  readonly viewRef: MutableRefObject<EditorView | null>;
  readonly activeChangeRef: MutableRefObject<number | null>;
}

function DiffOverview({
  markers,
  activeChange,
  viewRef,
  activeChangeRef,
}: DiffOverviewProps) {
  const changeCount = markers.length;

  const navigateFromPointer = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0) {
      navigateChange(viewRef.current, 'next', activeChangeRef);
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.height <= 0) return;
    const pointerPosition = ((event.clientY - bounds.top) / bounds.height) * 100;
    const nearestMarker = markers.reduce((nearest, marker) => (
      Math.abs(marker.position - pointerPosition) < Math.abs(nearest.position - pointerPosition)
        ? marker
        : nearest
    ));
    navigateChangeAtIndex(viewRef.current, nearestMarker.index, activeChangeRef);
  };

  const navigateFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const direction = getOverviewKeyboardDirection(event.key);
    if (direction) {
      event.preventDefault();
      navigateChange(viewRef.current, direction, activeChangeRef);
      return;
    }
    if (event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : changeCount - 1;
    navigateChangeAtIndex(viewRef.current, index, activeChangeRef);
  };

  return (
    <button
      type="button"
      className="cm-atomic-diff-overview"
      aria-label={`Diff overview: ${formatChangeCount(changeCount)}. Press Enter for next change; arrow keys navigate.`}
      title="Diff overview"
      onClick={navigateFromPointer}
      onKeyDown={navigateFromKeyboard}
    >
      <span className="cm-atomic-diff-overview-track" aria-hidden="true">
        {markers.map((marker) => (
          <span
            key={marker.index}
            className={`cm-atomic-diff-overview-marker ${marker.kind}${activeChange === marker.index ? ' active' : ''}`}
            style={{ top: `${marker.position}%`, height: `${marker.size}%` }}
          />
        ))}
      </span>
    </button>
  );
}

function getOverviewKeyboardDirection(key: string): 'next' | 'previous' | null {
  if (key === 'ArrowDown' || key === 'ArrowRight') return 'next';
  if (key === 'ArrowUp' || key === 'ArrowLeft') return 'previous';
  return null;
}
