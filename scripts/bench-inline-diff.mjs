#!/usr/bin/env node

import { performance } from 'node:perf_hooks';

import { Chunk } from '@codemirror/merge';
import { Text } from '@codemirror/state';

const DIFF_CONFIG = { scanLimit: 500_000, timeout: 1_000 };
const CASES = [10_000, 50_000];

for (const lineCount of CASES) {
  const originalLines = Array.from(
    { length: lineCount },
    (_, index) => `Section ${index}: stable review context for document fidelity and navigation.`,
  );
  const modifiedLines = [...originalLines];
  const expectedChunks = Math.ceil(lineCount / 1_000);
  for (let index = 500; index < lineCount; index += 1_000) {
    modifiedLines[index] = modifiedLines[index].replace('stable', 'updated');
  }

  const original = Text.of(originalLines);
  const modified = Text.of(modifiedLines);
  const timings = [];
  let chunks = [];

  for (let sample = 0; sample < 6; sample++) {
    const start = performance.now();
    chunks = Chunk.build(original, modified, DIFF_CONFIG);
    const elapsed = performance.now() - start;
    if (sample > 0) timings.push(elapsed);
  }

  if (chunks.length !== expectedChunks) {
    throw new Error(
      `${lineCount.toLocaleString()} lines produced ${chunks.length} chunks; expected ${expectedChunks}.`,
    );
  }
  if (!chunks.every((chunk) => chunk.precise)) {
    throw new Error(`${lineCount.toLocaleString()} lines fell back to an imprecise diff.`);
  }

  const sorted = [...timings].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  const bytes = Buffer.byteLength(modifiedLines.join('\n'), 'utf8');
  console.log(JSON.stringify({
    bytes,
    chunks: chunks.length,
    lineCount,
    medianMs: Number(median.toFixed(2)),
    precise: true,
  }));
}
