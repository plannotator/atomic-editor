import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection, type ChangeSpec, type EditorState, type TransactionSpec } from '@codemirror/state';
import { type Command } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';

// Toolbar-driven inline formatting for the GFM markdown editor.
//
// The editor's one inviolable rule is that it never changes document
// bytes the user didn't type. A toggle command IS a user-triggered
// edit, but it must touch ONLY the marker bytes it means to — never
// re-serialize, re-wrap, or normalize the surrounding text. Every
// deletion here is computed from the exact byte range of a syntax-tree
// mark node (EmphasisMark, CodeMark, LinkMark, …), never from a regex
// scan, so an unwrap removes precisely the markers lezer recognised and
// nothing adjacent to them.
//
// The commands run at pure `EditorState` level (no `EditorView`) so a
// consumer can dispatch a toggle from a headless transaction. That is
// why the syntax tree is obtained with `ensureSyntaxTree` — the lazy
// CM6 parser may not have reached the selection yet, and we force it to
// parse at least through the selection's line before inspecting nodes.

/** The five inline formats the toolbar can toggle. */
export type InlineFormat = 'bold' | 'italic' | 'strikethrough' | 'code' | 'link';

interface FormatNode {
  /** The lezer block/inline node that encloses a formatted span. */
  node: string;
  /** The direct mark-child node whose ranges are the literal markers. */
  mark: string;
}

// Node/mark names are exactly the @lezer/markdown (GFM) grammar names.
// Italic always writes `*`, never `_`: under CommonMark's flanking
// rules `*` opens/closes emphasis intra-word (`a*b*c`) but `_` does not,
// so `*` is the only marker that toggles reliably on an arbitrary word.
const FORMAT_NODES: Record<InlineFormat, FormatNode> = {
  bold: { node: 'StrongEmphasis', mark: 'EmphasisMark' },
  italic: { node: 'Emphasis', mark: 'EmphasisMark' },
  strikethrough: { node: 'Strikethrough', mark: 'StrikethroughMark' },
  code: { node: 'InlineCode', mark: 'CodeMark' },
  link: { node: 'Link', mark: 'LinkMark' },
};

// The five node names that represent an inline-formatted span. Used by
// the wrap-branch refusal checks: wrapping across the boundary of any
// one of these produces broken markdown.
const INLINE_FORMAT_NODES = new Set<string>([
  'StrongEmphasis',
  'Emphasis',
  'Strikethrough',
  'InlineCode',
  'Link',
]);

// Block contexts where inline markers are inert bytes rather than
// emphasis. Frontmatter is spelled two ways because a fork branch adds
// frontmatter parsing under one name and upstream may land another —
// we guard by string so either parse blocks formatting.
const BLOCK_BLOCKERS = new Set<string>([
  'FencedCode',
  'CodeBlock',
  'HTMLBlock',
  'Frontmatter',
  'FrontMatter',
]);

/**
 * State-level core. Returns the transaction spec for toggling `format`
 * on the main selection, or `null` when the toggle refuses (multi-cursor,
 * multi-line, blocked block context, a boundary-crossing wrap, etc. — see
 * the refusal rules in-file). Never returns a spec that alters bytes the
 * toggle doesn't own.
 */
export function applyFormat(state: EditorState, format: InlineFormat): TransactionSpec | null {
  if (!inlineFormattingAllowed(state)) return null;

  const sel = state.selection.main;
  const from = sel.from;
  const to = sel.to;
  const tree = treeForSelection(state, to);

  // A whitespace-only selection has no content to mark; `** **` is
  // invalid CommonMark, so refuse rather than emit dead markers.
  if (from < to && state.doc.sliceString(from, to).trim() === '') return null;

  // Emphasis/link markers inside a code span are literal bytes, so any
  // format other than code refuses when enclosed by an InlineCode node.
  if (format !== 'code' && enclosingNode(tree, 'InlineCode', from, to)) return null;

  const spec = FORMAT_NODES[format];
  const enclosing = enclosingNode(tree, spec.node, from, to);
  if (enclosing) return unwrap(state, enclosing, spec, from, to);

  return wrap(state, tree, format, from, to);
}

/**
 * The formats whose node type structurally encloses the main selection.
 * Drives the toolbar's active-button state (e.g. inside `**a *b* c**` at
 * `b` this is `{'bold','italic'}`).
 */
export function getActiveFormats(state: EditorState): Set<InlineFormat> {
  const active = new Set<InlineFormat>();
  if (state.selection.ranges.length !== 1) return active;

  const sel = state.selection.main;
  const tree = treeForSelection(state, sel.to);
  for (const format of Object.keys(FORMAT_NODES) as InlineFormat[]) {
    if (enclosingNode(tree, FORMAT_NODES[format].node, sel.from, sel.to)) {
      active.add(format);
    }
  }
  return active;
}

/**
 * True when inline formatting is structurally possible at the main
 * selection: exactly one range, the range does not span a line break,
 * and no blocked block-context ancestor (fenced code, indented code,
 * HTML block, frontmatter). Does NOT require a non-empty selection —
 * an empty cursor can still insert an empty marker pair.
 */
export function inlineFormattingAllowed(state: EditorState): boolean {
  // v1 refuses multi-cursor: a single transaction toggling several
  // disjoint ranges would need per-range wrap/unwrap arbitration.
  if (state.selection.ranges.length !== 1) return false;

  const sel = state.selection.main;
  // Inline emphasis never spans a hard line break in CommonMark.
  if (state.doc.lineAt(sel.from).number !== state.doc.lineAt(sel.to).number) return false;

  const tree = treeForSelection(state, sel.to);
  for (let node: SyntaxNode | null = tree.resolveInner(sel.from, 1); node; node = node.parent) {
    if (BLOCK_BLOCKERS.has(node.name)) return false;
  }
  return true;
}

/** CM6 command: toggle bold (`**…**`) on the main selection. */
export const toggleBold: Command = makeToggleCommand('bold');

/** CM6 command: toggle italic (`*…*`) on the main selection. */
export const toggleItalic: Command = makeToggleCommand('italic');

/** CM6 command: toggle strikethrough (`~~…~~`) on the main selection. */
export const toggleStrikethrough: Command = makeToggleCommand('strikethrough');

/** CM6 command: toggle an inline code span on the main selection. */
export const toggleInlineCode: Command = makeToggleCommand('code');

/** CM6 command: toggle an inline link on the main selection. */
export const toggleLink: Command = makeToggleCommand('link');

// A toggle command is the thin view-level wrapper: compute the spec at
// state level and dispatch it, or report "not handled" (false) so the
// keymap falls through when the toggle refuses.
function makeToggleCommand(format: InlineFormat): Command {
  return (view) => {
    const spec = applyFormat(view.state, format);
    if (!spec) return false;
    view.dispatch(spec);
    return true;
  };
}

// The commands must work with no view, so the lazy parser may not have
// reached the selection. Force it through the end of the selection's
// line (a bounded amount of work), falling back to whatever tree exists
// if the budget is exhausted.
function treeForSelection(state: EditorState, to: number): Tree {
  const upTo = Math.min(state.doc.length, state.doc.lineAt(to).to);
  return ensureSyntaxTree(state, upTo, 100) ?? syntaxTree(state);
}

// Find the innermost ancestor named `name` that encloses [from, to].
//
// Detection walks up from `resolveInner(from, 1)` (bias forward). That
// bias is deliberate: a cursor sitting exactly at a node's `to` (just
// past the closing marker) resolves into whatever follows, so the span
// is treated as OUTSIDE — toggling there wraps a new span rather than
// unwrapping the one that just ended. For an empty selection we retry
// with bias -1 to catch a cursor resting inside a span the forward bias
// stepped over, but still reject the `node.to` boundary (from < node.to).
function enclosingNode(tree: Tree, name: string, from: number, to: number): SyntaxNode | null {
  const forward = walkToEnclosing(tree.resolveInner(from, 1), name, from, to);
  if (forward) return forward;
  if (from === to) {
    const backward = walkToEnclosing(tree.resolveInner(from, -1), name, from, to);
    if (backward && from < backward.to) return backward;
  }
  return null;
}

function walkToEnclosing(
  start: SyntaxNode | null,
  name: string,
  from: number,
  to: number,
): SyntaxNode | null {
  for (let node = start; node; node = node.parent) {
    if (node.name === name && node.from <= from && to <= node.to) return node;
  }
  return null;
}

// UNWRAP: delete exactly the node's own marker bytes, nothing else.
//
// We read the marker ranges from the node's DIRECT mark children
// (`getChildren`), which matters for nesting: `**a *b* c**` has a nested
// Emphasis with its OWN EmphasisMark pair, but the StrongEmphasis reports
// only its outer two. Deleting the exact CodeMark ranges also makes fence
// length irrelevant (```` ``x`` ```` unwraps byte-exact) and leaves any
// padding spaces — they are real document bytes — untouched.
function unwrap(
  state: EditorState,
  node: SyntaxNode,
  spec: FormatNode,
  from: number,
  to: number,
): TransactionSpec | null {
  const marks = node.getChildren(spec.mark);
  // Malformed span (a marker got eaten by a partial parse): refuse
  // rather than guess which bytes to remove.
  if (marks.length < 2) return null;

  let changes: ChangeSpec;
  if (spec.node === 'Link') {
    // A Link's LinkMarks are `[`, `]`, `(`, `)`. Delete the opening
    // `[`, then everything from the `]` through the node end — that is
    // `](url)` plus any optional title — keeping only the link text.
    const open = marks[0];
    const closeStart = marks[1].from;
    changes = [
      { from: open.from, to: open.to },
      { from: closeStart, to: node.to },
    ];
  } else {
    // The open marker is the first mark child, the close the last.
    const open = marks[0];
    const close = marks[marks.length - 1];
    changes = [
      { from: open.from, to: open.to },
      { from: close.from, to: close.to },
    ];
  }

  // Map the user's selection through the deletions so it stays on the
  // same text (biased inward, tight against the now-unmarked content).
  const changeSet = state.changes(changes);
  return {
    changes,
    selection: EditorSelection.range(changeSet.mapPos(from, 1), changeSet.mapPos(to, -1)),
  };
}

// WRAP: insert a marker pair around the (whitespace-trimmed) selection.
function wrap(
  state: EditorState,
  tree: Tree,
  format: InlineFormat,
  from: number,
  to: number,
): TransactionSpec | null {
  const doc = state.doc;

  // Shrink the range so no leading/trailing whitespace sits inside the
  // markers: `** bold **` is not valid CommonMark emphasis, `**bold**`
  // is. The trimmed-off spaces stay in the document, outside the markers.
  let trimFrom = from;
  let trimTo = to;
  while (trimFrom < trimTo && isWhitespace(doc.sliceString(trimFrom, trimFrom + 1))) trimFrom++;
  while (trimTo > trimFrom && isWhitespace(doc.sliceString(trimTo - 1, trimTo))) trimTo--;

  // Nothing to link, and no existing link to unwrap (we are in the wrap
  // branch): a bare `[](url)` around a cursor has no anchor text.
  if (format === 'link' && from === to) return null;

  if (wrapWouldBreakMarkdown(tree, format, trimFrom, trimTo)) return null;

  const [open, close] = wrapMarkers(format, doc.sliceString(trimFrom, trimTo));

  // Empty selection: drop the marker pair with the cursor between them
  // (`**|**`, `*|*`, `~~|~~`, `` `|` ``), ready for the user to type.
  if (from === to) {
    return {
      changes: { from, insert: open + close },
      selection: EditorSelection.cursor(from + open.length),
    };
  }

  const changes: ChangeSpec = [
    { from: trimFrom, insert: open },
    { from: trimTo, insert: close },
  ];

  if (format === 'link') {
    // Select the `url` placeholder inside the inserted `](url)` so the
    // user types the destination immediately. The closing insert lands
    // after the opening `[`, so it begins at `trimTo + open.length`;
    // `url` sits two bytes into `](url)`.
    const urlFrom = trimTo + open.length + 2;
    return { changes, selection: EditorSelection.range(urlFrom, urlFrom + 3) };
  }

  // Keep the content selected (markers hug it on the outside) so toggling
  // the same format twice round-trips to the original document.
  const changeSet = state.changes(changes);
  return {
    changes,
    selection: EditorSelection.range(changeSet.mapPos(trimFrom, 1), changeSet.mapPos(trimTo, -1)),
  };
}

// Reject a wrap that would cross a formatting boundary or collide with a
// same-type span — either produces markdown that parses unpredictably.
function wrapWouldBreakMarkdown(
  tree: Tree,
  format: InlineFormat,
  from: number,
  to: number,
): boolean {
  const sameType = FORMAT_NODES[format].node;
  let refuse = false;

  // Expand the scan by one byte on each side so an inline node sitting
  // exactly adjacent to the range (its edge touching `from` or `to`) is
  // still visited by the range-limited iteration.
  const scanFrom = Math.max(0, from - 1);
  const scanTo = Math.min(tree.length, to + 1);

  tree.iterate({
    from: scanFrom,
    to: scanTo,
    enter: (node) => {
      if (!INLINE_FORMAT_NODES.has(node.name)) return;

      // Rule: any inline node that strictly crosses exactly ONE
      // endpoint splits a marker pair when we wrap. A node enclosing
      // BOTH endpoints is fine (nesting, e.g. bold inside italic); a
      // different-type node lying fully inside is fine (`**a [x](y) b**`).
      const crossesFrom = node.from < from && from < node.to;
      const crossesTo = node.from < to && to < node.to;
      if (crossesFrom !== crossesTo) refuse = true;

      // Rule: a SAME-type node that touches or intersects the range —
      // inside it, or an adjacent doubled marker like `**a****b**` —
      // parses unpredictably. Deliberate v1 conservatism.
      if (node.name === sameType && node.from <= to && node.to >= from) refuse = true;
    },
  });

  return refuse;
}

// The literal marker strings for a wrap. Bold/italic/strike are fixed
// pairs; code and link are computed from the content.
function wrapMarkers(format: InlineFormat, content: string): [string, string] {
  switch (format) {
    case 'bold':
      return ['**', '**'];
    case 'italic':
      return ['*', '*'];
    case 'strikethrough':
      return ['~~', '~~'];
    case 'link':
      return ['[', '](url)'];
    case 'code': {
      // CommonMark: a code span's fence must be longer than any
      // backtick run it contains, so use (longest run) + 1 backticks.
      const fence = '`'.repeat(longestBacktickRun(content) + 1);
      // And if the content begins or ends with a backtick, one space
      // of padding is required inside each fence; that padding is
      // stripped when rendered but stored as real bytes here.
      const pad = content.startsWith('`') || content.endsWith('`') ? ' ' : '';
      return [fence + pad, pad + fence];
    }
  }
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === '`') {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}
