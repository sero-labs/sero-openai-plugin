import { useMemo, type ReactNode } from 'react';
import { useAppState } from '@sero-ai/app-runtime';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@sero-ai/ui';
import { createDefaultConfig, type EnhancementSettings, type OpenAIModelEnhancementConfig, type Verbosity } from '../shared/config';
import { parseConfig, setDefault, setEnabled } from '../shared/state';
import './styles.css';

type BooleanSetting = {
  key: Exclude<keyof EnhancementSettings, 'verbosity'>;
  name: string;
  description: string;
  section: 'Behavior' | 'Tools' | 'Response';
};

const BOOLEAN_SETTINGS: BooleanSetting[] = [
  { key: 'promptAdaptation', name: 'Prompt adaptation', description: 'Add OpenAI guidance without replacing Sero context.', section: 'Behavior' },
  { key: 'webTools', name: 'Web tools', description: 'Enable web search and page reading.', section: 'Tools' },
  { key: 'imageGeneration', name: 'Image generation and edit', description: 'Create files with OpenAI image APIs.', section: 'Tools' },
  { key: 'imageFallback', name: 'Image fallback', description: 'Describe images when native image input is not available.', section: 'Tools' },
  { key: 'fastMode', name: 'Fast mode', description: 'Use priority processing for API-key and OAuth requests.', section: 'Response' },
];

export function OpenAIModelSettings() {
  const [savedValue, updateSaved, ready] = useAppState<unknown>(createDefaultConfig());
  const current = useMemo(() => {
    if (!ready) return undefined;
    try { return parseConfig(savedValue); } catch { return undefined; }
  }, [ready, savedValue]);

  const edit = (updater: (config: OpenAIModelEnhancementConfig) => OpenAIModelEnhancementConfig) => {
    updateSaved((previous) => updater(parseConfig(previous)));
  };

  if (!ready) {
    return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">Loading OpenAI settings…</div>;
  }
  if (!current) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-muted-foreground">OpenAI settings could not be read.</p>
        <Button type="button" size="sm" onClick={() => updateSaved(() => createDefaultConfig())}>Reset settings</Button>
      </div>
    );
  }

  const change = <K extends keyof EnhancementSettings>(key: K, value: EnhancementSettings[K]) => edit((config) => setDefault(config, key, value));
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-brand-primary-border bg-brand-primary-faint px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium">Enable enhancements</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Applies to all compatible OpenAI models.</p>
          </div>
          <Switch checked={current.enabled} aria-label="Enable OpenAI enhancements" onCheckedChange={(enabled) => edit((config) => setEnabled(config, enabled))} />
        </div>

        {(['Behavior', 'Tools', 'Response'] as const).map((section) => (
          <section key={section} className="mt-4">
            <h3 className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">{section}</h3>
            <div className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
              {BOOLEAN_SETTINGS.filter((item) => item.section === section).map((item) => (
                <SettingRow key={item.key} name={item.name} description={item.description}>
                  <Switch checked={current.defaults[item.key]} aria-label={item.name} onCheckedChange={(value) => change(item.key, value)} />
                </SettingRow>
              ))}
              {section === 'Response' && (
                <SettingRow name="Verbosity" description="Set response detail, or Off to omit the plugin value.">
                  <Select value={current.defaults.verbosity} onValueChange={(value) => change('verbosity', value as Verbosity)}>
                    <SelectTrigger size="sm" aria-label="Verbosity" className="min-w-24 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(['off', 'low', 'medium', 'high'] as const).map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </SettingRow>
              )}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

function SettingRow({ name, description, children }: { name: string; description: string; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="min-w-0">
        <span className="text-xs font-medium">{name}</span>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export default OpenAIModelSettings;
