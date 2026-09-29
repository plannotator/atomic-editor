import { Facet, StateEffect, type EditorState, type Extension } from '@codemirror/state';
import { logException, type WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

// Link widgets — a host seam on the engine's own link decorator.
//
// A host registers one or more specs with `linkWidgets(...)`. When the
// inline preview would draw a single-line `[text](url)` link with its
// syntax hidden (not revealed by the caret, not a diff-changed source),
// it asks each spec in order; the first non-null widget replaces the
// whole Link range. Everything the reveal rule already decides — focus,
// inclusive selection overlap, the pointer-press freeze, diff refusal —
// stays in the engine, so a widget comes and goes exactly when the
// link's hidden syntax would.

/** A link as the engine's link decorator reads it. */
export interface LinkWidgetLink {
  /** The URL bytes as written (the `URL` node), angle brackets included. */
  url: string;
  /** The link text as written between the brackets, escapes included. */
  text: string;
  /**
   * The title as written inside its delimiters (`"…"`, `'…'` or `(…)`),
   * escapes included; the delimiters themselves are dropped. Absent when
   * the link has no title.
   */
  title?: string;
  /** Document offset of the link's opening `[`. */
  from: number;
  /** Document offset just past the link's closing `)`. */
  to: number;
}

export interface LinkWidgetSpec {
  /**
   * A widget to draw in the link's place, or null for the engine's own
   * link. Called during the decoration build: synchronous, no side
   * effects. The engine rebuilds on every selection, focus and document
   * change, so `match` is called often; implement `eq` on the returned
   * widget (the engine does not) so an unchanged widget keeps its DOM.
   * Use `from`/`to` in `eq` only if two occurrences of the same link
   * must be told apart.
   */
  match(link: LinkWidgetLink): WidgetType | null;
}

export const linkWidgetsFacet = Facet.define<readonly LinkWidgetSpec[], readonly LinkWidgetSpec[]>({
  combine: (values) => values.flat(),
  // Compare element-wise so an unrelated reconfiguration (a compartment
  // swap elsewhere) does not read as a new spec list and force a rebuild.
  compare: (a, b) => a.length === b.length && a.every((spec, i) => spec === b[i]),
});

/**
 * An effect-only transaction carrying this effect makes the inline
 * preview rebuild its link decorations and ask every spec's `match`
 * again — for hosts whose answer changes without a document change (a
 * record arrives from the network after mount). Changes no document
 * text and adds no history entry. While a pointer press holds the
 * preview frozen the rebuild waits for the release.
 */
export const refreshLinkWidgets = StateEffect.define<null>();

// Specs whose `match` threw, so each is logged once, not per rebuild.
const loggedSpecs = new WeakSet<LinkWidgetSpec>();

/**
 * Register host link drawers, read by the engine's own link decorator
 * (`inlinePreview()`). Specs are asked in registration order; several
 * `linkWidgets(...)` extensions concatenate in extension order.
 */
export function linkWidgets(...specs: LinkWidgetSpec[]): Extension {
  return linkWidgetsFacet.of(specs);
}

/**
 * Ask the registered specs for a widget for a single-line inline Link
 * node. Returns null for anything the seam does not offer: links
 * without a `(url)` destination (reference, shortcut and wiki-link
 * interiors), links spanning a line break, links inside a table,
 * links whose text holds an image, or when no spec answers.
 */
export function matchLinkWidget(
  state: EditorState,
  specs: readonly LinkWidgetSpec[],
  node: SyntaxNode,
): WidgetType | null {
  if (specs.length === 0) return null;
  const { doc } = state;
  if (doc.lineAt(node.from).number !== doc.lineAt(node.to).number) return null;
  // Never offer a link the `wikiLinks()` scanner could claim. That scanner
  // pairs a `[[` with the next `]]` on the line and ignores escapes, so a
  // link opened right after a `[` is refused only when a `]]` follows it on
  // the same line; `[[a](url)` and `\[[a](url)` (no closing `]]`) are offered.
  if (node.from > 0 && doc.sliceString(node.from - 1, node.from) === '[') {
    const line = doc.lineAt(node.from);
    if (doc.sliceString(node.from, line.to).includes(']]')) return null;
  }
  // Table cells are drawn by the table widget, which does not read this
  // seam; do not ask hosts about links they can never draw.
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === 'Table') return null;
  }
  // `[![alt](src)](url)`: an image inside the link text stays on the
  // engine's own rendering.
  if (node.getChild('Image')) return null;

  const urlNode = node.getChild('URL');
  if (!urlNode) return null;
  const marks = node.getChildren('LinkMark');
  // Inline form: `[` `]` `(` … `)`.
  if (marks.length < 4) return null;
  const [open, close, paren] = marks;
  if (
    doc.sliceString(open.from, open.to) !== '[' ||
    doc.sliceString(close.from, close.to) !== ']' ||
    doc.sliceString(paren.from, paren.to) !== '(' ||
    doc.sliceString(node.to - 1, node.to) !== ')'
  ) {
    return null;
  }

  const link: LinkWidgetLink = {
    url: doc.sliceString(urlNode.from, urlNode.to),
    text: doc.sliceString(open.to, close.from),
    from: node.from,
    to: node.to,
  };
  const titleNode = node.getChild('LinkTitle');
  if (titleNode && titleNode.to - titleNode.from >= 2) {
    link.title = doc.sliceString(titleNode.from + 1, titleNode.to - 1);
  }

  for (const spec of specs) {
    let widget: WidgetType | null = null;
    try {
      widget = spec.match(link);
    } catch (error) {
      // A throwing host spec must not take the whole inline preview down
      // (CM6 disables a plugin whose update throws). Fall through to the
      // next spec, and log once per spec rather than on every rebuild.
      if (!loggedSpecs.has(spec)) {
        loggedSpecs.add(spec);
        logException(state, error, 'linkWidgets match');
      }
    }
    if (widget) return widget;
  }
  return null;
}
