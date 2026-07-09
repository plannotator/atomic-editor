import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { frontmatter } from '../frontmatter';
import { applyFormat, inlineFormattingAllowed } from '../formatting-commands';

// Integration between two features developed on separate branches: the
// formatting commands' frontmatter guard was written against the node name
// alone, before the fork's frontmatter parser was in the same tree. This
// locks the interaction in on the merged mainline: selections inside a real
// parsed Frontmatter node must refuse every inline format, while body text
// right below the block stays formattable.
const DOC = '---\ntitle: hello world\n---\n\nSome body text\n';

function makeState(anchor: number, head: number): EditorState {
  return EditorState.create({
    doc: DOC,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdown({ base: markdownLanguage, extensions: [frontmatter] })],
  });
}

describe('formatting commands inside frontmatter', () => {
  it('refuses every format on a selection inside the YAML block', () => {
    const inYaml = makeState(11, 16); // "hello" in `title: hello world`
    expect(inlineFormattingAllowed(inYaml)).toBe(false);
    for (const format of ['bold', 'italic', 'strikethrough', 'code', 'link'] as const) {
      expect(applyFormat(inYaml, format)).toBeNull();
    }
  });

  it('still formats body text below the frontmatter block', () => {
    const inBody = makeState(28, 32); // "Some" in the body paragraph
    expect(inlineFormattingAllowed(inBody)).toBe(true);
    const spec = applyFormat(inBody, 'bold');
    expect(spec).not.toBeNull();
    const next = inBody.update(spec!).state;
    expect(next.doc.toString()).toBe('---\ntitle: hello world\n---\n\n**Some** body text\n');
  });
});
