import { useMemo } from 'react';
import { SettingsWorkspace } from './SettingsWorkspace';
import type { SettingsSection } from './model';

/**
 * The options document is the durable settings surface.  Popup routes open
 * this page in a normal tab, so a long model download or voice-cache repair
 * does not disappear when the browser closes the action popup.
 */
export function OptionsWorkspace() {
  const location = useMemo(() => {
    if (typeof window === 'undefined') return { section: 'reader' as SettingsSection, provider: '' };
    const params = new URLSearchParams(window.location.search);
    const value = params.get('section') || 'reader';
    const aliases: Record<string, SettingsSection> = { engine: 'voice', voices: 'voice', roles: 'voice', providers: 'voice', data: 'advanced' };
    const section = aliases[value] || (['reader', 'ai', 'voice', 'appearance', 'shortcuts', 'advanced'].includes(value) ? value as SettingsSection : 'reader');
    const provider = params.get('provider') || '';
    return { section, provider, view: params.get('view') || '' };
  }, []);
  return <SettingsWorkspace defaultSection={location.section} initialProviderId={location.provider} initialStudioOpen={location.view === 'studio'} />;
}
