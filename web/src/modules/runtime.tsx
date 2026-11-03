import { useQuery } from '@tanstack/react-query';
import { Fragment } from 'react';
import { useOrg } from '../lib/org';
import { supabase } from '../lib/supabase';
import { INSTALLED_MODULES } from './registry';
import type { SlotName, SlotProps, SourceLinkHandler, WebModule } from './types';

/** Modules with no web code of their own; core screens check their flag directly. */
const FLAG_ONLY = new Set(['recording_transcription']);

export interface ModuleRow { key: string; label: string; enabled: boolean }

/** Which modules this instance has licensed (instance_modules) and this build includes. */
export function useModules() {
  const { userId } = useOrg();
  const q = useQuery({
    queryKey: ['instance-modules', userId],
    enabled: !!userId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('instance_modules').select('key,label,enabled').order('key');
      // Databases from before modules existed: everything installed counts as enabled.
      if (error) return INSTALLED_MODULES.map((m) => ({ key: m.key, label: m.label, enabled: true })).concat([{ key: 'recording_transcription', label: 'Recording transcription', enabled: true }]);
      return data as ModuleRow[];
    },
  });
  const rows = q.data ?? [];
  const isEnabled = (key: string) => {
    const row = rows.find((r) => r.key === key);
    if (!row?.enabled) return false;
    return FLAG_ONLY.has(key) || INSTALLED_MODULES.some((m) => m.key === key);
  };
  const active: WebModule[] = INSTALLED_MODULES.filter((m) => isEnabled(m.key));
  return { loading: q.isLoading, rows, isEnabled, active };
}

/** Renders every enabled module's component for a named place in a core screen. */
export function Slot<N extends SlotName>({ name, ...props }: { name: N } & SlotProps[N]) {
  const { active } = useModules();
  return (
    <>
      {active.map((m) => {
        const C = m.slots?.[name] as React.ComponentType<SlotProps[N]> | undefined;
        return C ? <Fragment key={m.key}><C {...(props as unknown as SlotProps[N])} /></Fragment> : null;
      })}
    </>
  );
}

/** First enabled module that recognises a pasted link. */
export function useSourceLink(url: string): { handler: SourceLinkHandler; info: NonNullable<ReturnType<SourceLinkHandler['recognise']>> } | null {
  const { active } = useModules();
  for (const m of active) {
    const info = url ? m.sourceLink?.recognise(url) : null;
    if (m.sourceLink && info) return { handler: m.sourceLink, info };
  }
  return null;
}

/** Wraps a module's page: shows a notice instead when the module is not licensed on this instance. */
export function ModuleGate({ moduleKey, children }: { moduleKey: string; children: React.ReactNode }) {
  const { loading, isEnabled, rows } = useModules();
  if (loading) return null;
  if (isEnabled(moduleKey)) return <>{children}</>;
  const label = rows.find((r) => r.key === moduleKey)?.label ?? 'This module';
  return (
    <div className="max-w-[560px] py-10">
      <h1 className="text-2xl font-semibold">{label} is not part of this instance</h1>
      <p className="mt-2 text-ink-soft">Contact ctrl.IT to add it to your Orb.IT subscription.</p>
    </div>
  );
}
