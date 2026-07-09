import { history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  applyFormat,
  getActiveFormats,
  type InlineFormat,
  inlineFormattingAllowed,
} from '../formatting-commands';

// Build a state exactly the way the toolbar runs: GFM markdown (tables,
// strikethrough) with the base language so the syntax tree carries the
// StrongEmphasis/Emphasis/Strikethrough/InlineCode/Link nodes the
// commands read. No DOM is needed — everything is pure state.
function makeState(doc: string, anchor: number, head: number, extra: Extension[] = []): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdown({ base: markdownLanguage }), ...extra],
  });
}

interface Applied {
  text: string;
  from: number;
  to: number;
}

// Apply a toggle and report the FULL resulting document plus the mapped
// selection, or null when the toggle refuses.
function apply(doc: string, anchor: number, head: number, format: InlineFormat): Applied | null {
  const state = makeState(doc, anchor, head);
  const spec = applyFormat(state, format);
  if (!spec) return null;
  const next = state.update(spec).state;
  return { text: next.doc.toString(), from: next.selection.main.from, to: next.selection.main.to };
}

// Toggle the same format twice from the same selection and return the
// final document — the round-trip that must reproduce the input bytes.
function roundTrip(doc: string, anchor: number, head: number, format: InlineFormat): string {
  const s0 = makeState(doc, anchor, head);
  const s1 = s0.update(applyFormat(s0, format)!).state;
  const s2 = s1.update(applyFormat(s1, format)!).state;
  return s2.doc.toString();
}

describe('applyFormat — plain wrap', () => {
  it('wraps bold and leaves the content selected', () => {
    expect(apply('hello world', 0, 5, 'bold')).toEqual({ text: '**hello** world', from: 2, to: 7 });
  });

  it('wraps italic with a single asterisk (never underscore)', () => {
    expect(apply('hello world', 0, 5, 'italic')).toEqual({ text: '*hello* world', from: 1, to: 6 });
  });

  it('wraps strikethrough', () => {
    expect(apply('hello world', 0, 5, 'strikethrough')).toEqual({
      text: '~~hello~~ world',
      from: 2,
      to: 7,
    });
  });

  it('wraps inline code', () => {
    expect(apply('hello world', 0, 5, 'code')).toEqual({ text: '`hello` world', from: 1, to: 6 });
  });

  it('wraps a link and selects the url placeholder', () => {
    expect(apply('hello world', 6, 11, 'link')).toEqual({
      text: 'hello [world](url)',
      from: 14,
      to: 17,
    });
  });
});

describe('applyFormat — exact unwrap', () => {
  it('unwraps bold from a selection strictly inside the span', () => {
    expect(apply('**bold**', 2, 6, 'bold')).toEqual({ text: 'bold', from: 0, to: 4 });
  });

  it('unwraps bold when the selection spans the whole span including markers', () => {
    expect(apply('**bold**', 0, 8, 'bold')?.text).toBe('bold');
  });

  it('unwraps italic', () => {
    expect(apply('*italic*', 1, 7, 'italic')?.text).toBe('italic');
  });

  it('unwraps strikethrough', () => {
    expect(apply('~~gone~~', 2, 6, 'strikethrough')?.text).toBe('gone');
  });

  it('unwraps inline code', () => {
    expect(apply('`code`', 1, 5, 'code')?.text).toBe('code');
  });

  it('unwraps underscore-marked bold byte-exact', () => {
    expect(apply('__bold__', 2, 6, 'bold')?.text).toBe('bold');
  });

  it('unwraps underscore-marked italic byte-exact', () => {
    expect(apply('_it_', 1, 3, 'italic')?.text).toBe('it');
  });
});

describe('applyFormat — empty selection marker-pair insert', () => {
  it('inserts an empty bold pair with the cursor between', () => {
    expect(apply('', 0, 0, 'bold')).toEqual({ text: '****', from: 2, to: 2 });
  });

  it('inserts an empty italic pair', () => {
    expect(apply('', 0, 0, 'italic')).toEqual({ text: '**', from: 1, to: 1 });
  });

  it('inserts an empty strikethrough pair', () => {
    expect(apply('', 0, 0, 'strikethrough')).toEqual({ text: '~~~~', from: 2, to: 2 });
  });

  it('inserts an empty inline-code pair', () => {
    expect(apply('', 0, 0, 'code')).toEqual({ text: '``', from: 1, to: 1 });
  });

  it('refuses an empty-selection link (nothing to anchor)', () => {
    expect(applyFormat(makeState('', 0, 0), 'link')).toBeNull();
  });
});

describe('applyFormat — whitespace trimming', () => {
  it('hugs the trimmed content, leaving the padding spaces outside', () => {
    expect(apply(' bold ', 0, 6, 'bold')).toEqual({ text: ' **bold** ', from: 3, to: 7 });
  });

  it('refuses a whitespace-only selection', () => {
    expect(applyFormat(makeState('a   b', 1, 4), 'bold')).toBeNull();
  });
});

describe('applyFormat — structural refusals leave the document untouched', () => {
  it('refuses a partial overlap of an existing span', () => {
    const state = makeState('**bold** text', 4, 10);
    expect(applyFormat(state, 'bold')).toBeNull();
    expect(state.doc.toString()).toBe('**bold** text');
  });

  it('refuses a wrap of a different type crossing an existing span boundary', () => {
    // Italic from inside `**bold**` into the plain text would produce
    // `**bo*ld** text*` — a split marker pair. Same refusal rule, but
    // exercising the crossing branch rather than the same-type branch.
    const state = makeState('**bold** text', 4, 10);
    expect(applyFormat(state, 'italic')).toBeNull();
    expect(state.doc.toString()).toBe('**bold** text');
  });

  it('refuses inside a fenced code block', () => {
    expect(applyFormat(makeState('```\ncode\n```', 5, 8), 'bold')).toBeNull();
  });

  it('refuses a multi-cursor selection', () => {
    const state = EditorState.create({
      doc: 'abcd',
      selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(2, 3)]),
      extensions: [markdown({ base: markdownLanguage }), EditorState.allowMultipleSelections.of(true)],
    });
    expect(applyFormat(state, 'bold')).toBeNull();
  });

  it('refuses a same-type span lying fully inside the selection', () => {
    expect(applyFormat(makeState('a **b** c', 0, 9), 'bold')).toBeNull();
  });

  it('refuses a same-type span exactly adjacent to the selection', () => {
    expect(applyFormat(makeState('**a**b', 5, 6), 'bold')).toBeNull();
  });

  it('refuses non-code formatting when the selection is inside inline code', () => {
    expect(applyFormat(makeState('`code`', 2, 4), 'bold')).toBeNull();
  });
});

describe('applyFormat — nested emphasis', () => {
  it('unwraps only the inner Emphasis inside a bold run', () => {
    expect(apply('**bold *it* more**', 8, 10, 'italic')).toEqual({
      text: '**bold it more**',
      from: 7,
      to: 9,
    });
  });

  it('nests bold inside italic when wrapping a word already italicised', () => {
    expect(apply('*italic*', 1, 7, 'bold')?.text).toBe('***italic***');
  });

  // The lezer parse of `***x***` is Emphasis > StrongEmphasis > Emphasis-
  // marks, so toggling bold removes the inner `**` pair and toggling
  // italic removes the outer `*` pair. Byte-exact expectations pinned to
  // that parse.
  it('toggles bold off `***x***` down to `*x*`', () => {
    expect(apply('***x***', 3, 4, 'bold')?.text).toBe('*x*');
  });

  it('toggles italic off `***x***` down to `**x**`', () => {
    expect(apply('***x***', 3, 4, 'italic')?.text).toBe('**x**');
  });
});

describe('applyFormat — inline code with backticks', () => {
  it('grows the fence to two backticks around content containing one', () => {
    expect(apply('a`b', 0, 3, 'code')?.text).toBe('``a`b``');
  });

  it('pads with a space when the content ends in a backtick', () => {
    expect(apply('a`', 0, 2, 'code')?.text).toBe('`` a` ``');
  });

  it('unwraps a double-fence span byte-exact', () => {
    expect(apply('``x``', 2, 3, 'code')?.text).toBe('x');
  });
});

describe('applyFormat — links', () => {
  it('unlinks, keeping only the link text', () => {
    expect(apply('[a](b)', 1, 5, 'link')?.text).toBe('a');
  });

  it('unlinks a titled link, keeping only the text', () => {
    expect(apply('[a](b "title")', 1, 5, 'link')?.text).toBe('a');
  });

  it('unlinks from an empty cursor sitting inside the link text', () => {
    expect(apply('[abc](url)', 2, 2, 'link')?.text).toBe('abc');
  });
});

describe('applyFormat — wrap/unwrap round-trip identity', () => {
  it('bold round-trips to the original bytes', () => {
    expect(roundTrip('hello world', 0, 5, 'bold')).toBe('hello world');
  });

  it('italic round-trips', () => {
    expect(roundTrip('hello world', 0, 5, 'italic')).toBe('hello world');
  });

  it('strikethrough round-trips', () => {
    expect(roundTrip('hello world', 0, 5, 'strikethrough')).toBe('hello world');
  });

  it('inline code round-trips', () => {
    expect(roundTrip('hello world', 0, 5, 'code')).toBe('hello world');
  });
});

describe('applyFormat — multi-line per-line formatting', () => {
  it('wraps every line of a 3-line selection and maps the outer selection', () => {
    expect(apply('one\ntwo\nthree', 0, 13, 'bold')).toEqual({
      text: '**one**\n**two**\n**three**',
      from: 2,
      to: 23,
    });
  });

  it('unwraps every line when all three are already bold', () => {
    expect(apply('**one**\n**two**\n**three**', 0, 25, 'bold')?.text).toBe('one\ntwo\nthree');
  });

  it('wraps only the unformatted lines, leaving a formatted line byte-untouched', () => {
    expect(apply('**one**\ntwo\nthree', 0, 17, 'bold')).toEqual({
      text: '**one**\n**two**\n**three**',
      from: 0,
      to: 23,
    });
  });

  it('skips a blank line in the middle', () => {
    expect(apply('one\n\ntwo', 0, 8, 'bold')?.text).toBe('**one**\n\n**two**');
  });

  it('skips lines inside a fenced code block, formatting the rest', () => {
    const doc = 'a\n```\ncode\n```\nb';
    expect(apply(doc, 0, doc.length, 'bold')?.text).toBe('**a**\n```\ncode\n```\n**b**');
  });

  it('formats mid-word endpoints on the first and last line', () => {
    // Spec case 6: mid-word on both ends. `world`'s `r` sits at index 8,
    // so selecting through index 9 (assoc-exclusive) takes `wor`.
    expect(apply('hello\nworld', 3, 9, 'bold')?.text).toBe('hel**lo**\n**wor**ld');
  });

  it('trims each segment independently, preserving whitespace outside the markers', () => {
    expect(apply('  one \n two', 0, 11, 'bold')?.text).toBe('  **one** \n **two**');
  });

  it('skips GFM table rows and formats a following plain line', () => {
    // A blank line separates the table from the paragraph: the GFM parser
    // otherwise absorbs a pipe-less trailing line into the table as a row.
    const doc = '| a |\n| - |\n| c |\n\nplain';
    expect(apply(doc, 0, doc.length, 'bold')?.text).toBe('| a |\n| - |\n| c |\n\n**plain**');
  });

  it('returns null when every line is ineligible (all inside a fence)', () => {
    const doc = '```\naaa\nbbb\n```';
    const from = doc.indexOf('aaa');
    const to = doc.indexOf('bbb') + 3;
    expect(applyFormat(makeState(doc, from, to), 'bold')).toBeNull();
  });

  it('refuses a multi-line link outright', () => {
    expect(applyFormat(makeState('one\ntwo', 0, 7), 'link')).toBeNull();
  });

  it('skips a segment whose wrap would break a marker pair, wrapping the rest', () => {
    // Selecting from inside `**b**` (index 4) through the plain second
    // line: segment 1 crosses the StrongEmphasis boundary → skipped;
    // `plain` wraps cleanly.
    expect(apply('a **b** c\nplain', 4, 15, 'bold')?.text).toBe('a **b** c\n**plain**');
  });

  it('applies a multi-line wrap as a single undo step', () => {
    const original = 'one\ntwo\nthree';
    let state = makeState(original, 0, original.length, [history()]);
    state = state.update(applyFormat(state, 'bold')!).state;
    expect(state.doc.toString()).toBe('**one**\n**two**\n**three**');

    let undone = state;
    undo({
      state,
      dispatch: (tr) => {
        undone = tr.state;
      },
    });
    expect(undone.doc.toString()).toBe(original);
  });

  it('round-trips to the original bytes when the same toggle is applied twice', () => {
    expect(roundTrip('one\ntwo\nthree', 0, 13, 'bold')).toBe('one\ntwo\nthree');
  });
});

describe('getActiveFormats', () => {
  it('reports bold inside a bold span', () => {
    expect([...getActiveFormats(makeState('**bold**', 3, 3))]).toEqual(['bold']);
  });

  it('reports both bold and italic inside nested emphasis', () => {
    expect(getActiveFormats(makeState('**a *b* c**', 5, 6))).toEqual(new Set(['bold', 'italic']));
  });

  it('reports nothing in plain text', () => {
    expect(getActiveFormats(makeState('hello', 1, 3)).size).toBe(0);
  });

  it('reports bold for a multi-line selection where every line is bold', () => {
    const doc = '**one**\n**two**\n**three**';
    expect([...getActiveFormats(makeState(doc, 0, doc.length))]).toEqual(['bold']);
  });

  it('reports no bold for a multi-line selection with a plain line', () => {
    const doc = '**one**\ntwo\nthree';
    expect(getActiveFormats(makeState(doc, 0, doc.length)).has('bold')).toBe(false);
  });

  it('never reports link for a multi-line selection', () => {
    const doc = '[a](b)\n[c](d)';
    expect(getActiveFormats(makeState(doc, 0, doc.length)).has('link')).toBe(false);
  });
});

describe('inlineFormattingAllowed', () => {
  it('is false inside fenced code', () => {
    expect(inlineFormattingAllowed(makeState('```\ncode\n```', 5, 8))).toBe(false);
  });

  it('is true for a multi-line selection with an eligible line', () => {
    expect(inlineFormattingAllowed(makeState('a\nb', 0, 3))).toBe(true);
  });

  it('is false for a multi-line selection entirely inside fenced code', () => {
    // `aaa` and `bbb` both live inside the fence, so no line yields an
    // eligible segment and the bar must not show.
    const doc = '```\naaa\nbbb\n```';
    const from = doc.indexOf('aaa');
    const to = doc.indexOf('bbb') + 3;
    expect(inlineFormattingAllowed(makeState(doc, from, to))).toBe(false);
  });

  it('is false for a multi-cursor selection', () => {
    const state = EditorState.create({
      doc: 'abcd',
      selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(2, 3)]),
      extensions: [markdown({ base: markdownLanguage }), EditorState.allowMultipleSelections.of(true)],
    });
    expect(inlineFormattingAllowed(state)).toBe(false);
  });

  it('is true in a plain paragraph', () => {
    expect(inlineFormattingAllowed(makeState('hello', 0, 5))).toBe(true);
  });
});
