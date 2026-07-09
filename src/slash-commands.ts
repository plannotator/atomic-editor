import { autocompletion, pickedCompletion, snippet, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

/**
 * One entry in the slash-command menu. The menu is pure UI until the
 * user picks an entry: selecting one replaces the typed `/query` text
 * with the item's snippet (or its custom `apply` handler), which is the
 * only document mutation the extension ever makes (and it is
 * user-triggered, so it honors the "never change text the user didn't
 * type" rule).
 *
 * An item must provide `snippet` or `apply` (`apply` wins when both are
 * present); items with neither are dropped from the options.
 */
export interface SlashCommandItem {
  /** Menu label; the text the user types after `/` is fuzzy-matched against it. */
  label: string;
  /** Short hint rendered after the label (the defaults show the markdown syntax). */
  detail?: string;
  /**
   * Snippet template inserted in place of the typed `/query` text, using
   * @codemirror/autocomplete snippet syntax: `${}` is an empty tab stop,
   * `${name}` a tab stop pre-filled with placeholder text. Templates
   * without fields insert plainly with the cursor at the end.
   */
  snippet?: string;
  /**
   * Custom insertion handler, wins over `snippet`. Unlike CM's own
   * `Completion.apply` range, `from`..`to` covers the whole typed
   * `/query` INCLUDING the trigger slash; the handler must dispatch its
   * own transaction (and should annotate it with `pickedCompletion`).
   */
  apply?: (view: EditorView, completion: Completion, from: number, to: number) => void;
  /** Ranking boost (-99..99). Defaults carry descending boosts so they keep menu order; unboosted custom items sort after them, alphabetically. */
  boost?: number;
  /**
   * Inline SVG markup rendered as a leading 16×16 icon in the menu row
   * (injected via innerHTML — the string is trusted exactly like the
   * consumer's own code). Use `currentColor` strokes/fills so the icon
   * follows the menu's muted foreground. Items without one get the
   * package's default glyph, so the icon gutter stays aligned.
   */
  icon?: string;
}

/**
 * Options for {@link slashCommands} / {@link slashCommandSource}. Leave
 * empty for the twelve built-in block insertions, append your own with
 * `items`, or swap the whole set with `replaceDefaults`.
 */
export interface SlashCommandsConfig {
  /** Extra commands appended after the defaults (or the full set with `replaceDefaults`). */
  items?: SlashCommandItem[];
  /** When true, `items` fully replaces the default command set. */
  replaceDefaults?: boolean;
}

// Node names that mean "the caret is inside code" — a literal `/` there
// is code, not a command trigger. Walked up the syntax tree from the
// match position so a `/` nested anywhere inside a fence, inline span,
// or raw HTML block never opens the menu.
const CODE_NODE_NAMES = new Set([
  'FencedCode',
  'CodeBlock',
  'CodeText',
  'InlineCode',
  'HTMLBlock',
  'CommentBlock',
]);

// The bytes the Table command inserts: a 2×2 table with a header row,
// the delimiter, one empty body row, and a trailing newline so the
// caret has a blank line to fall to.
const TABLE_INSERT = '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n';

/**
 * Table insertion handler. The old snippet had tab-stop fields inside
 * the pipe syntax, but the WYSIWYG table widget (a block
 * `Decoration.replace` that renders unconditionally) covers the block
 * the instant it parses, trapping the active snippet field invisibly
 * beneath it. So instead of a snippet we drop plain table bytes and
 * hand focus off to the widget's first header cell.
 */
function insertTable(
  view: EditorView,
  completion: Completion,
  from: number,
  to: number,
): void {
  view.dispatch({
    changes: { from, to, insert: TABLE_INSERT },
    // The selection is the fallback — the blank line after the table —
    // used verbatim when the tables() extension isn't composed in or the
    // widget lookup below fails.
    selection: { anchor: from + TABLE_INSERT.length },
    scrollIntoView: true,
    annotations: pickedCompletion.of(completion),
  });

  // Best-effort focus handoff to the widget's first header cell,
  // mirroring `appendRow` in table-widget.ts. This is a deliberate soft
  // contract with table-widget's DOM class names — no import, no hard
  // dependency: when tables() is absent the whole step no-ops and the
  // fallback caret stands. Double-rAF because the first rAF only
  // guarantees CM6 has processed the dispatch; the second ensures the
  // widget DOM has painted so focus commands don't get lost.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const tables = view.dom.querySelectorAll<HTMLElement>('.cm-atomic-table');
      for (const el of tables) {
        let pos: number;
        try {
          pos = view.posAtDOM(el);
        } catch {
          // posAtDOM can throw on detached/transitional DOM nodes —
          // skip and keep looking.
          continue;
        }
        if (pos !== from) continue;
        const source = el.querySelector<HTMLElement>(
          'thead th .cm-atomic-table-cell-source',
        );
        if (!source) return;
        source.focus();
        // Select the whole 'Column 1' placeholder so typing immediately
        // replaces it.
        const range = document.createRange();
        range.selectNodeContents(source);
        const sel = window.getSelection();
        if (!sel) return;
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
    });
  });
}

// Wraps inner markup in the shared 16×16 root so every default glyph
// carries identical stroke defaults: 1.5 stroke-width, round caps/joins,
// and `currentColor` so the icon follows the menu's muted foreground.
// Artwork stays roughly within a 2..14 box for consistent optical
// margins; solid shapes (list bullets, the image lens) opt into
// fill="currentColor" stroke="none" where a filled dot reads better.
const svg = (inner: string): string =>
  `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

// Heading glyphs share one H letterform (two verticals + a crossbar in
// the left ~60%) and differ only by a stroke-drawn subscript digit at
// bottom-right — no <text>, so rendering never depends on a font. The
// three digits sit in the same x 10.5..13, y 9.4..14 box for a
// consistent look: 1 is a diagonal lead-in into a vertical stem, 2 is a
// top arc into a diagonal-to-horizontal foot, 3 is two stacked arcs.
const H_LETTER = 'M2.5 3.5V11.5M8 3.5V11.5M2.5 7.5H8';
const HEADING_1_ICON = svg(`<path d="${H_LETTER}"/><path d="M10.6 10.4 12 9.4V14"/>`);
const HEADING_2_ICON = svg(`<path d="${H_LETTER}"/><path d="M10.5 10.1A1.35 1.35 0 1 1 12.9 11L10.5 14H13.1"/>`);
const HEADING_3_ICON = svg(`<path d="${H_LETTER}"/><path d="M10.5 9.7A1.3 1.3 0 1 1 11.9 11.5A1.35 1.35 0 1 1 10.5 13.6"/>`);

// Three body lines (x 6.5→13.5) on the right; the left column carries
// the list marker. Bulleted uses solid dots; numbered uses stroke-drawn
// "1"-like ordinal marks (a short vertical stem with a serif base tick),
// again deliberately NOT <text>.
const LIST_LINES = 'M6.5 4H13.5M6.5 8H13.5M6.5 12H13.5';
const BULLETED_LIST_ICON = svg(
  `<path d="${LIST_LINES}"/><circle cx="3" cy="4" r="1.1" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="3" cy="12" r="1.1" fill="currentColor" stroke="none"/>`,
);
const NUMBERED_LIST_ICON = svg(
  `<path d="${LIST_LINES}"/><path d="M3 2.6V5.4M2.2 5.4H3.8M3 6.6V9.4M2.2 9.4H3.8M3 10.6V13.4M2.2 13.4H3.8"/>`,
);

const TASK_LIST_ICON = svg(
  '<rect x="2" y="2" width="8" height="8" rx="2"/><path d="M4.2 6 5.6 7.4 8 4.6"/><path d="M11.5 6H14M2.5 12.5H10"/>',
);
const QUOTE_ICON = svg('<path d="M3.25 3V13M6.5 6H13M6.5 10H13"/>');
const CODE_BLOCK_ICON = svg('<path d="M6 4 2.5 8 6 12"/><path d="M10 4 13.5 8 10 12"/>');
// Full-height vertical rule + a header rule, so the frame reads as a
// grid rather than a plain card at 16px.
const TABLE_ICON = svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 7H14M8 3V13"/>');
// The rule plus two dimmed text-block lines above/below it, so the glyph
// reads as a separator between passages, not a bare line.
const DIVIDER_ICON = svg('<path d="M2 8H14"/><path d="M4 4H12M4 12H12" opacity="0.5"/>');
// Two interlocking diagonal capsules around a short center bar — the
// classic chain-link glyph (Lucide's `link`, scaled to the 16 box).
const LINK_ICON = svg(
  '<path d="M6.67 8.67A3.33 3.33 0 0 0 11.7 9.03L13.7 7.03A3.33 3.33 0 0 0 9 2.32L7.85 3.46"/><path d="M9.33 7.33A3.33 3.33 0 0 0 4.3 6.97L2.3 8.97A3.33 3.33 0 0 0 7 13.68L8.15 12.54"/>',
);
// A framed lens + horizon: the small filled circle is the "sun", the
// polyline a mountain ridge, both kept inside the rounded frame.
const IMAGE_ICON = svg(
  '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.75" cy="6.5" r="1.15" fill="currentColor" stroke="none"/><path d="M2.5 11.5 6.5 8 9 10 11.5 8 13.5 9.5"/>',
);

// Fallback for custom items without their own `icon`: a plus in a
// rounded square, reading as "insert". Keeps the icon gutter aligned so
// custom rows line up with the defaults.
const DEFAULT_ICON = svg('<rect x="2.5" y="2.5" width="11" height="11" rx="3"/><path d="M8 5V11M5 8H11"/>');

/**
 * The twelve built-in block insertions, in menu order. Boosts descend
 * from 12 so an empty query renders them exactly in this sequence;
 * custom items (which default to no boost) sort after them.
 */
export const defaultSlashCommands: readonly SlashCommandItem[] = [
  { label: 'Heading 1', detail: '#', snippet: '# ', boost: 12, icon: HEADING_1_ICON },
  { label: 'Heading 2', detail: '##', snippet: '## ', boost: 11, icon: HEADING_2_ICON },
  { label: 'Heading 3', detail: '###', snippet: '### ', boost: 10, icon: HEADING_3_ICON },
  { label: 'Bulleted list', detail: '-', snippet: '- ', boost: 9, icon: BULLETED_LIST_ICON },
  { label: 'Numbered list', detail: '1.', snippet: '1. ', boost: 8, icon: NUMBERED_LIST_ICON },
  { label: 'Task list', detail: '- [ ]', snippet: '- [ ] ', boost: 7, icon: TASK_LIST_ICON },
  { label: 'Quote', detail: '>', snippet: '> ', boost: 6, icon: QUOTE_ICON },
  // Two anonymous tab stops: the parser treats each `${}` as an
  // independent field, so Tab moves from fence language to body.
  { label: 'Code block', detail: '```', snippet: '```${}\n${}\n```', boost: 5, icon: CODE_BLOCK_ICON },
  { label: 'Table', detail: '2×2', apply: insertTable, boost: 4, icon: TABLE_ICON },
  { label: 'Divider', detail: '---', snippet: '---', boost: 3, icon: DIVIDER_ICON },
  { label: 'Link', detail: '[]()', snippet: '[${text}](${url})', boost: 2, icon: LINK_ICON },
  { label: 'Image', detail: '![]()', snippet: '![${alt}](${url})', boost: 1, icon: IMAGE_ICON },
];

// Carries the row's icon markup on the completion object, mirroring the
// `suggestion` property wiki-links pins to its own completions. The
// `addToOptions` render fn reads it back off the completion to draw the
// leading glyph — no map lookup, no per-keystroke work.
interface SlashCommandCompletion extends Completion {
  slashCommandIcon: string;
}

/**
 * Builds the completion source that powers the slash menu. Registered
 * through language data (see {@link slashCommands}) so it composes with
 * other completion sources rather than replacing them.
 *
 * Note: with no typed `/` this returns null, so explicit activation
 * (Ctrl-Space on an empty line) does nothing — the menu is reachable
 * only by typing the trigger, which is intentional.
 */
export function slashCommandSource(config: SlashCommandsConfig = {}): CompletionSource {
  const items = config.replaceDefaults
    ? (config.items ?? [])
    : [...defaultSlashCommands, ...(config.items ?? [])];

  // Build the options — and each item's applier — once, not per
  // keystroke. `apply` extends the replaced range one char left (`from -
  // 1`) to swallow the trigger `/`, which the returned result's `from`
  // deliberately leaves out of the fuzzy-match range (see below). Items
  // with neither `apply` nor `snippet` are dropped (defensive).
  const options: Completion[] = items.flatMap((item) => {
    if (item.apply) {
      const customApply = item.apply;
      return [
        {
          label: item.label,
          detail: item.detail,
          boost: item.boost,
          slashCommandIcon: item.icon ?? DEFAULT_ICON,
          apply: (view: EditorView, completion: Completion, from: number, to: number) =>
            customApply(view, completion, from - 1, to),
        } satisfies SlashCommandCompletion,
      ];
    }
    if (item.snippet == null) return [];
    const applySnippet = snippet(item.snippet);
    return [
      {
        label: item.label,
        detail: item.detail,
        boost: item.boost,
        slashCommandIcon: item.icon ?? DEFAULT_ICON,
        apply: (view: EditorView, completion: Completion, from: number, to: number) =>
          applySnippet(view, completion, from - 1, to),
      } satisfies SlashCommandCompletion,
    ];
  });

  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\/[\w-]*$/);
    if (!match) return null;

    // Block-insert semantics: only trigger when the `/` opens a line
    // (everything before it on the line is whitespace). This keeps
    // literal slashes in prose, list items, quotes, and URLs quiet.
    const line = context.state.doc.lineAt(match.from);
    if (!/^\s*$/.test(line.text.slice(0, match.from - line.from))) return null;

    // Never trigger inside code: a `/` in a fence, inline span, or raw
    // HTML is content, not a command.
    let node = syntaxTree(context.state).resolveInner(match.from, 1);
    while (true) {
      if (CODE_NODE_NAMES.has(node.name)) return null;
      const parent = node.parent;
      if (!parent) break;
      node = parent;
    }

    // `from` is placed AFTER the slash so CM6 fuzzy-matches only the
    // query text against labels (a leading `/` would never match a
    // label like "Heading 1"). Each option's `apply` compensates by
    // extending the replaced range back over the `/` (`from - 1`).
    return { from: match.from + 1, options, validFor: /^[\w-]*$/ };
  };
}

/**
 * The slash-command extension. Compose it into the editor alongside any
 * other completion-based feature; opt-in and additive.
 *
 * Returns three parts: the autocomplete engine, the completion source
 * (registered via language data so sources compose), and a tooltip
 * theme.
 */
export function slashCommands(config: SlashCommandsConfig = {}): Extension {
  // Build the source once, not per language-data lookup.
  const source = slashCommandSource(config);
  return [
    // Only `activateOnTyping`, `icons`, and `addToOptions` are passed on
    // purpose. Other config fields (notably `override`) have no combiner
    // in the autocomplete config facet, so a second extension passing
    // them (wiki-links used to) throws 'Config merge conflict'.
    // `activateOnTyping: true` is equal-valued, `icons: false` has a
    // combiner, and `addToOptions` merges by array concat, so all three
    // merge safely across the slashCommands() and wikiLinks() instances.
    autocompletion({
      activateOnTyping: true,
      icons: false,
      addToOptions: [
        {
          // Sit where CM's own type icons would (position 20), so our
          // glyph occupies the same leading gutter.
          position: 20,
          render: (completion: Completion): HTMLElement | null => {
            const icon = (completion as Partial<SlashCommandCompletion>).slashCommandIcon;
            // CRITICAL: addToOptions is shared across every autocompletion()
            // instance via the concat combiner, so this render fn also runs
            // for wiki-link (and code-language) completions. Those have no
            // slashCommandIcon — returning null gives their rows NO icon
            // gutter at all, keeping each menu internally consistent (a
            // wiki-link menu stays icon-free rather than showing a lone
            // default glyph per row).
            if (icon == null) return null;
            const span = document.createElement('span');
            span.className = 'cm-atomic-slash-icon';
            span.setAttribute('aria-hidden', 'true');
            span.innerHTML = icon;
            return span;
          },
        },
      ],
    }),
    // Register through language data rather than `override` so this
    // source composes with every other completion source instead of
    // suppressing them.
    EditorState.languageData.of(() => [{ autocomplete: source }]),
    slashCommandTooltipTheme,
  ];
}

// Styles the shared autocomplete tooltip to Linear-quality chrome. This
// intentionally targets any autocomplete tooltip in the editor
// (wiki-link suggestions included), so every menu looks identical.
//
// Seven menu tokens drive the look — declared here as inline
// `var(--name, <dark fallback>)` per package convention, with the dark
// fallbacks baked in so the editor is correct with no theme at all:
//   --atomic-editor-menu-bg             surface fill
//   --atomic-editor-menu-border         hairline border
//   --atomic-editor-menu-shadow         elevation (two stacked shadows)
//   --atomic-editor-menu-radius         outer corner radius
//   --atomic-editor-menu-item-hover-bg  hover / selected pill fill
//   --atomic-editor-menu-fg             row foreground
//   --atomic-editor-menu-fg-muted       detail / icon foreground
// The light remap for all seven ships in the consumer theme (pn-main),
// not in this package.
const slashCommandTooltipTheme: Extension = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--atomic-editor-menu-bg, #1e1e21)',
    border: '1px solid var(--atomic-editor-menu-border, rgba(255, 255, 255, 0.09))',
    borderRadius: 'var(--atomic-editor-menu-radius, 10px)',
    boxShadow: 'var(--atomic-editor-menu-shadow, 0 9px 32px rgba(0, 0, 0, 0.35), 0 2px 8px rgba(0, 0, 0, 0.28))',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--atomic-editor-font, system-ui, -apple-system, BlinkMacSystemFont, sans-serif)',
    fontSize: '0.8125rem',
    // This 4px inner padding is the single biggest elegance cue: it insets
    // every row so the rounded hover/selected pill floats inside the menu
    // and never touches its edge.
    padding: '4px',
    // The base autocomplete theme caps the list at 10em (~6 rows). Rows
    // are 34px, so the 12 defaults are 408px + 8px of top/bottom padding
    // ≈ 416px. 34em at the list's 13px em is 442px — headroom of under
    // one row, so the defaults never scroll but longer custom sets do.
    // EditorView.theme rules take precedence over base themes, so this
    // override sticks.
    maxHeight: '34em',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    height: '34px',
    padding: '0 10px',
    borderRadius: '6px',
    color: 'var(--atomic-editor-menu-fg, #e2e3e5)',
    whiteSpace: 'nowrap',
  },
  // Hover and keyboard selection share one treatment: the pill carries the
  // state and the label never inverts color (Linear never inverts).
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected], .cm-tooltip.cm-tooltip-autocomplete > ul > li:hover': {
    backgroundColor: 'var(--atomic-editor-menu-item-hover-bg, rgba(255, 255, 255, 0.07))',
    color: 'var(--atomic-editor-menu-fg, #e2e3e5)',
  },
  '.cm-completionLabel': {
    fontWeight: '500',
  },
  '.cm-completionDetail': {
    // Right-aligned hint column — our markdown-syntax equivalent of
    // Linear's keyboard-shortcut column.
    marginLeft: 'auto',
    color: 'var(--atomic-editor-menu-fg-muted, #96969d)',
    fontStyle: 'normal',
    fontSize: '0.75rem',
  },
  '.cm-completionMatchedText': {
    textDecoration: 'none',
    // The editor's existing violet — no new accent color is introduced.
    color: 'var(--atomic-editor-accent-bright, #a78bfa)',
  },
  '.cm-atomic-slash-icon': {
    width: '16px',
    height: '16px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--atomic-editor-menu-fg-muted, #96969d)',
  },
  '.cm-atomic-slash-icon svg': {
    display: 'block',
    width: '16px',
    height: '16px',
  },
});
