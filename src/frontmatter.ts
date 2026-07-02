import type { BlockContext, Line, MarkdownConfig } from '@lezer/markdown';

// Closing fence: exactly `---`, trailing blanks tolerated (matches
// Obsidian / Jekyll). The OPENING fence is stricter — the literal
// three characters on line 1 — so `----` (a thematic break) never
// triggers frontmatter.
const CLOSE_FENCE = /^---[ \t]*$/;

/**
 * YAML frontmatter support for the markdown parser.
 *
 * Without this, a leading `---` block falls through to core
 * CommonMark rules and gets misparsed: the opening fence becomes a
 * HorizontalRule, the YAML body plus closing fence become a
 * SetextHeading2 (the closing `---` reads as a heading underline),
 * and inline-preview then renders the metadata as a giant H2 under
 * a stray rule. Parsing it as a dedicated `Frontmatter` node keeps
 * those rules away from it and gives the preview layer something to
 * style as metadata. The document text itself is never touched —
 * this changes the syntax tree only.
 *
 * The YAML body is left as an unparsed leaf on purpose: nothing
 * inside it should light up as markdown, and wiring a nested YAML
 * grammar would drag in an optional dependency for marginal gain.
 */
export const frontmatter: MarkdownConfig = {
  defineNodes: [
    { name: 'Frontmatter', block: true },
    { name: 'FrontmatterMark' },
  ],
  parseBlock: [
    {
      name: 'Frontmatter',
      // Must win against HorizontalRule, which also matches `---`.
      before: 'HorizontalRule',
      parse(cx: BlockContext, line: Line): boolean {
        // Only ever at the very start of the document.
        if (cx.lineStart !== 0 || line.text !== '---') return false;
        const marks = [cx.elt('FrontmatterMark', 0, 3)];
        let end = 3;
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          if (CLOSE_FENCE.test(line.text)) {
            marks.push(cx.elt('FrontmatterMark', cx.lineStart, end));
            cx.nextLine();
            cx.addElement(cx.elt('Frontmatter', 0, end, marks));
            return true;
          }
        }
        // No closing fence. Block parsers can't un-consume lines, so
        // the open block runs to EOF. That state is transient (the
        // moment the user types the closing `---`, an incremental
        // reparse snaps everything back) and purely visual — the
        // document bytes are untouched either way.
        cx.addElement(cx.elt('Frontmatter', 0, end, marks));
        return true;
      },
    },
  ],
};
