import type { Config } from '../config.js';
import type { Db } from '../lib/db.js';
import type { ModuleState, OrbitModule } from './types.js';

/** Modules whose behaviour lives in core code paths and the web app, switched by the database flag. */
export const FLAG_ONLY_MODULES = new Set(['brand_profiles']);

/**
 * Combines what is installed on this worker with what the instance has licensed
 * (instance_modules). Refreshed periodically so the vendor can switch modules
 * without restarting the worker.
 */
export class InstanceModules implements ModuleState {
  private flags = new Map<string, boolean>();
  private loadedAt = 0;
  readonly notReady = new Map<string, string>();

  constructor(private db: Db, private cfg: Config, private installedList: OrbitModule[], private ttlMs = 60_000) {
    for (const m of installedList) {
      const why = m.readiness?.(cfg) ?? null;
      if (why) this.notReady.set(m.key, why);
    }
  }

  /** Test hook / initial load. */
  setFlags(flags: Record<string, boolean>) {
    this.flags = new Map(Object.entries(flags));
    this.loadedAt = Date.now();
  }

  async refresh(force = false) {
    if (!force && Date.now() - this.loadedAt < this.ttlMs) return;
    const { data, error } = await this.db.from('instance_modules').select('key,enabled');
    if (error) {
      // Older databases without the modules table: treat every installed module as licensed.
      if (/instance_modules/.test(error.message)) { this.setFlags(Object.fromEntries(this.installedList.map((m) => [m.key, true]))); return; }
      throw new Error(`load modules: ${error.message}`);
    }
    this.setFlags(Object.fromEntries((data ?? []).map((r: { key: string; enabled: boolean }) => [r.key, r.enabled])));
  }

  installed(key: string) {
    return this.installedList.find((m) => m.key === key);
  }

  isEnabled(key: string): boolean {
    if (!this.flags.get(key)) return false;
    // Flag-only modules have no worker code and are enabled by the database alone.
    if (FLAG_ONLY_MODULES.has(key)) return true;
    return !!this.installed(key) && !this.notReady.has(key);
  }

  /** Which module owns a job kind, if any (core jobs return undefined). */
  ownerOf(kind: string): OrbitModule | undefined {
    return this.installedList.find((m) => m.jobs && kind in m.jobs);
  }

  summary() {
    return Object.fromEntries([...this.flags.keys()].map((k) => [k, this.isEnabled(k) ? 'on' : (this.notReady.get(k) ? `off (${this.notReady.get(k)})` : 'off')]));
  }
}
