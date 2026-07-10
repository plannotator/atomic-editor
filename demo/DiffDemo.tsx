import { useEffect, useState } from 'react';
import { AtomicDiffEditor } from '@atomic-editor/editor';

type ThemeMode = 'dark' | 'light';

const ORIGINAL_MARKDOWN = `---
title: A guided tour of inline changes
status: walkthrough
tags: [editor, review]
---

# A guided tour of inline changes

Each numbered example demonstrates one diff behavior. Start with example 1, then use Next change in the toolbar to step through the guide.

## 1. Addition only

The next sentence exists only in the newer revision, so it appears as one green added line.

The sentences after it are unchanged context.
They remain neutral so the addition is easy to identify.

## 2. Deletion only

The next sentence exists only in the older revision, so it remains visible in red with a strike-through.

This sentence was removed after review.

The sentences after it are unchanged context.
They make clear where the deletion used to sit.

## 3. Replacement

When words change on one line, the old words are red and struck through while the new words are green.

Decision: Keep the separate Changes pane.

The rest of this example is unchanged.
Replacement emphasis stays local to the edited words.

## 4. One-character replacement

Only the final letter changes here: the old A stays red and struck through while the new B is green.

Review pass: A

The rest of the line is unchanged.
This is the smallest replacement in the tour.

## 5. Changed atomic block

This table changes, so it intentionally reveals Markdown source instead of hiding evidence inside a rendered widget.

| Surface | Stage |
| --- | --- |
| Inline diff | Exploring |

The table below is unchanged, so it remains rendered as a useful control.

| Owner | Stage |
| --- | --- |
| Editor team | Spike |

Changed and unchanged atomic blocks therefore remain distinguishable.
No document text is rewritten to produce either presentation.

## 6. Full document context

Review mode: Collapse long unchanged regions.

The early-release editor keeps every unchanged line visible. Nothing is hidden by a context heuristic.

Stable context line 01 — unchanged material remains available.
Stable context line 02 — unchanged material remains available.
Stable context line 03 — unchanged material remains available.
Stable context line 04 — unchanged material remains available.
Stable context line 05 — unchanged material remains available.
Stable context line 06 — unchanged material remains available.
Stable context line 07 — unchanged material remains available.
Stable context line 08 — unchanged material remains available.
Stable context line 09 — unchanged material remains available.
Stable context line 10 — unchanged material remains available.
Stable context line 11 — unchanged material remains available.
Stable context line 12 — unchanged material remains available.
Stable context line 13 — unchanged material remains available.
Stable context line 14 — unchanged material remains available.
Stable context line 15 — unchanged material remains available.
Stable context line 16 — unchanged material remains available.`;

const MODIFIED_MARKDOWN = `---
title: A guided tour of inline changes
status: walkthrough
tags: [editor, review]
---

# A guided tour of inline changes

Each numbered example demonstrates one diff behavior. Start with example 1, then use Next change in the toolbar to step through the guide.

## 1. Addition only

The next sentence exists only in the newer revision, so it appears as one green added line.

A newly added sentence appears only in the current version.

The sentences after it are unchanged context.
They remain neutral so the addition is easy to identify.

## 2. Deletion only

The next sentence exists only in the older revision, so it remains visible in red with a strike-through.

The sentences after it are unchanged context.
They make clear where the deletion used to sit.

## 3. Replacement

When words change on one line, the old words are red and struck through while the new words are green.

Decision: Review changes inside the document.

The rest of this example is unchanged.
Replacement emphasis stays local to the edited words.

## 4. One-character replacement

Only the final letter changes here: the old A stays red and struck through while the new B is green.

Review pass: B

The rest of the line is unchanged.
This is the smallest replacement in the tour.

## 5. Changed atomic block

This table changes, so it intentionally reveals Markdown source instead of hiding evidence inside a rendered widget.

| Surface | Stage |
| --- | --- |
| Inline diff | Viable |

The table below is unchanged, so it remains rendered as a useful control.

| Owner | Stage |
| --- | --- |
| Editor team | Spike |

Changed and unchanged atomic blocks therefore remain distinguishable.
No document text is rewritten to produce either presentation.

## 6. Full document context

Review mode: Show the complete document.

The early-release editor keeps every unchanged line visible. Nothing is hidden by a context heuristic.

Stable context line 01 — unchanged material remains available.
Stable context line 02 — unchanged material remains available.
Stable context line 03 — unchanged material remains available.
Stable context line 04 — unchanged material remains available.
Stable context line 05 — unchanged material remains available.
Stable context line 06 — unchanged material remains available.
Stable context line 07 — unchanged material remains available.
Stable context line 08 — unchanged material remains available.
Stable context line 09 — unchanged material remains available.
Stable context line 10 — unchanged material remains available.
Stable context line 11 — unchanged material remains available.
Stable context line 12 — unchanged material remains available.
Stable context line 13 — unchanged material remains available.
Stable context line 14 — unchanged material remains available.
Stable context line 15 — unchanged material remains available.
Stable context line 16 — unchanged material remains available.`;

/** Focused browser harness for the frozen inline-diff spike. */
export function DiffDemo() {
  const [theme, setTheme] = useState<ThemeMode>('dark');

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
              className="demo-icon-btn"
              onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </div>
        <p className="diff-demo-description">
          Six isolated examples explain one behavior at a time. Start at example 1 or use Next to
          step through additions, removals, replacements, atomic blocks, and full-document context.
        </p>
        <div className="diff-demo-key" aria-label="How to read the diff">
          <span className="diff-demo-key-label">Reading key</span>
          <span className="diff-demo-key-item">
            <span className="diff-demo-key-swatch added" aria-hidden="true" />
            <span><strong>Green</strong> is added</span>
          </span>
          <span className="diff-demo-key-item">
            <span className="diff-demo-key-swatch removed" aria-hidden="true" />
            <span><strong>Red + strike</strong> is removed</span>
          </span>
          <span className="diff-demo-key-item">
            <span className="diff-demo-key-swatch unchanged" aria-hidden="true" />
            <span><strong>Neutral</strong> is unchanged</span>
          </span>
          <span className="diff-demo-key-hint">Red and green together mean replacement.</span>
        </div>
      </header>

      <main className="demo-canvas diff-demo-canvas">
        <div className="demo-editor-pane diff-demo-editor-pane">
          <AtomicDiffEditor
            originalMarkdown={ORIGINAL_MARKDOWN}
            modifiedMarkdown={MODIFIED_MARKDOWN}
            documentId="inline-diff-spike-full-context"
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
