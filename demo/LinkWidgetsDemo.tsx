import { WidgetType } from '@codemirror/view';
import { AtomicCodeMirrorEditor, linkWidgets, type LinkWidgetSpec } from '@atomic-editor/editor';

// Focused harness for the `linkWidgets()` seam (`?mode=link-widgets`),
// driven by the Playwright probes in scripts/test-editor.mjs. A link whose
// url starts with `dec://` draws as a chip; clicks are counted on window so
// the probe can tell the chip's own handler from the engine link opener.

interface ProbeCounters {
  chipClicks: number;
  linkOpens: number;
}

declare global {
  interface Window {
    __linkWidgetProbe?: ProbeCounters;
  }
}

const counters: ProbeCounters = { chipClicks: 0, linkOpens: 0 };
window.__linkWidgetProbe = counters;

class DemoChip extends WidgetType {
  constructor(
    readonly url: string,
    readonly text: string,
  ) {
    super();
  }

  override eq(other: DemoChip): boolean {
    return other.url === this.url && other.text === this.text;
  }

  override toDOM(): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'demo-link-chip';
    chip.dataset.url = this.url;
    chip.textContent = `◆ ${this.text}`;
    chip.style.cssText =
      'border: 1px solid currentColor; border-radius: 6px; padding: 0 6px; cursor: pointer;';
    // No mousedown handling: `ignoreEvent` defaults to true, so CM6 leaves
    // the press alone and the click reaches this listener.
    chip.addEventListener('click', () => {
      counters.chipClicks += 1;
    });
    return chip;
  }
}

const decisionChips: LinkWidgetSpec = {
  match: ({ url, text }) => (url.startsWith('dec://') ? new DemoChip(url, text) : null),
};

const EXTENSIONS = [linkWidgets(decisionChips)];

const MARKDOWN = `# Link widgets

Decided: [Ship on Friday](dec://42) today.

A plain link stays a link: [example](https://example.com).
`;

export function LinkWidgetsDemo() {
  return (
    <div style={{ maxWidth: 760, margin: '40px auto', height: 400 }}>
      <AtomicCodeMirrorEditor
        markdownSource={MARKDOWN}
        extensions={EXTENSIONS}
        onLinkClick={() => {
          counters.linkOpens += 1;
        }}
      />
    </div>
  );
}
