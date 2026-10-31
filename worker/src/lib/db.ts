import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '../config.js';
import type { Segment, SourceRow } from '../types.js';
import { PermanentError } from '../types.js';

export type Db = SupabaseClient;

export function makeDb(cfg: Config): Db {
  return createClient(cfg.supabaseUrl, cfg.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null) throw new Error(`${what}: no data`);
  return res.data;
}

export async function getSource(db: Db, id: string): Promise<SourceRow> {
  const res = await db.from('sources').select('*').eq('id', id).maybeSingle();
  if (res.error) throw new Error(`load source: ${res.error.message}`);
  if (!res.data) throw new PermanentError('Source not found');
  return res.data as SourceRow;
}

export async function getSegments(db: Db, sourceId: string): Promise<Segment[]> {
  const out: Segment[] = [];
  // Page through large transcripts.
  for (let from = 0; ; from += 1000) {
    const res = await db.from('transcript_segments')
      .select('idx,start_ms,end_ms,speaker,text,confidence,is_uncertain')
      .eq('source_id', sourceId).order('idx').range(from, from + 999);
    const rows = must(res, 'load segments') as Segment[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export async function setSourceStatus(db: Db, id: string, status: string, message: string | null, extra: Record<string, unknown> = {}) {
  const res = await db.from('sources').update({ status, status_message: message, ...extra }).eq('id', id);
  if (res.error) throw new Error(`update source: ${res.error.message}`);
}

export async function audit(db: Db, orgId: string, action: string, entity: string, entityId: string | null, detail: Record<string, unknown> = {}) {
  await db.from('audit_events').insert({ org_id: orgId, actor: null, action, entity, entity_id: entityId, detail });
}

export async function jobProgress(db: Db, jobId: string, progress: number, message: string) {
  await db.from('jobs').update({ progress: Math.max(0, Math.min(100, Math.round(progress))), message, locked_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', jobId);
}
