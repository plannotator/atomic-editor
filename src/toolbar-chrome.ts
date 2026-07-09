import { EditorView } from '@codemirror/view';
import { type InlineFormat } from './formatting-commands';

// Shared chrome for the two floating formatting bars: the main selection
// toolbar (`selection-toolbar.ts`) and the in-cell bar
// (`cell-formatting.ts`). Both bars render identical buttons, icons, and
// styling; the ONLY thing that differs is click behaviour and how each
// syncs its active state. Owning the button DOM, the icon assets, and the
// base theme here means the two bars can never visually drift — and it
// dissolves the old circular import (cell-formatting used to reach back
// into selection-toolbar for the shared assets, which in turn imported
// cell-formatting). Both now depend only on this leaf module.

// Accessible names, mirrored into both `aria-label` and `title` so the
// button is announced by screen readers and shows a native tooltip.
export const BUTTON_LABELS: Record<InlineFormat, string> = {
  bold: 'Bold',
  italic: 'Italic',
  strikethrough: 'Strikethrough',
  code: 'Inline code',
  link: 'Link',
};

// Hand-authored 16x16 glyphs, tuned to sit next to Linear's floating bar:
// a uniform 1.5px stroke across every icon (the bold `B` was 1.7 and read
// heavier than its neighbours — normalized here), `currentColor` so the
// button's `color` (idle / hover / active) drives the icon with no
// per-icon override, and `aria-hidden` to keep the decorative SVG out of
// the accessibility tree (the button's `aria-label` is the accessible
// name).
export const BUTTON_ICONS: Record<InlineFormat, string> = {
  bold:
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M5 3v10h4.2a2.6 2.6 0 0 0 0-5.2H5m0 0h3.4a2.4 2.4 0 0 0 0-4.8H5z"/></svg>',
  italic:
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M10 3H6.5M9.5 13H6M9.5 3l-3 10"/></svg>',
  strikethrough:
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M11 4.5A3 2.2 0 0 0 8 3H7a2 2 0 0 0-.6 3.9M5 11a3 2.2 0 0 0 3 1.5h1a2 2 0 0 0 .6-3.9M3 8h10"/></svg>',
  code:
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 5 2 8l4 3M10 5l4 3-4 3"/></svg>',
  link:
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7 9a3 3 0 0 0 4.2 0l1.6-1.6a3 3 0 0 0-4.2-4.2L7.5 4M9 7a3 3 0 0 0-4.2 0L3.2 8.6a3 3 0 0 0 4.2 4.2L8.5 12"/></svg>',
};

// The text-style group — everything that is NOT the link. The separator
// lives at the boundary between this group and the link button, so we key
// the boundary off `link` and use this set only to confirm a text-style
// button actually preceded it.
const TEXT_STYLE_FORMATS: readonly InlineFormat[] = ['bold', 'italic', 'strikethrough', 'code'];

export interface ToolbarButtonEntry<F extends InlineFormat> {
  format: F;
  button: HTMLButtonElement;
}

/**
 * Populate `container` with one button per format (icons, aria, and the
 * pointerdown `preventDefault` that keeps the editor's selection alive),
 * plus the group separator, and return the button entries so the caller
 * can sync active/disabled state itself.
 *
 * This owns everything the two bars MUST share — button construction,
 * classes, icons, aria, the separator — and nothing they legitimately
 * differ on: `onSelect` carries each caller's own toggle path (a CM
 * command for the main bar, a cell-raw rewrite for the in-cell bar), and
 * active-state syncing stays with the caller because each reads a
 * different source of truth (the lezer tree vs. the cell's raw string).
 *
 * The separator is a 1px divider between the text-style group (bold,
 * italic, strikethrough, code) and the link button. It renders only when
 * BOTH groups are present, exactly once, immediately before the first
 * link button — so a config that interleaves the groups still gets a
 * single separator at the first link (a deliberate simplification; config
 * order is otherwise preserved). The in-cell bar carries only text styles
 * (no link), so it never gets a separator.
 */
export function buildToolbarButtons<F extends InlineFormat>(
  container: HTMLElement,
  formats: readonly F[],
  onSelect: (format: F) => void,
): ToolbarButtonEntry<F>[] {
  const entries: ToolbarButtonEntry<F>[] = [];
  let sawTextStyle = false;
  let separatorPlaced = false;

  for (const format of formats) {
    if (format === 'link' && sawTextStyle && !separatorPlaced) {
      const separator = document.createElement('div');
      separator.className = 'cm-atomic-selection-toolbar-separator';
      separator.setAttribute('aria-hidden', 'true');
      container.appendChild(separator);
      separatorPlaced = true;
    }
    if (TEXT_STYLE_FORMATS.includes(format)) sawTextStyle = true;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-atomic-selection-toolbar-button';
    button.setAttribute('aria-label', BUTTON_LABELS[format]);
    button.title = BUTTON_LABELS[format];
    button.innerHTML = BUTTON_ICONS[format];

    // `preventDefault` on pointerdown keeps the editor's selection and
    // focus intact — without it, pressing the button would move focus to
    // the button, collapse the selection, and the toggle would have
    // nothing to act on. True for both bars (CM selection / cell DOM
    // selection alike).
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', () => onSelect(format));

    container.appendChild(button);
    entries.push({ format, button });
  }

  return entries;
}

// Shared base theme — the full visual chrome for BOTH bars. It carries
// only DARK fallbacks; consumers restyle through the `--atomic-editor-*`
// CSS variables below (there are deliberately no `[data-theme]` rules
// here — the light-mode remap lives in the consuming markdown-editor
// theme). The container rules sit on `.cm-tooltip.cm-atomic-selection-
// toolbar` (specificity 0,2,0), which beats atomic-theme's generic
// `.cm-tooltip` (0,1,0), so the toolbar's own background/border/radius win.
//
// Public token contract consumed here (exact spellings; each is used at
// its site with the dark fallback shown):
//   --atomic-editor-menu-bg            surface background       (#1e1e21)
//   --atomic-editor-menu-border        hairline border + separator
//                                      (rgba(255,255,255,0.09))
//   --atomic-editor-menu-shadow        elevation shadow
//     (0 9px 32px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.28))
//   --atomic-editor-menu-radius        container corner radius  (10px)
//   --atomic-editor-menu-item-hover-bg button hover fill        (rgba(255,255,255,0.07))
//   --atomic-editor-menu-fg            button icon (hover)      (#e2e3e5)
//   --atomic-editor-menu-fg-muted      button icon (idle)       (#96969d)
// The active-format tint introduces NO new token — it consumes the
// existing `--atomic-editor-accent-soft`, falling back to a `color-mix`
// wash derived from `--atomic-editor-accent`, so it tracks whatever
// accent the host sets without a bespoke variable.
export const toolbarChromeTheme = EditorView.baseTheme({
  '.cm-tooltip.cm-atomic-selection-toolbar': {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    padding: '3px 4px',
    backgroundColor: 'var(--atomic-editor-menu-bg, #1e1e21)',
    border: '1px solid var(--atomic-editor-menu-border, rgba(255, 255, 255, 0.09))',
    borderRadius: 'var(--atomic-editor-menu-radius, 10px)',
    boxShadow:
      'var(--atomic-editor-menu-shadow, 0 9px 32px rgba(0, 0, 0, 0.35), 0 2px 8px rgba(0, 0, 0, 0.28))',
  },
  '.cm-atomic-selection-toolbar-button': {
    width: '28px',
    height: '28px',
    padding: '0',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    color: 'var(--atomic-editor-menu-fg-muted, #96969d)',
  },
  // `:not(:disabled)` so a disabled button (e.g. link on a multi-line
  // selection) shows no hover affordance.
  '.cm-atomic-selection-toolbar-button:hover:not(:disabled)': {
    backgroundColor: 'var(--atomic-editor-menu-item-hover-bg, rgba(255, 255, 255, 0.07))',
    color: 'var(--atomic-editor-menu-fg, #e2e3e5)',
  },
  '.cm-atomic-selection-toolbar-button:disabled': {
    opacity: '0.4',
    cursor: 'default',
  },
  // Active format uses the violet accent family: bright accent for the
  // icon, the existing `--atomic-editor-accent-soft` token for the wash
  // behind it (no new token invented). When the host doesn't define
  // accent-soft, the fallback derives an 18% wash from the accent itself
  // via `color-mix`, so the tint still follows the host's accent.
  '.cm-atomic-selection-toolbar-button.cm-atomic-selection-toolbar-active': {
    color: 'var(--atomic-editor-accent-bright, #a78bfa)',
    backgroundColor:
      'var(--atomic-editor-accent-soft, color-mix(in srgb, var(--atomic-editor-accent, #7c3aed) 18%, transparent))',
  },
  // Group divider between the text-style buttons and the link button.
  '.cm-atomic-selection-toolbar-separator': {
    width: '1px',
    height: '16px',
    margin: '0 2px',
    backgroundColor: 'var(--atomic-editor-menu-border, rgba(255, 255, 255, 0.09))',
  },
});
