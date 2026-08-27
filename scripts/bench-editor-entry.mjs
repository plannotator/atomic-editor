#!/usr/bin/env node

/**
 * Editor-entry benchmark for the mount-time parse window.
 *
 * Builds the same extension set `AtomicCodeMirrorEditor` mounts, creates
 * the state and the view for generated 50 KB and 280 KB documents under
 * happy-dom, and reports:
 *
 *   - how far the syntax tree reaches right after mount (must stay inside
 *     the mount window plus one block of slack; this is the budget
 *     assertion, and the script exits 1 when it is violated)
 *   - wall time for EditorState.create plus EditorView construction
 *   - how long the idle loop needs to cover the whole document and how
 *     many tree-growth rebuilds it dispatched on the way
 *
 * Runs the TypeScript sources through vite-node (shipped with vitest):
 *
 *   npm run bench:entry
 *   BENCH_RUNS=9 npm run bench:entry
 *
 * Timings are informational and machine-specific. The parse-reach
 * assertion is the regression guard: a whole-document parse creeping
 * back into `StateField.create` or the inline-preview constructor shows
 * up as reach === document length on the 280 KB document.
 */

import { performance } from 'node:perf_hooks';
import { Window } from 'happy-dom';

import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { frontmatter } from '../src/frontmatter';
import { frontmatterProperties } from '../src/frontmatter-properties';
import { imageBlocks } from '../src/image-blocks';
import { inlinePreview } from '../src/inline-preview';
import { tables } from '../src/table-widget';
import { MOUNT_PARSE_WINDOW, treeGrowthEffect } from '../src/tree-progress';

const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const SLACK = 8192; // Lezer finishes the block it is in when the window ends.
const CASES = [
  { label: 'tiny', bytes: 512 },
  { label: 'heavy', bytes: 50 * 1024 },
  { label: 'xheavy', bytes: 280 * 1024 },
];

const dom = new Window({ url: 'http://localhost/' });
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Range: dom.Range,
  Selection: dom.Selection,
  DOMParser: dom.DOMParser,
};
// Node 24 defines some of these (navigator) as getter-only globals.
for (const [name, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function fixture(targetBytes) {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const words =
    'plan review annotate editor markdown codemirror decoration viewport measure layout style token parser lezer tree incremental budget frame paint commit react state effect'.split(
      ' ',
    );
  const sentence = (n) => Array.from({ length: n }, () => words[Math.floor(rand() * words.length)]).join(' ');
  const para = () =>
    `${sentence(18)} **${sentence(2)}** ${sentence(8)} \`${words[Math.floor(rand() * words.length)]}\` ${sentence(6)} [${sentence(2)}](https://example.com/${Math.floor(rand() * 1000)}).`;
  const parts = ['---\ntitle: Bench fixture\ntags: [perf, editor]\n---\n\n# Bench fixture\n\n'];
  let bytes = parts[0].length;
  let n = 0;
  while (bytes < targetBytes) {
    n += 1;
    const section =
      `## Section ${n}\n\n${para()}\n\n### Detail\n\n${para()}\n\n` +
      `- ${sentence(4)}\n- ${sentence(5)}\n  - nested ${sentence(3)}\n- [ ] ${sentence(4)}\n- [x] ${sentence(3)}\n\n` +
      `1. ${sentence(3)}\n2. ${sentence(3)}\n\n> ${sentence(12)}\n\n` +
      '```ts\nexport function f(x: number): number {\n  return x * 2;\n}\n```\n\n' +
      `| Name | Value | Note |\n| --- | --- | --- |\n| a${n} | ${n} | ${sentence(2)} |\n| b${n} | ${n * 2} | ${sentence(2)} |\n| c${n} | ${n * 3} | ${sentence(2)} |\n\n` +
      `![figure ${n}](https://example.com/${n}.png)\n\n---\n\n`;
    parts.push(section);
    bytes += section.length;
  }
  return { text: parts.join(''), tables: n, images: n };
}

function extensions(counter) {
  return [
    markdown({ base: markdownLanguage, extensions: [frontmatter] }),
    tables(),
    frontmatterProperties(),
    imageBlocks(),
    inlinePreview(),
    EditorState.transactionExtender.of((tr) => {
      if (tr.effects.some((e) => e.is(treeGrowthEffect))) counter.growth += 1;
      return null;
    }),
  ];
}

function reach(state) {
  return (ensureSyntaxTree(state, 1, 0) ?? syntaxTree(state)).length;
}

// Table widgets are block replacements whose range starts on a pipe;
// the frontmatter properties card is the other block replacement and
// starts on `---`.
function countTableWidgets(view) {
  let n = 0;
  const doc = view.state.doc;
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === 'function' ? source(view) : source;
    const iter = set.iter();
    while (iter.value) {
      const spec = iter.value.spec;
      if (spec.block && spec.widget && iter.from < iter.to && doc.sliceString(iter.from, iter.from + 1) === '|') {
        n += 1;
      }
      iter.next();
    }
  }
  return n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

async function runOnce(text, tableCount) {
  const counter = { growth: 0 };
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const t0 = performance.now();
  const state = EditorState.create({ doc: text, extensions: extensions(counter) });
  const t1 = performance.now();
  const view = new EditorView({ state, parent });
  const t2 = performance.now();
  const mountReach = reach(view.state);
  const mountTables = countTableWidgets(view);
  const deadline = Date.now() + 30_000;
  while (countTableWidgets(view) < tableCount) {
    if (Date.now() > deadline) throw new Error('tree never covered the document');
    await sleep(5);
  }
  const t3 = performance.now();
  view.destroy();
  parent.remove();
  return {
    stateMs: t1 - t0,
    viewMs: t2 - t1,
    mountReach,
    mountTables,
    coverMs: t3 - t2,
    growth: counter.growth,
  };
}

let failed = false;
const rows = [];
for (const c of CASES) {
  const { text, tables: tableCount } = fixture(c.bytes);
  const samples = [];
  for (let i = 0; i < RUNS; i++) samples.push(await runOnce(text, tableCount));
  const row = {
    doc: c.label,
    bytes: text.length,
    tables: tableCount,
    'state ms': median(samples.map((s) => s.stateMs)).toFixed(1),
    'view ms': median(samples.map((s) => s.viewMs)).toFixed(1),
    'mount reach': median(samples.map((s) => s.mountReach)),
    'tables at mount': median(samples.map((s) => s.mountTables)),
    'cover ms': median(samples.map((s) => s.coverMs)).toFixed(1),
    'growth rebuilds': median(samples.map((s) => s.growth)),
  };
  rows.push(row);
  const limit = Math.min(text.length, MOUNT_PARSE_WINDOW + SLACK);
  for (const s of samples) {
    if (s.mountReach > limit) {
      failed = true;
      console.error(
        `FAIL ${c.label}: mount-time parse reached ${s.mountReach} chars, budget is ${limit} (window ${MOUNT_PARSE_WINDOW} + slack ${SLACK})`,
      );
    }
    if (s.mountTables === 0 && tableCount > 0) {
      failed = true;
      console.error(`FAIL ${c.label}: no table widget inside the mount window`);
    }
  }
}

console.table(rows);
console.log(`mount window ${MOUNT_PARSE_WINDOW} chars, ${RUNS} runs per document, medians shown`);
if (failed) {
  console.error('budget assertion failed');
  process.exit(1);
}
console.log('budget assertion passed');
