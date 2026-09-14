// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import { createDefaultConfig, type OpenAIModelEnhancementConfig } from '../../shared/config';

const runtime = vi.hoisted(() => ({
  state: undefined as OpenAIModelEnhancementConfig | undefined,
  listeners: new Set<(value: OpenAIModelEnhancementConfig) => void>(),
}));

vi.mock('@sero-ai/app-runtime', async () => {
  const React = await import('react');
  return {
    useAppState: (initial: OpenAIModelEnhancementConfig) => {
      const [value, setValue] = React.useState(runtime.state ?? initial);
      React.useEffect(() => { runtime.listeners.add(setValue); return () => { runtime.listeners.delete(setValue); }; }, []);
      const update = (updater: (value: OpenAIModelEnhancementConfig) => OpenAIModelEnhancementConfig) => {
        const next = updater(runtime.state ?? initial);
        runtime.state = next;
        for (const listener of runtime.listeners) listener(next);
      };
      return [value, update, true];
    },
  };
});
import OpenAIModelSettings from '../OpenAIModelSettings';

let roots: Root[] = [];
function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); roots.push(root); act(() => root.render(node)); return container;
}
function button(container: HTMLElement, name: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === name || entry.getAttribute('aria-label') === name);
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Missing button ${name}`); return result;
}
beforeEach(() => { runtime.state = createDefaultConfig(); runtime.listeners.clear(); });
afterEach(() => { for (const root of roots) act(() => root.unmount()); roots = []; document.body.replaceChildren(); });

describe('OpenAIModelSettings', () => {
  it('shows one global switch and no model list or per-model copy', () => {
    const view = render(<OpenAIModelSettings />);
    expect(button(view, 'Enable OpenAI enhancements').getAttribute('aria-checked')).toBe('false');
    expect(view.textContent).toContain('Applies to all compatible OpenAI models.');
    expect(view.textContent).not.toContain('Compatible models');
    expect(view.textContent).not.toContain('Each compatible model requires explicit opt-in');
    expect(view.textContent).not.toContain('Base values for each model');
    expect(view.textContent).not.toContain('Save');
    expect(view.textContent).not.toContain('Reset');
  });

  it('auto-saves changes and refreshes every mounted view', () => {
    const first = render(<OpenAIModelSettings />); const second = render(<OpenAIModelSettings />);
    act(() => button(first, 'Enable OpenAI enhancements').click());
    act(() => button(first, 'Web tools').click());
    expect(runtime.state).toMatchObject({ version: 2, enabled: true, defaults: { webTools: true } });
    expect(button(second, 'Enable OpenAI enhancements').getAttribute('aria-checked')).toBe('true');
    expect(button(second, 'Web tools').getAttribute('aria-checked')).toBe('true');
  });

  it('keeps defaults editable while globally disabled', () => {
    const view = render(<OpenAIModelSettings />);
    expect(button(view, 'Web tools').disabled).toBe(false);
    const verbosity = view.querySelector('button[role="combobox"][aria-label="Verbosity"]');
    expect(verbosity).not.toBeNull();
    expect((verbosity as HTMLButtonElement).disabled).toBe(false);
    expect(view.textContent).toContain('Use priority processing for API-key and OAuth requests.');
  });
  it('offers to reset malformed saved state', () => {
    runtime.state = { version: 2, enabled: false } as OpenAIModelEnhancementConfig;
    const view = render(<OpenAIModelSettings />);
    expect(view.textContent).toContain('OpenAI settings could not be read.');
    act(() => button(view, 'Reset settings').click());
    expect(runtime.state).toEqual(createDefaultConfig());
  });

  it('has no automatic accessibility violations at desktop and compact widths', async () => {
    for (const width of [900, 640]) {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      const view = render(<OpenAIModelSettings />);
      expect((await axe.run(view)).violations).toEqual([]);
      view.remove();
    }
  });

});
