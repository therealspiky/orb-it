# Modules

Orb.IT is a core plus optional modules. Each client instance licenses the modules it needs; the rest
can be switched off (instance setting) or taken out of the build entirely (deployment).

## What is core

Organisation > brands > shows, people and roles, show profiles, sources (uploaded or pasted transcripts,
Word/SRT/VTT/TXT files), transcript correction, analysis, briefs, review and approval, audit, export.
Core never imports a module.

## Modules

| Key | Label | What it adds | Needs |
|---|---|---|---|
| `brand_profiles` | Brand profiles | Station-wide profile per brand; briefs are written against it | — |
| `recording_transcription` | Recording transcription | Upload audio/video and transcribe it | `OPENAI_API_KEY` or `DEEPGRAM_API_KEY`, ffmpeg on the worker |
| `episode_map` | Episode map | Content inventory: every conversation in an episode, hooks, moments, which shows could take it | — |
| `youtube` | YouTube import | Paste a YouTube link to fill details; import captions from connected channels | `GOOGLE_CLIENT_ID`/`SECRET` on the worker, `VITE_GOOGLE_CLIENT_ID` on the web (see YOUTUBE.md) |

## Switching a module on or off (per instance)

The `instance_modules` table is the licence. Users can read it but not change it; only the service
role (ctrl.IT) can. In the client's Supabase SQL editor:

```sql
update instance_modules set enabled = false where key = 'youtube';
update instance_modules set enabled = true  where key = 'episode_map';
select key, label, enabled from instance_modules order by key;
```

When a module is off:
- the database refuses its actions (`require_module()` in its RPCs, `enqueue_job` refuses its jobs,
  recording sources cannot be created) — this is the real enforcement;
- the worker fails any of its jobs with a clear message instead of retrying;
- the web app hides its screens and panels; a direct link shows "not part of this instance".

Restart is not needed: the worker re-reads the table every minute, the web app every five minutes or on reload.

## Removing a module from a deployment

To ship a build without a module's code:

- **Worker:** delete its folder under `worker/src/modules/` and its line in `worker/src/modules/index.ts`.
- **Web:** delete its folder under `web/src/modules/` and its line in `web/src/modules/registry.tsx`.
- Leave its row in `instance_modules` disabled (the database objects are harmless when unused).

Automated tests check that core imports no module and modules don't import each other, and every
module has been removed in a scratch copy to confirm the rest still typechecks and builds.

## Adding a module

1. **Database:** a migration that inserts a row into `instance_modules`, creates its tables with RLS,
   and calls `require_module('<key>')` at the top of every security-definer function it adds. If it adds
   a job kind, extend the `enqueue_job` checks.
2. **Worker:** `worker/src/modules/<name>/index.ts` exporting an `OrbitModule` (`key`, `label`, `jobs`,
   optional `missingConfig()`); register it in `worker/src/modules/index.ts`.
3. **Web:** `web/src/modules/<name>/index.tsx` exporting a `WebModule` (`key`, `label`, `routes`, `slots`,
   optional `sourceLink`); register it in `web/src/modules/registry.tsx`. Wrap its pages in `<ModuleGate>`.
   If core needs a new place to show something, add a named slot to `SlotProps` in `web/src/modules/types.ts`
   and render `<Slot name="…">` in the core screen.
4. Add it to the table above.
