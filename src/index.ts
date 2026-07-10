export { AtomicCodeMirrorEditor } from './AtomicCodeMirrorEditor';
export type {
  AtomicCodeMirrorEditorHandle,
  AtomicCodeMirrorEditorProps,
} from './AtomicCodeMirrorEditor';
export { AtomicDiffEditor } from './AtomicDiffEditor';
export type {
  AtomicDiffEditorHandle,
  AtomicDiffEditorProps,
} from './AtomicDiffEditor';

// Individual extension factories. Exposed so consumers can compose a
// stripped-down editor, bisect regressions, or cherry-pick a single
// feature (tables, inline-preview, image blocks) into a different
// editor setup. The default `AtomicCodeMirrorEditor` is still the
// recommended entry point.
export { inlinePreview } from './inline-preview';
export type { InlinePreviewConfig } from './inline-preview';
export { imageBlocks } from './image-blocks';
export { tables } from './table-widget';
export type { TablesConfig } from './table-widget';
export { frontmatterProperties } from './frontmatter-properties';
export { wikiLinks } from './wiki-links';
export type {
  WikiLinkResolvedTarget,
  WikiLinkStatus,
  WikiLinkSuggestion,
  WikiLinksConfig,
} from './wiki-links';
export { defaultSlashCommands, slashCommandSource, slashCommands } from './slash-commands';
export type { SlashCommandItem, SlashCommandsConfig } from './slash-commands';
export { atomicEditorTheme, atomicMarkdownSyntax } from './atomic-theme';
export { autoCloseCodeFence, extendEmphasisPair } from './edit-helpers';
export { selectionToolbar } from './selection-toolbar';
export type { SelectionToolbarConfig } from './selection-toolbar';
export {
  applyFormat,
  getActiveFormats,
  inlineFormattingAllowed,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleLink,
  toggleStrikethrough,
} from './formatting-commands';
export type { InlineFormat } from './formatting-commands';
