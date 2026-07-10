import { getChunks } from '@codemirror/merge';
import { Facet, type EditorState, type Extension } from '@codemirror/state';

const atomicDiffViewFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

/**
 * Marks a CodeMirror state as an Atomic unified-diff surface. Built-in
 * renderers use this signal to keep unchanged content rich while exposing
 * the source for every changed range.
 */
export const atomicDiffView: Extension = atomicDiffViewFacet.of(true);

/**
 * Returns whether a range intersects an actual character-level change in the
 * newer document. Inline-preview syntax uses this narrower predicate so an
 * unchanged heading marker can stay rendered when only its heading text
 * changed, while a changed marker remains visible as evidence.
 */
export function intersectsAtomicDiffChange(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  if (!state.facet(atomicDiffViewFacet)) return false;

  const result = getChunks(state);
  if (!result) return false;

  for (const chunk of result.chunks) {
    if (chunk.fromB > to) break;
    if (chunk.endB < from) continue;
    for (const change of chunk.changes) {
      const changeFrom = chunk.fromB + change.fromB;
      const changeTo = chunk.fromB + change.toB;
      if (changeFrom === changeTo) {
        if (changeFrom >= from && changeFrom <= to) return true;
        continue;
      }
      if (changeFrom < to && changeTo > from) return true;
    }
  }

  return false;
}

/** Returns whether the current state is an Atomic unified-diff surface. */
export function isAtomicDiffView(state: EditorState): boolean {
  return state.facet(atomicDiffViewFacet);
}
