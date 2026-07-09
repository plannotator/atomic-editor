import { autocompletion, snippet, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

/**
 * One entry in the slash-command menu. The menu is pure UI until the
 * user picks an entry: selecting one replaces the typed `/query` text
 * with the item's snippet, which is the only document mutation the
 * extension ever makes (and it is user-triggered, so it honors the
 * "never change text the user didn't type" rule).
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
  snippet: string;
  /** Ranking boost (-99..99). Defaults carry descending boosts so they keep menu order; unboosted custom items sort after them, alphabetically. */
  boost?: number;
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

/**
 * The twelve built-in block insertions, in menu order. Boosts descend
 * from 12 so an empty query renders them exactly in this sequence;
 * custom items (which default to no boost) sort after them.
 */
export const defaultSlashCommands: readonly SlashCommandItem[] = [
  { label: 'Heading 1', detail: '#', snippet: '# ', boost: 12 },
  { label: 'Heading 2', detail: '##', snippet: '## ', boost: 11 },
  { label: 'Heading 3', detail: '###', snippet: '### ', boost: 10 },
  { label: 'Bulleted list', detail: '-', snippet: '- ', boost: 9 },
  { label: 'Numbered list', detail: '1.', snippet: '1. ', boost: 8 },
  { label: 'Task list', detail: '- [ ]', snippet: '- [ ] ', boost: 7 },
  { label: 'Quote', detail: '>', snippet: '> ', boost: 6 },
  // Two anonymous tab stops: the parser treats each `${}` as an
  // independent field, so Tab moves from fence language to body.
  { label: 'Code block', detail: '```', snippet: '```${}\n${}\n```', boost: 5 },
  {
    label: 'Table',
    detail: '2×2',
    snippet: '| ${Column 1} | ${Column 2} |\n| --- | --- |\n| ${} | ${} |',
    boost: 4,
  },
  { label: 'Divider', detail: '---', snippet: '---', boost: 3 },
  { label: 'Link', detail: '[]()', snippet: '[${text}](${url})', boost: 2 },
  { label: 'Image', detail: '![]()', snippet: '![${alt}](${url})', boost: 1 },
];

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

  // Build the options — and each item's snippet applier — once, not per
  // keystroke. `apply` extends the replaced range one char left (`from -
  // 1`) to swallow the trigger `/`, which the returned result's `from`
  // deliberately leaves out of the fuzzy-match range (see below).
  const options: Completion[] = items.map((item) => {
    const applySnippet = snippet(item.snippet);
    return {
      label: item.label,
      detail: item.detail,
      boost: item.boost,
      apply: (view: EditorView, completion: Completion, from: number, to: number) =>
        applySnippet(view, completion, from - 1, to),
    };
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
    // Only `activateOnTyping` and `icons` are passed on purpose. Other
    // config fields (notably `override`) have no combiner in the
    // autocomplete config facet, so a second extension passing them
    // (wiki-links used to) throws 'Config merge conflict'.
    // `activateOnTyping: true` is equal-valued and `icons: false` has a
    // combiner, so both merge safely across extensions.
    autocompletion({ activateOnTyping: true, icons: false }),
    // Register through language data rather than `override` so this
    // source composes with every other completion source instead of
    // suppressing them.
    EditorState.languageData.of(() => [{ autocomplete: source }]),
    slashCommandTooltipTheme,
  ];
}

// Styles the shared autocomplete tooltip to match the editor chrome.
// This intentionally targets any autocomplete tooltip in the editor
// (wiki-link suggestions included), so the two menus look identical.
// Only `var(--atomic-editor-*, <dark fallback>)` tokens are used; each
// appears in the `[data-theme="light"] .atomic-cm-editor` block in
// src/styles/inline-preview.css, so light mode works by remapping.
const slashCommandTooltipTheme: Extension = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--atomic-editor-bg-surface, #2d2d2d)',
    border: '1px solid var(--atomic-editor-border, #3d3d3d)',
    borderRadius: '6px',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--atomic-editor-font, system-ui, -apple-system, BlinkMacSystemFont, sans-serif)',
    fontSize: '0.875rem',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '4px 10px',
    color: 'var(--atomic-editor-fg, #dcddde)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--atomic-editor-selection-bg, color-mix(in srgb, #7c3aed 28%, #1e1e1e 72%))',
    color: 'var(--atomic-editor-fg, #dcddde)',
  },
  '.cm-completionDetail': {
    color: 'var(--atomic-editor-fg-muted, #888)',
    fontStyle: 'normal',
    marginLeft: '0.75em',
  },
  '.cm-completionMatchedText': {
    textDecoration: 'none',
    color: 'var(--atomic-editor-accent-bright, #a78bfa)',
  },
});
