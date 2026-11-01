import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Pencil, Play } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { BriefBadge, Empty, ErrorNote, PageHeader, Progress, SourceBadge, Spinner } from '../components/ui';
import { safeName, sha256 } from '../lib/checksum';
import { ago, bytes, clock, LANGUAGE_LABEL } from '../lib/format';
import { useOrg } from '../lib/org';
import { check, supabase } from '../lib/supabase';
import { WORK_ROLES, type Brief, type EpisodeMapRow, type Job, type Segment, type Source } from '../lib/types';
import { EpisodeMap } from '../components/EpisodeMap';

interface Analysis {
  summary: string;
  themes: { theme: string; note: string; segment_start: number; segment_end: number }[];
  claims: { claim: string; speaker: string | null; claim_type: string; needs_verification: boolean; segment_start: number; segment_end: number }[];
  questions_raised: string[];
  sensitivities: { issue: string; segment_start: number; segment_end: number }[];
}

export function SourceDetailPage() {
  const { sourceId } = useParams({ from: '/app/sources/$sourceId' });
  const { org, brandName, showName, can } = useOrg();
  const mediaRef = useRef<HTMLVideoElement>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [onlyUncertain, setOnlyUncertain] = useState(false);

  const source = useQuery({
    queryKey: ['source', sourceId],
    refetchInterval: (q) => (['queued', 'processing'].includes((q.state.data as Source | undefined)?.status ?? '') ? 3000 : false),
    queryFn: async () => check(await supabase.from('sources').select('*').eq('id', sourceId).single()) as Source,
  });
  const s = source.data;
  const segments = useQuery({
    queryKey: ['segments', sourceId, s?.status],
    enabled: !!s && ['ready', 'needs_attention'].includes(s.status),
    queryFn: async () => check(await supabase.from('transcript_segments').select('*').eq('source_id', sourceId).order('idx').limit(5000)) as Segment[],
  });
  const jobs = useQuery({
    queryKey: ['source-jobs', sourceId],
    refetchInterval: (q) => ((q.state.data as Job[] | undefined)?.some((j) => ['queued', 'running'].includes(j.status)) ? 3000 : false),
    queryFn: async () => check(await supabase.from('jobs').select('*').eq('org_id', org!.id).eq('payload->>source_id', sourceId)
      .order('created_at', { ascending: false }).limit(10)) as Job[],
  });
  const analysis = useQuery({
    queryKey: ['analysis', sourceId, jobs.data?.[0]?.status],
    enabled: !!s,
    queryFn: async () => {
      const r = await supabase.from('source_analyses').select('result,model,created_at').eq('source_id', sourceId).order('created_at', { ascending: false }).limit(1).maybeSingle();
      return (r.data?.result ?? null) as Analysis | null;
    },
  });
  const briefs = useQuery({
    queryKey: ['source-briefs', sourceId, jobs.data?.[0]?.status],
    queryFn: async () => check(await supabase.from('briefs').select('*').eq('origin_source_id', sourceId).order('created_at', { ascending: false })) as Brief[],
  });
  const map = useQuery({
    queryKey: ['episode-map', sourceId, jobs.data?.find((j) => j.kind === 'map_episode')?.status],
    enabled: !!s,
    queryFn: async () => (await supabase.from('episode_maps').select('*').eq('source_id', sourceId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()).data as EpisodeMapRow | null,
  });
  const mediaUrl = useQuery({
    queryKey: ['media-url', s?.storage_path],
    enabled: !!s?.storage_path && s.kind === 'recording',
    staleTime: 50 * 60_000,
    queryFn: async () => check(await supabase.storage.from('media').createSignedUrl(s!.storage_path!, 3600))!.signedUrl,
  });

  const canEdit = s ? can(WORK_ROLES, s.brand_id, s.show_id) : false;
  const visible = useMemo(() => (segments.data ?? []).filter((x) => !onlyUncertain || x.is_uncertain), [segments.data, onlyUncertain]);
  const uncertainCount = (segments.data ?? []).filter((x) => x.is_uncertain).length;
  const activeJob = jobs.data?.find((j) => ['queued', 'running'].includes(j.status) && j.kind !== 'map_episode');
  const mappingJob = jobs.data?.find((j) => j.kind === 'map_episode' && ['queued', 'running'].includes(j.status))
    ?? (jobs.data?.find((j) => j.kind === 'analyse' && ['queued', 'running'].includes(j.status)) && !map.data ? { progress: 5, message: 'Reading the episode' } as Job : undefined);
  const failedJob = jobs.data?.[0]?.status === 'failed' ? jobs.data[0] : null;

  function playAt(ms: number) {
    const seg = (segments.data ?? []).find((x) => x.start_ms != null && x.start_ms <= ms && (x.end_ms ?? Infinity) > ms);
    if (seg) setActiveIdx(seg.idx);
    if (mediaRef.current) {
      mediaRef.current.currentTime = ms / 1000;
      void mediaRef.current.play();
      mediaRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function seek(seg: Segment) {
    setActiveIdx(seg.idx);
    if (mediaRef.current && seg.start_ms != null) {
      mediaRef.current.currentTime = seg.start_ms / 1000;
      void mediaRef.current.play();
    }
  }

  if (source.isLoading || !s) return source.error ? <ErrorNote error={source.error} /> : <Spinner />;

  return (
    <>
      <PageHeader title={s.title}
        lede={<>{brandName(s.brand_id)}{s.show_id ? `, ${showName(s.show_id)}` : ''}{s.programme_name ? `. Attributed to ${s.programme_name}` : ''}.</>}
        actions={<SourceBadge status={s.status} />} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          {activeJob && (
            <div className="panel p-4">
              <p className="text-sm font-semibold mb-2">{activeJob.message ?? (activeJob.status === 'queued' ? 'Waiting for a worker' : 'Working')}</p>
              <Progress value={activeJob.progress} />
            </div>
          )}
          {failedJob && <ErrorNote error={`${failedJob.kind === 'transcribe' ? 'Processing' : 'Job'} failed: ${failedJob.error ?? failedJob.message}`} />}
          {!s.storage_path && canEdit && <RetryUpload source={s} onDone={() => { void source.refetch(); void jobs.refetch(); }} />}

          {s.kind === 'recording' && mediaUrl.data && (
            <div className="panel p-3">
              {(s.mime_type ?? '').startsWith('video')
                ? <video ref={mediaRef} src={mediaUrl.data} controls className="w-full max-h-[320px] bg-black rounded-md" />
                : <audio ref={mediaRef as unknown as React.RefObject<HTMLAudioElement>} src={mediaUrl.data} controls className="w-full" />}
            </div>
          )}

          {(segments.data || map.data) && (
            <EpisodeMap source={s} map={map.data ?? null} briefs={briefs.data ?? []}
              mapping={mappingJob ? { progress: mappingJob.progress, message: mappingJob.message } : null}
              onPlay={playAt} onQueued={() => { void jobs.refetch(); void briefs.refetch(); }} />
          )}

          {segments.data && (
            <details className="group" open={!map.data}>
              <summary className="flex flex-wrap items-baseline justify-between gap-3 mb-2 cursor-pointer list-none">
                <h2 className="text-lg font-semibold"><span className="inline-block w-4 text-ink-faint group-open:rotate-90 transition-transform">›</span> Transcript</h2>
                <div className="flex items-center gap-4 text-sm">
                  {uncertainCount > 0 && (
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" checked={onlyUncertain} onChange={(e) => setOnlyUncertain(e.target.checked)} />
                      Only the {uncertainCount} uncertain passage{uncertainCount === 1 ? '' : 's'}
                    </label>
                  )}
                  <span className="text-ink-faint">{segments.data.length} passages{s.timestamps_genuine ? '' : ', no timestamps'}</span>
                </div>
              </summary>
              {s.twi_beta && <p className="text-sm bg-signal-soft rounded-md px-3 py-2 mb-3">Twi beta: every passage needs checking by a qualified Twi speaker before it is used.</p>}
              <ol className="panel divide-y divide-line">
                {visible.map((seg) => (
                  <SegmentRow key={seg.id} seg={seg} timed={s.timestamps_genuine} active={activeIdx === seg.idx}
                    canEdit={canEdit} onSeek={() => seek(seg)} onSaved={() => void segments.refetch()} />
                ))}
              </ol>
            </details>
          )}
          {['queued', 'processing'].includes(s.status) && !segments.data && (
            <Empty title="Transcript on its way">Recordings are transcribed with real timestamps. This page updates by itself.</Empty>
          )}
        </div>

        <aside className="space-y-5">
          <GenerateBriefs source={s} disabled={!['ready', 'needs_attention'].includes(s.status)} uncertain={uncertainCount}
            onQueued={() => void jobs.refetch()} />

          <div className="panel p-4">
            <h2 className="font-semibold mb-2">Briefs from this source</h2>
            {briefs.data?.length ? (
              <ul className="space-y-2 text-sm">
                {briefs.data.map((b) => (
                  <li key={b.id}>
                    <Link to="/briefs/$briefId" params={{ briefId: b.id }} className="font-semibold hover:underline">{b.title}</Link>
                    <span className="flex items-center gap-2 text-ink-faint">{showName(b.show_id)} <BriefBadge status={b.status} /></span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-faint">None yet.</p>}
          </div>

          {analysis.data && (
            <div className="panel p-4 text-sm space-y-3">
              <h2 className="font-semibold">What the source contains</h2>
              <p className="source-text text-[15px]">{analysis.data.summary}</p>
              {analysis.data.themes.length > 0 && (
                <div><h3 className="font-semibold">Themes</h3>
                  <ul className="list-disc pl-5">{analysis.data.themes.map((t, i) => <li key={i}>{t.theme} <span className="text-ink-faint">[{t.segment_start}–{t.segment_end}]</span></li>)}</ul>
                </div>
              )}
              {analysis.data.claims.some((c) => c.needs_verification) && (
                <div><h3 className="font-semibold">Claims needing verification</h3>
                  <ul className="list-disc pl-5">{analysis.data.claims.filter((c) => c.needs_verification).map((c, i) => <li key={i}>{c.claim}</li>)}</ul>
                </div>
              )}
              {analysis.data.sensitivities.length > 0 && (
                <div><h3 className="font-semibold text-blocked">Sensitivities</h3>
                  <ul className="list-disc pl-5">{analysis.data.sensitivities.map((x, i) => <li key={i}>{x.issue}</li>)}</ul>
                </div>
              )}
            </div>
          )}

          <SourceFacts source={s} canEdit={canEdit} onSaved={() => void source.refetch()} />
        </aside>
      </div>
    </>
  );
}

function SegmentRow({ seg, timed, active, canEdit, onSeek, onSaved }: {
  seg: Segment; timed: boolean; active: boolean; canEdit: boolean; onSeek: () => void; onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(seg.text);
  const [speaker, setSpeaker] = useState(seg.speaker ?? '');
  const save = useMutation({
    mutationFn: async () => check(await supabase.rpc('correct_segment', { p_segment: seg.id, p_text: text, p_speaker: speaker || null })),
    onSuccess: () => { setEditing(false); onSaved(); },
  });
  return (
    <li id={`seg-${seg.idx}`} className={`grid grid-cols-[64px_1fr_auto] gap-3 px-4 py-2.5 ${active ? 'seg-active' : ''} ${seg.is_uncertain ? 'bg-signal-soft/50' : ''}`}>
      <div className="text-[12px] text-ink-faint pt-1">
        {timed && seg.start_ms != null
          ? <button className="inline-flex items-center gap-1 hover:text-ink" onClick={onSeek} aria-label={`Play from ${clock(seg.start_ms)}`}><Play size={11} aria-hidden />{clock(seg.start_ms)}</button>
          : <span>#{seg.idx}</span>}
      </div>
      {editing ? (
        <div className="space-y-2">
          <input className="field-input text-sm" value={speaker} onChange={(e) => setSpeaker(e.target.value)} placeholder="Speaker label" aria-label="Speaker" />
          <textarea className="field-input source-text" value={text} onChange={(e) => setText(e.target.value)} aria-label="Passage text" />
          <div className="flex gap-2">
            <button className="btn btn-primary btn-sm" onClick={() => save.mutate()} disabled={save.isPending}>Save correction</button>
            <button className="btn btn-quiet btn-sm" onClick={() => { setEditing(false); setText(seg.text); }}>Cancel</button>
          </div>
          <p className="text-[12px] text-ink-faint">Briefs citing this passage will need their evidence re-verified, and any approval on them is withdrawn.</p>
          <ErrorNote error={save.error} />
        </div>
      ) : (
        <div className="min-w-0">
          {seg.speaker && <span className="text-[12px] font-semibold text-ink-soft mr-2">{seg.speaker}</span>}
          <span className="source-text">{seg.text}</span>
          {seg.is_uncertain && <span className="ml-2 text-[12px] font-semibold text-signal">uncertain</span>}
          {seg.version > 1 && <span className="ml-2 text-[12px] text-verified">corrected</span>}
        </div>
      )}
      <div>
        {canEdit && !editing && (
          <button className="text-ink-faint hover:text-ink p-1" onClick={() => setEditing(true)} aria-label={`Correct passage ${seg.idx}`}><Pencil size={14} /></button>
        )}
      </div>
    </li>
  );
}

function GenerateBriefs({ source, disabled, uncertain, onQueued }: { source: Source; disabled: boolean; uncertain: number; onQueued: () => void }) {
  const { org, brands, shows, can } = useOrg();
  const [picked, setPicked] = useState<string[]>([]);
  const eligible = shows.filter((sh) => {
    if (sh.archived_at || !can(WORK_ROLES, sh.brand_id, sh.id)) return false;
    if (source.share_scope === 'organisation') return true;
    if (source.share_scope === 'brand') return sh.brand_id === source.brand_id;
    return source.show_id ? sh.id === source.show_id : sh.brand_id === source.brand_id;
  });
  const queue = useMutation({
    mutationFn: async () => {
      const group = crypto.randomUUID();
      return check(await supabase.rpc('enqueue_job', {
        p_org: org!.id, p_kind: 'generate_briefs',
        p_payload: { source_id: source.id, show_ids: picked, generation_group: group },
        p_idempotency_key: `generate:${source.id}:${group}`,
      }));
    },
    onSuccess: () => { setPicked([]); onQueued(); },
  });

  return (
    <div className="panel p-4">
      <h2 className="font-semibold">General brief</h2>
      <p className="text-sm text-ink-soft mt-0.5 mb-3">Skip the map and let Orb.IT choose the angle for each show. To develop a specific conversation, use the episode map.</p>
      {eligible.some((sh) => !brands.find((b) => b.id === sh.brand_id)?.current_profile_version_id) && (
        <p className="text-[13px] text-ink mb-3 bg-signal-soft rounded px-2 py-1">
          Some brands have no approved brand profile. Their briefs will not reflect station-wide identity and standards until one is approved.
        </p>
      )}
      {uncertain > 0 && <p className="text-[13px] text-ink mb-3 bg-signal-soft rounded px-2 py-1">{uncertain} uncertain passage{uncertain === 1 ? '' : 's'}: correct the important ones first for better evidence.</p>}
      {eligible.length === 0 ? <p className="text-sm text-ink-faint">No shows you can work on can use this source under its sharing setting.</p> : (
        <ul className="space-y-1.5 mb-3">
          {eligible.map((sh) => (
            <li key={sh.id}>
              <label className={`flex items-start gap-2 text-sm ${sh.current_profile_version_id ? '' : 'text-ink-faint'}`}>
                <input type="checkbox" className="mt-1" disabled={!sh.current_profile_version_id} checked={picked.includes(sh.id)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, sh.id] : picked.filter((x) => x !== sh.id))} />
                <span>{sh.name} <span className="text-ink-faint">· {brands.find((b) => b.id === sh.brand_id)?.name}{brands.find((b) => b.id === sh.brand_id)?.current_profile_version_id ? '' : ' (no brand profile)'}</span>
                  {!sh.current_profile_version_id && <Link to="/shows/$showId" params={{ showId: sh.id }} className="block underline">Approve a profile first</Link>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <button className="btn btn-primary w-full justify-center" disabled={disabled || !picked.length || queue.isPending} onClick={() => queue.mutate()}>
        Write {picked.length || ''} brief{picked.length === 1 ? '' : 's'}
      </button>
      <div className="mt-2"><ErrorNote error={queue.error} /></div>
    </div>
  );
}

function SourceFacts({ source, canEdit, onSaved }: { source: Source; canEdit: boolean; onSaved: () => void }) {
  const [rights, setRights] = useState({ rights_status: source.rights_status, rights_notes: source.rights_notes ?? '', share_scope: source.share_scope });
  const save = useMutation({
    mutationFn: async () => check(await supabase.from('sources').update({ ...rights, rights_notes: rights.rights_notes || null }).eq('id', source.id)),
    onSuccess: onSaved,
  });
  const dirty = rights.rights_status !== source.rights_status || (rights.rights_notes || null) !== source.rights_notes || rights.share_scope !== source.share_scope;
  return (
    <div className="panel p-4 text-sm space-y-3">
      <h2 className="font-semibold">Source record</h2>
      <dl className="grid grid-cols-[110px_1fr] gap-y-1">
        <dt className="text-ink-faint">Language</dt><dd>{LANGUAGE_LABEL[source.language] ?? source.language}</dd>
        {source.duration_seconds != null && <><dt className="text-ink-faint">Duration</dt><dd>{clock(source.duration_seconds * 1000)}</dd></>}
        {source.size_bytes != null && <><dt className="text-ink-faint">Size</dt><dd>{bytes(source.size_bytes)}</dd></>}
        <dt className="text-ink-faint">Timestamps</dt><dd>{source.timestamps_genuine ? 'Genuine' : 'None'}</dd>
        {source.origin_url && <><dt className="text-ink-faint">Origin</dt><dd className="truncate"><a className="underline" href={source.origin_url} target="_blank" rel="noreferrer">{source.origin_url}</a></dd></>}
        {source.checksum_sha256 && <><dt className="text-ink-faint">SHA-256</dt><dd className="truncate" title={source.checksum_sha256}>{source.checksum_sha256.slice(0, 16)}…</dd></>}
        <dt className="text-ink-faint">Added</dt><dd>{ago(source.created_at)}</dd>
      </dl>
      <fieldset disabled={!canEdit} className="space-y-2">
        <label className="block"><span className="font-semibold">Rights</span>
          <select className="field-input mt-1" value={rights.rights_status} onChange={(e) => setRights({ ...rights, rights_status: e.target.value })}>
            <option value="unknown">Unknown — needs clearance</option><option value="owned">Owned by us</option><option value="licensed">Licensed</option>
            <option value="permitted_reference">Reference only</option><option value="restricted">Restricted</option>
          </select>
        </label>
        <label className="block"><span className="font-semibold">Rights notes</span>
          <input className="field-input mt-1" value={rights.rights_notes} onChange={(e) => setRights({ ...rights, rights_notes: e.target.value })} />
        </label>
        <label className="block"><span className="font-semibold">Who can use it</span>
          <select className="field-input mt-1" value={rights.share_scope} onChange={(e) => setRights({ ...rights, share_scope: e.target.value as Source['share_scope'] })}>
            <option value="show">This show only</option><option value="brand">This brand</option><option value="organisation">Whole organisation</option>
          </select>
        </label>
        {canEdit && <button className="btn btn-quiet btn-sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save</button>}
      </fieldset>
      <ErrorNote error={save.error} />
    </div>
  );
}

function RetryUpload({ source, onDone }: { source: Source; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({
    mutationFn: async () => {
      const checksum = await sha256(file!);
      const path = `${source.org_id}/${source.id}/${safeName(file!.name)}`;
      const up = await supabase.storage.from('media').upload(path, file!, { contentType: file!.type || 'application/octet-stream', upsert: false });
      if (up.error) throw new Error(up.error.message);
      check(await supabase.rpc('attach_source_upload', { p_source: source.id, p_path: path, p_checksum: checksum, p_size: file!.size, p_mime: file!.type || null }));
      check(await supabase.rpc('enqueue_job', { p_org: source.org_id, p_kind: 'transcribe', p_payload: { source_id: source.id }, p_idempotency_key: `transcribe:${source.id}` }));
    },
    onSuccess: onDone,
  });
  return (
    <div className="panel p-4 bg-signal-soft">
      <p className="font-semibold">No file is attached to this source yet.</p>
      <p className="text-sm text-ink-soft mb-2">The upload may have been interrupted. Choose the file again to finish.</p>
      <div className="flex gap-2">
        <input type="file" className="field-input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="File to upload" />
        <button className="btn btn-primary" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>Upload</button>
      </div>
      <ErrorNote error={upload.error} />
    </div>
  );
}
