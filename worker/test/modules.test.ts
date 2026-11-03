import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { INSTALLED_MODULES } from '../src/modules/index.js';
import { InstanceModules } from '../src/modules/state.js';
import type { OrbitModule } from '../src/modules/types.js';

const cfg = { transcribeProvider: 'openai', openaiKey: 'k' } as Config;
const fakeDb = {} as never;

describe('instance modules', () => {
  it('enables a module only when licensed in the database and installed and configured on the worker', () => {
    const m = new InstanceModules(fakeDb, cfg, INSTALLED_MODULES);
    m.setFlags({ episode_map: true, youtube: false, recording_transcription: true, brand_profiles: true });
    expect(m.isEnabled('episode_map')).toBe(true);
    expect(m.isEnabled('youtube')).toBe(false);          // not licensed
    expect(m.isEnabled('recording_transcription')).toBe(true);
    expect(m.isEnabled('brand_profiles')).toBe(true);    // flag-only module
    expect(m.isEnabled('social_studio')).toBe(false);    // unknown
  });

  it('treats a licensed module that is not installed on this worker as off', () => {
    const m = new InstanceModules(fakeDb, cfg, INSTALLED_MODULES.filter((x) => x.key !== 'youtube'));
    m.setFlags({ youtube: true });
    expect(m.isEnabled('youtube')).toBe(false);
    expect(m.ownerOf('youtube_import')).toBeUndefined();
  });

  it('reports a module whose keys are missing as not ready instead of crashing the worker', () => {
    const m = new InstanceModules(fakeDb, { transcribeProvider: 'openai' } as Config, INSTALLED_MODULES);
    m.setFlags({ recording_transcription: true });
    expect(m.isEnabled('recording_transcription')).toBe(false);
    expect(m.notReady.get('recording_transcription')).toMatch(/OPENAI_API_KEY/);
    expect(m.summary().recording_transcription).toMatch(/off \(OPENAI_API_KEY/);
  });

  it('knows which module owns each job kind', () => {
    const m = new InstanceModules(fakeDb, cfg, INSTALLED_MODULES);
    expect(m.ownerOf('map_episode')?.key).toBe('episode_map');
    expect(m.ownerOf('youtube_connect')?.key).toBe('youtube');
    expect(m.ownerOf('generate_briefs')).toBeUndefined(); // core
  });

  it('every installed module has a unique key and handles distinct job kinds', () => {
    const keys = INSTALLED_MODULES.map((x: OrbitModule) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
    const kinds = INSTALLED_MODULES.flatMap((x) => Object.keys(x.jobs ?? {}));
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe('module boundaries', () => {
  // Removing a module folder must never break core code.
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  }
  const src = join(__dirname, '..', 'src');
  const core = files(src).filter((f) => !f.includes(`${join('src', 'modules')}`) && !f.endsWith(join('src', 'index.ts')));

  it('core code imports only the module contract, never a module', () => {
    for (const f of core) {
      const imports = [...readFileSync(f, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      for (const i of imports.filter((x) => x.includes('modules/'))) {
        expect(i, `${f} imports ${i}`).toMatch(/modules\/(types|state)\.js$/);
      }
    }
  });

  it('modules do not import each other', () => {
    for (const mod of ['episode-map', 'recording', 'youtube']) {
      for (const f of files(join(src, 'modules', mod))) {
        const imports = [...readFileSync(f, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
        for (const other of ['episode-map', 'recording', 'youtube'].filter((x) => x !== mod)) {
          expect(imports.some((i) => i.includes(`/${other}/`)), `${f} imports ${other}`).toBe(false);
        }
      }
    }
  });
});
