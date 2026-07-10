import { useEffect, useMemo, useState } from 'react';
import { AtomicDiffEditor, wikiLinks } from '@atomic-editor/editor';
import { ATOMIC_CODE_LANGUAGES } from '@atomic-editor/editor/code-languages';

type ThemeMode = 'dark' | 'light';

const ORIGINAL_MARKDOWN = `# Shipping a calmer review flow

The Changes tab is useful, but it pulls reviewers away from the document they are trying to understand.

## What changes in this spike

The review stays beside the ideas it discusses. Small edits read inline, deleted words remain visible, and long stable sections fold away.

- [ ] Validate keyboard navigation
- [x] Preserve the exact Markdown source
- [ ] Exercise the large-document path

> Review should feel like reading with context, not reconciling two unrelated panes.

## Compatibility notes

The existing editor already has rich decorations for headings, links, images, tasks, and tables. A changed atomic block must expose its source instead of hiding the diff behind a widget.

| Surface | Review behavior |
| --- | --- |
| Prose | Inline emphasis |
| Changed table | Rendered widget |
| Wiki links | Resolved labels |

The stable metadata table below should remain rendered because it does not intersect a change.

| Owner | Stage |
| --- | --- |
| Editor team | Spike |

Related: [[editor-roadmap|Editor roadmap]] and [[review-principles|Review principles]].

## Performance guardrail

The editor should preserve enough surrounding lines to orient the reviewer.

Context line 01 — stable material stays available when a reviewer asks for it.
Context line 02 — stable material stays available when a reviewer asks for it.
Context line 03 — stable material stays available when a reviewer asks for it.
Context line 04 — stable material stays available when a reviewer asks for it.
Context line 05 — stable material stays available when a reviewer asks for it.
Context line 06 — stable material stays available when a reviewer asks for it.
Context line 07 — stable material stays available when a reviewer asks for it.
Context line 08 — stable material stays available when a reviewer asks for it.
Context line 09 — stable material stays available when a reviewer asks for it.
Context line 10 — stable material stays available when a reviewer asks for it.
Context line 11 — stable material stays available when a reviewer asks for it.
Context line 12 — stable material stays available when a reviewer asks for it.
Context line 13 — stable material stays available when a reviewer asks for it.
Context line 14 — stable material stays available when a reviewer asks for it.

\`\`\`ts
const collapseAfter = 4;
renderDiff({ collapseAfter, inline: false });
\`\`\`

The result should be frozen, legible, and faithful.`;

const MODIFIED_MARKDOWN = `# Shipping an inline review flow

The Changes tab is useful, but it pulls reviewers away from the document they are already trying to understand.

## What this spike proves

The review stays inside the document it discusses. Small edits read inline, deleted words remain visible where they were, and long stable sections fold away without losing orientation.

- [x] Validate keyboard navigation
- [x] Preserve the exact Markdown source
- [x] Exercise the large-document path

> Review should feel like reading with context, not reconciling two unrelated panes.

The frozen surface rejects document transactions at the editor boundary, including changes dispatched by consumer extensions.

## Compatibility notes

The existing editor already has rich decorations for headings, links, images, tasks, and tables. A changed atomic block exposes its source so the diff can never disappear behind a widget.

| Surface | Review behavior |
| --- | --- |
| Prose | Inline emphasis |
| Changed table | Source with diff marks |
| Wiki links | Rich when stable, source when changed |

The stable metadata table below should remain rendered because it does not intersect a change.

| Owner | Stage |
| --- | --- |
| Editor team | Spike |

Related: [[editor-roadmap|Editor plan]] and [[review-principles|Review principles]].

## Performance guardrail

The editor should preserve enough surrounding lines to orient the reviewer.

Context line 01 — stable material stays available when a reviewer asks for it.
Context line 02 — stable material stays available when a reviewer asks for it.
Context line 03 — stable material stays available when a reviewer asks for it.
Context line 04 — stable material stays available when a reviewer asks for it.
Context line 05 — stable material stays available when a reviewer asks for it.
Context line 06 — stable material stays available when a reviewer asks for it.
Context line 07 — stable material stays available when a reviewer asks for it.
Context line 08 — stable material stays available when a reviewer asks for it.
Context line 09 — stable material stays available when a reviewer asks for it.
Context line 10 — stable material stays available when a reviewer asks for it.
Context line 11 — stable material stays available when a reviewer asks for it.
Context line 12 — stable material stays available when a reviewer asks for it.
Context line 13 — stable material stays available when a reviewer asks for it.
Context line 14 — stable material stays available when a reviewer asks for it.

\`\`\`ts
const contextLines = 3;
renderDiff({ contextLines, inline: true });
\`\`\`

The result is frozen, legible, and byte-faithful.`;

/** Focused browser harness for the frozen inline-diff spike. */
export function DiffDemo() {
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [expanded, setExpanded] = useState(false);
  const extensions = useMemo(() => [wikiLinks()], []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="demo-root diff-demo-root" data-theme={theme}>
      <header className="demo-chrome diff-demo-chrome">
        <div className="demo-topbar diff-demo-topbar">
          <div className="diff-demo-heading">
            <a className="demo-title diff-demo-title" href="/" aria-label="Back to Atomic Editor demo">
              <span className="demo-mark-strong">Atomic</span>
              <span className="demo-mark-soft">Editor</span>
            </a>
            <span className="diff-demo-divider" aria-hidden="true" />
            <div>
              <p className="diff-demo-kicker">Engine spike</p>
              <h1>Inline document changes</h1>
            </div>
          </div>

          <div className="demo-topbar-actions">
            <span className="diff-demo-frozen-badge">
              <LockIcon />
              Frozen review
            </span>
            <button
              type="button"
              className={`demo-btn${expanded ? ' active' : ''}`}
              aria-pressed={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'Collapse context' : 'Expand context'}
            </button>
            <button
              type="button"
              className="demo-icon-btn"
              onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </div>
        <p className="diff-demo-description">
          The newer revision remains the document. Insertions, deletions, and stable rich Markdown
          share one reading surface; changed atomic blocks reveal source so no evidence is hidden.
        </p>
      </header>

      <main className="demo-canvas diff-demo-canvas">
        <div className="demo-editor-pane diff-demo-editor-pane">
          <AtomicDiffEditor
            originalMarkdown={ORIGINAL_MARKDOWN}
            modifiedMarkdown={MODIFIED_MARKDOWN}
            documentId={`inline-diff-spike-${expanded ? 'expanded' : 'collapsed'}`}
            collapseUnchanged={expanded ? false : { margin: 3, minSize: 7 }}
            codeLanguages={ATOMIC_CODE_LANGUAGES}
            extensions={extensions}
          />
        </div>
      </main>
    </div>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
