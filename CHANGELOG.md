# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until the package reaches `1.0.0`, minor versions may include breaking API
changes as the public surface stabilizes.

## [Unreleased]

### Changed

- Table visual pass, Linear-style: rounded 8px container with interior
  hairlines only, shaded header row (`--atomic-editor-bg-panel`), roomier
  cells (10px 14px), and a subtle row hover wash. Rendering-only — raw
  markdown is untouched and stays single-line per cell.

### Added

- **`preferResolvedLabel` on `WikiLinksConfig`.** With the flag on, labeled
  wiki links (`[[target|label]]`) resolve to and display the document's
  current title, falling back to the stored label while loading or when the
  target is missing — so renames propagate to every rendered link without
  rewriting document bytes. Purely a display preference; the source is never
  touched. Defaults to false (existing behavior unchanged).
- Table hover affordances for discoverability: a `+` on the right edge
  (append column), a `+` on the bottom edge (append row), and a `⋯`
  handle (top-right) that opens the existing table menu — all revealed on
  hover/focus, absolutely positioned so the widget's measured height and
  click routing below the table are unchanged. Edits flow through the
  existing model→serialize→dispatch paths (byte-identical to the context
  menu); right-click still works. Floating chrome uses the
  `--atomic-editor-menu-*` tokens with dark fallbacks.

Deliberately out of scope: column-width persistence (GFM has no width
syntax), multi-line cell content, and row drag-reorder.

### Fixed

- Typing a new row directly beneath a rendered table no longer corrupts
  the document (upstream bug): the instant lezer absorbed the just-typed
  `| … |` line into the Table node, the atomic block widget grew over the
  caret's line, CM6's DOM selection lost its text position, and further
  keystrokes landed at a displaced position. A table now reveals its raw
  source while the caret sits on its last line (the caret always owns a
  real text position) and folds the finished row into the widget as soon
  as the caret leaves — the same reveal-at-cursor convention the inline
  preview uses. Selection-only caret moves rebuild the decorations only
  when entering/leaving a pipe-bearing line, so ordinary cursor motion
  costs nothing.

## [0.6.0]

### Added

- **Slash-command insert menu.** Typing `/` at the start of a line opens a
  keyboard-navigable menu of block insertions (headings, lists, task list,
  quote, code block, table, divider, link, image). Opt-in via the new
  `slashCommands()` extension factory; custom items and default replacement
  via `SlashCommandsConfig`.
- **Slash menu redesigned** — per-row icons, an inset rounded pill for the
  hover/selected state, and card elevation. Fully themeable via seven new
  tokens: `--atomic-editor-menu-bg`, `--atomic-editor-menu-border`,
  `--atomic-editor-menu-shadow`, `--atomic-editor-menu-radius`,
  `--atomic-editor-menu-item-hover-bg`, `--atomic-editor-menu-fg`, and
  `--atomic-editor-menu-fg-muted` (dark fallbacks are built in). Each default
  command ships an icon; `SlashCommandItem.icon` sets a custom item's glyph
  (inline SVG using `currentColor`), and items without one fall back to a
  default glyph so the icon gutter stays aligned.
- `selectionToolbar()` — an opt-in floating formatting bar (bubble menu)
  shown above a non-empty selection, with bold / italic / strikethrough /
  inline-code / link toggle buttons, active-state highlighting, a bundled
  keymap (`Mod-b`, `Mod-i`, `Mod-Shift-x`, `Mod-e`, `Mod-k`), and
  `--atomic-editor-*` theming. Configurable button set via
  `SelectionToolbarConfig`.
- Byte-exact inline formatting toggle commands (`toggleBold`,
  `toggleItalic`, `toggleStrikethrough`, `toggleInlineCode`, `toggleLink`)
  plus the state-level helpers `applyFormat`, `getActiveFormats`, and
  `inlineFormattingAllowed`. Unwraps delete exactly the marker bytes read
  from the syntax tree; wraps trim whitespace out of the marked range and
  refuse anything that would produce broken markdown (marker-boundary
  crossings, code/frontmatter contexts).
- Multi-line selections toggle per line, Obsidian-style: the selection is
  split into whitespace-trimmed per-line segments; blank lines, code/
  frontmatter lines, and table rows are skipped; if every eligible line is
  already formatted the toggle unwraps them all, otherwise it wraps the
  unformatted ones — all in a single transaction (one undo step). The
  toolbar now shows for multi-line selections; the link toggle stays
  single-line (its button is disabled across lines).
- In-cell formatting: selecting text inside a table cell shows the same
  toolbar chrome (bold / italic / strikethrough — the marks cells render;
  no code or link in cells) anchored to the DOM selection. Toggles rewrite
  only the selected span of the cell's raw markdown and flow through the
  widget's existing single-cell commit path, so serialization, pipe
  escaping, and undo behavior are unchanged.
- Toolbar chrome tokens: both bars share a Linear-style look themed via
  `--atomic-editor-menu-bg`, `--atomic-editor-menu-border`,
  `--atomic-editor-menu-shadow`, `--atomic-editor-menu-radius`,
  `--atomic-editor-menu-item-hover-bg`, `--atomic-editor-menu-fg`, and
  `--atomic-editor-menu-fg-muted` (dark fallbacks inline; light values are
  the consuming theme's job). The active-format wash reuses
  `--atomic-editor-accent-soft` / the accent family — no bespoke token.

### Fixed

- The selection toolbar could stay hidden after a drag that released over
  a block widget (e.g. the table) or any element that stops pointer-event
  propagation: the drag-suppression latch now clears in the capture phase.
- Tooltips no longer escape the editor: the toolbar bundles a
  `tooltips({ tooltipSpace })` config clamping tooltip space to the
  editor's rect (intersected with the window), so a first-line selection
  flips the bar below instead of rendering over host chrome. This applies
  to every tooltip in the editor (autocomplete included) by design; a
  consumer's own `tooltipSpace` registered at higher precedence still
  wins. The in-cell bar flips below the selection near the top edge too.
- Wiki-link suggestions regressed to never resolving after the language-data
  registration change: the completion source closure was recreated on every
  read, so CodeMirror's autocomplete treated each update as a new source and
  dropped in-flight async results. The source is now built once, with
  regression tests locking source identity for both wiki-links and slash
  commands.

### Changed

- `wikiLinks` suggestions now register through language data instead of the
  autocomplete `override` config, so they compose with other completion
  sources (like `slashCommands`). As a side effect, nested code-language
  completions (e.g. HTML inside fences) can now surface while wiki-link
  suggestions are enabled.

## [0.5.1]

### Added

- Explicit TypeScript support declaration: `typescript` is now an **optional**
  peer dependency at `^5.0.0 || ^6.0.0`. Note for the curious: 0.5.0 declared
  no typescript peer at all (no package manager warned on TS 6 — we checked
  npm, pnpm, and bun against the published manifest), so this release adds
  the declaration rather than widening one. Optional peers emit no warning
  when absent; consumers on TS 5 or 6 are equally supported.

## [0.5.0] — @plannotator/atomic-editor

First release under the `@plannotator/atomic-editor` name (Plannotator's
fork of `@atomic-editor/editor`; upstream base: 0.4.3).

### Added

- YAML frontmatter parsing: a leading `---` block now parses as a dedicated
  `Frontmatter` node and renders as a quiet monospace metadata block with
  faded fences. Previously the opening fence parsed as a horizontal rule and
  the YAML body plus closing fence as a setext H2. Document bytes are
  untouched; round-trips remain byte-identical. Adds `@lezer/markdown` as a
  peer dependency.
- **Frontmatter Properties widget** (Obsidian-style). A parseable frontmatter
  block renders as a key/value grid: in-place key and value editing, list
  values as chips with add/remove, add/remove property rows, and an "edit as
  YAML source" toggle. Edits dispatch single-line document changes — editing
  one property never rewrites a neighboring line's bytes. YAML the grid can't
  faithfully represent (nested maps, comments, block scalars, unclosed fence)
  falls back to the styled raw text. Exported standalone as
  `frontmatterProperties()`.

## [0.4.3]

Table-editing hardening. The WYSIWYG table widget is the most custom part
of the editor, and its DOM ⇄ markdown round-trip and contenteditable cell
handling were hiding several bugs.

### Fixed

- **Insert column left/right now works.** Inserting a column adds an empty
  cell, and the table model counted columns from lezer `TableCell` nodes —
  which lezer doesn't emit for empty cells — so the new column was dropped
  on re-render even though the document was updated. Columns are now counted
  by splitting the row's raw text, so blank columns survive the round-trip.
- **Typing a literal `|` in a cell no longer corrupts the table.** Cell
  content is now escaped on serialize (`|` → `\|`, newlines flattened), so a
  pipe can't split the row and shift/drop later columns.
- **IME and dead-key composition work in cells.** The cell rebuilt its DOM on
  every input event, which cancelled an in-progress composition — dropping
  CJK input, accents, and dictation. Composition is now left alone until it
  ends.
- **Clicking a styled run (bold/italic/link) in a cell keeps the caret where
  you clicked** instead of jumping it to the end of the cell.
- **The external-link icon in a cell opens its URL.** It was a CSS `::after`
  pseudo-element, which has no event target, so clicking it dispatched no
  event. It's now a real element opened on click (a proper popup-activation
  gesture, so `window.open` isn't blocked).
- Pasting into a cell now inserts a single line of plain text — pasted rich
  HTML, newlines, or pipes no longer land verbatim and corrupt the row.

### Changed

- **Enter in a cell now advances to the next cell** (appending a row past the
  last one), mirroring Tab; Shift reverses direction. Previously it inserted
  a line break the single-line cell couldn't represent.
- Per-keystroke cell edits are tagged as input so the editor's undo history
  coalesces them into one step instead of one per keystroke.

## [0.4.2]

### Fixed

- Typing into a heading (or other line with hidden syntax) immediately after
  clicking it no longer crashes the editor. The inline-preview plugin freezes
  decoration rebuilds during a mouse interaction so a clicked heading's `## `
  prefix doesn't reveal mid-click and jitter. But while frozen it skipped the
  rebuild on doc changes too, handing CodeMirror a stale decoration set whose
  positions no longer matched the document — the `## ` replace then spanned
  the newly-typed line break, throwing `RangeError: Decorations that replace
  line breaks may not be specified via plugins` and corrupting the heightmap
  (`No tile at position …`, broken scroll-into-view, content "jumping"). The
  freeze now still rebuilds on document changes; it only suppresses the
  selection-driven reveal it was meant to.

## [0.4.1]

### Fixed

- `--atomic-editor-selection-bg` now actually takes effect. CodeMirror's base
  theme styles the active selection with a deeper selector than the package
  used (`&dark.cm-focused > .cm-scroller > .cm-selectionLayer
  .cm-selectionBackground`), so the token was silently overridden by the
  default selection color. The rule now mirrors that selector depth (the same
  approach `oneDark` takes), so the configured selection color applies in both
  themes.

## [0.4.0]

### Added

- `TablesConfig` is now exported from the package entry, so consumers passing
  `onLinkClick` to `tables()` can import the option type (the sibling
  `InlinePreviewConfig` and wiki-link types were already exported).
- The light theme now defines `--atomic-editor-accent-soft` and
  `--atomic-editor-initial-reveal-bg` / `-strong`. These were referenced but
  unset under `[data-theme="light"]`, so the blockquote rail and the
  reveal-on-arrival highlight previously borrowed dark-tuned values on a pale
  backdrop.

### Changed

- **Default link color** shifted from a standalone blue to an indigo that
  coordinates with the violet accent (`--atomic-editor-link` `#818cf8`,
  `--atomic-editor-link-hover` `#a5b4fc`; light mode uses violet). Set those
  variables to restore any previous color.
- Fenced code blocks now render with a subtle left rail so the block reads as
  a contained unit. The rail is an inset box-shadow, so line-box geometry (and
  CM6's height measurement) is unchanged.
- Inline-preview decorations are now built in a single syntax-tree walk per
  update instead of two, lowering the per-keystroke cost on large documents.
  No behavioral change.

### Fixed

- Mid-typing emphasis no longer flashes false italic inside intra-word
  underscores (e.g. `snake_case_var`), matching CommonMark's flanking rules.
- The find panel's match counter now reads `9999+` past its cap instead of a
  misleadingly exact count.
- Wiki-link resolution results are now capped (LRU by insertion), so a long
  session that scrolls through many distinct targets no longer grows the cache
  without bound.

## [0.3.0]

### Added

- **Wiki-link extension for atom-style `[[...]]` links.** Consumers can now
  compose `wikiLinks()` into the editor to render labeled wiki links, resolve
  bare targets asynchronously, open links from rendered text, and provide
  CodeMirror autocomplete suggestions. The extension supports custom
  serialization, resolver policies, debounced suggestions, and leaves draft
  links editable while the cursor is inside them.
- **Code-fence auto-close.** Typing an opening triple-backtick fence now inserts
  the matching closing fence so a fence added in the middle of a note does not
  swallow all following content.
- **Demo wiki-link deeplinks.** The dev demo includes sample wiki-link
  suggestions, async resolution, and a lightweight deeplink readout for manual
  testing.

### Fixed

- **Markdown link icon click behavior.** Clicking the rendered external-link
  icon next to a markdown link no longer expands the raw markdown; only clicking
  the link text itself enters edit mode.
- **Missing wiki-link Backspace behavior.** Backspacing immediately after a
  rendered missing bare link now first reveals the raw `[[...]]` source, then
  normal Backspace edits inside the link instead of pulling the rendered link
  through preceding content.

### Changed

- The dev server now binds to `0.0.0.0` and accepts arbitrary dev hostnames,
  which makes package-level testing easier from LAN and tunneled environments.

## [0.2.1]

### Fixed

- **Crash on multi-line link / image titles.** A markdown link or image
  whose title wraps across lines — e.g. `[text](url "first\nsecond")` —
  threw `RangeError: Decorations that replace line breaks may not be
  specified via plugins` and took the editor down on mount. Root cause:
  the inline-preview `ViewPlugin` hides syntax tokens via
  `Decoration.replace`, and CM6 forbids plugin-sourced replaces from
  crossing a newline (block / line-spanning decorations must come from a
  `StateField`). Lezer legitimately emits such nodes for wrapped
  `LinkTitle` / image-title constructs. Every replace in the builder is
  now routed through a `pushReplace` helper that splits multi-line
  ranges into per-line segments; the first segment keeps any widget, so
  bullet / checkbox markers still render exactly once.

## [0.2.0]

### Added

- **`initialRevealText` prop + `revealText(query)` imperative method**
  for arriving-from-search-result navigation. Scrolls the first match
  near the top of its scroll parent (handles editors embedded in a
  larger scrolling shell) and paints a 3.2 s fade-out highlight — no
  search panel, no cursor move, no lingering UI. Matcher falls back
  progressively (exact → whitespace-collapsed → individual lines →
  truncated prefixes at 140 and 80 chars) so hits resolve even when
  the query came from an LLM-massaged snippet that doesn't match the
  source byte-for-byte.
- CSS variables `--atomic-editor-initial-reveal-bg` and
  `--atomic-editor-initial-reveal-bg-strong` for theming the peak and
  settled colors of the reveal highlight independently of the main
  search-match palette.

## [0.1.1]

### Fixed

- **Click routing after block widgets.** Clicks on lines below a table
  would route the caret to the line below the one visually targeted —
  most visible as "clicking the blank line above a heading placed the
  caret on the heading". Root cause: `.cm-atomic-table` used vertical
  `margin` for rhythm, which `getBoundingClientRect` (CM6's widget
  measurement) excludes but DOM layout reserves. The heightmap ran
  ~17 px short of reality for every line below the table. Changed to
  `padding`, which CM6 measures correctly.

### Other

- Shrink heading `padding-top` so the visually-empty strip above a
  heading is ~3 px instead of ~14 px — reduces the separate class of
  "clicked above the heading, landed on it" UX cases.
- Demo homepage now leads with the hero trio (code block, table, task
  list) and uses "Atomic Editor" as the display name in the header and
  tab title.

## [0.1.0] — Initial release

Extracted from [Atomic](https://github.com/kenforthewin/atomic) as a
standalone package.

- `AtomicCodeMirrorEditor` React component with Obsidian-style inline
  live preview: stable layout across active / inactive lines, no
  reveal-during-click, tight-list continuation, pointer-freeze guard
  on mouse interaction.
- Interactive WYSIWYG table widget (in-place cell editing, click-to-
  rebuild, horizontal scroll for wide tables).
- Image block rendering (inline `![](…)` source hidden below a
  rendered image with keep-size placeholder).
- Dark-theme defaults + `[data-theme="light"]` light variant via CSS
  variables only — no JavaScript toggle needed.
- Syntax highlighting for fenced code blocks via the `codeLanguages`
  prop. An optional curated 20-language registry is exported at
  `@atomic-editor/editor/code-languages` with lazy-loaded grammars.
- Minimal search panel (input + match counter + prev/next/close),
  styled to match the editor theme.
