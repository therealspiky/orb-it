import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Empty, ErrorNote, Field, PageHeader, SourceBadge, Spinner } from '../components/ui';
import { safeName, sha256 } from '../lib/checksum';
import { ago, bytes, LANGUAGE_LABEL } from '../lib/format';
import { useOrg } from '../lib/org';
import { useModules, useSourceLink } from '../modules/runtime';
import { check, supabase } from '../lib/supabase';
import { WORK_ROLES, type Source, type SourceKind } from '../lib/types';

export function SourcesPage() {
  const { org, brandName, showName } = useOrg();
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: ['sources', org!.id],
    refetchInterval: (q) => ((q.state.data as Source[] | undefined)?.some((s) => s.status === 'queued' || s.status === 'processing') ? 4000 : false),
    queryFn: async () => check(await supabase.from('sources').select('*').eq('org_id', org!.id).order('created_at', { ascending: false })) as Source[],
  });

  return (
    <>
      <PageHeader title="Sources"
        lede="Recordings, transcripts and producer notes. Originals are stored unchanged; corrections create new transcript versions."
        actions={<button className="btn btn-primary" onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add source'}</button>} />
      {adding && <AddSource onDone={() => setAdding(false)} />}
      {list.isLoading ? <Spinner /> : list.data?.length ? (
        <div className="panel overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-ink-soft">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-semibold">Source</th><th className="px-4 py-2 font-semibold">From</th>
                <th className="px-4 py-2 font-semibold">Language</th><th className="px-4 py-2 font-semibold">Shared with</th>
                <th className="px-4 py-2 font-semibold">Status</th><th className="px-4 py-2 font-semibold">Added</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id} className="border-b border-line last:border-0 align-top">
                  <td className="px-4 py-2.5">
                    <Link to="/sources/$sourceId" params={{ sourceId: s.id }} className="font-semibold hover:underline">{s.title}</Link>
                    <span className="block text-ink-faint">{s.kind === 'recording' ? 'Recording' : s.kind === 'transcript' ? 'Transcript' : 'Producer notes'} {bytes(s.size_bytes)}</span>
                  </td>
                  <td className="px-4 py-2.5">{brandName(s.brand_id)}{s.show_id && <span className="block text-ink-faint">{showName(s.show_id)}</span>}</td>
                  <td className="px-4 py-2.5">{LANGUAGE_LABEL[s.language] ?? s.language}</td>
                  <td className="px-4 py-2.5">{s.share_scope === 'organisation' ? 'Whole organisation' : s.share_scope === 'brand' ? 'This brand' : 'This show only'}</td>
                  <td className="px-4 py-2.5"><SourceBadge status={s.status} />{s.status_message && <span className="block text-ink-faint mt-0.5 max-w-[28ch]">{s.status_message}</span>}</td>
                  <td className="px-4 py-2.5 text-ink-soft whitespace-nowrap">{ago(s.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !adding && (
        <Empty title="No sources yet">Add a programme recording, a transcript or your notes. Orb.IT transcribes recordings with real timestamps so every brief can cite the exact passage.</Empty>
      )}
    </>
  );
}

const ACCEPT: Record<SourceKind, string> = {
  recording: 'audio/*,video/*',
  transcript: '.txt,.srt,.vtt,.docx,text/plain,text/vtt,application/x-subrip,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  notes: '.txt,.md,.docx,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function AddSource({ onDone }: { onDone: () => void }) {
  const { org, brands, shows, can } = useOrg();
  const navigate = useNavigate();
  const workBrands = brands.filter((b) => !b.archived_at && (can(WORK_ROLES, b.id) || shows.some((s) => s.brand_id === b.id && can(WORK_ROLES, b.id, s.id))));
  const [form, setForm] = useState({
    kind: 'transcript' as SourceKind, brand_id: workBrands[0]?.id ?? '', show_id: '', title: '', programme_name: '',
    origin_url: '', language: 'mixed', share_scope: 'brand', rights_status: 'unknown', rights_notes: '', author: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState('');
  const [step, setStep] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<Source | null>(null);
  const set = (k: keyof typeof form, v: string) => setForm({ ...form, [k]: v });
  const brandShows = shows.filter((s) => s.brand_id === form.brand_id && !s.archived_at);
  const { isEnabled } = useModules();
  const recordings = isEnabled('recording_transcription');
  // A module (for example YouTube) may recognise the link and fill in details or fetch the transcript itself.
  const link = useSourceLink(form.origin_url);
  const fetchedByModule = !!link?.info.transcriptOptional && form.kind === 'transcript' && !file && !pasted.trim();

  const submit = useMutation({
    mutationFn: async () => {
      setDuplicate(null);
      const blob: Blob = file ?? new Blob([pasted], { type: 'text/plain' });
      const filename = file ? safeName(file.name) : `${form.kind}.txt`;
      const hasContent = blob.size > 0;
      if (!hasContent && !fetchedByModule) throw new Error('Choose a file or paste the text first');

      if (link) {
        setStep('Checking whether this link was already added');
        const seen = await link.handler.findDuplicate(org!.id, form.origin_url);
        if (seen) { setDuplicate(seen); throw new Error('This link has already been added.'); }
      }
      let checksum = '';
      if (hasContent) {
        setStep('Fingerprinting file');
        checksum = await sha256(blob);
        const dup = await supabase.from('sources').select('*').eq('org_id', org!.id).eq('checksum_sha256', checksum).maybeSingle();
        if (dup.data) { setDuplicate(dup.data as Source); throw new Error('This exact content has already been added.'); }
      }

      setStep('Creating source record');
      const fillTitle = !!link?.info.titleOptional && !form.title.trim();
      const src = check(await supabase.from('sources').insert({
        org_id: org!.id, brand_id: form.brand_id, show_id: form.show_id || null, kind: form.kind, title: form.title.trim() || 'Untitled (filled in from link)',
        programme_name: form.programme_name || null, origin_url: form.origin_url || null, language: form.language,
        twi_beta: form.language === 'tw', share_scope: form.share_scope, rights_status: form.rights_status,
        rights_notes: form.rights_notes || null, author: form.author || null,
      }).select('*').single()) as Source;

      if (hasContent) {
        setStep(`Uploading ${bytes(blob.size)}`);
        const path = `${org!.id}/${src.id}/${filename}`;
        const up = await supabase.storage.from('media').upload(path, blob, { contentType: blob.type || 'application/octet-stream', upsert: false });
        if (up.error) throw new Error(`Upload failed: ${up.error.message}. The source was created; open it to retry the upload.`);
        check(await supabase.rpc('attach_source_upload', { p_source: src.id, p_path: path, p_checksum: checksum, p_size: blob.size, p_mime: blob.type || null }));
        setStep('Queuing transcription');
        check(await supabase.rpc('enqueue_job', { p_org: org!.id, p_kind: 'transcribe', p_payload: { source_id: src.id }, p_idempotency_key: `transcribe:${src.id}` }));
      }
      if (link) {
        setStep('Fetching details from the link');
        await link.handler.afterCreate({ orgId: org!.id, source: src, hasTranscript: hasContent, fillTitle });
      }
      return src;
    },
    onSettled: () => setStep(null),
    onSuccess: (src) => { onDone(); void navigate({ to: '/sources/$sourceId', params: { sourceId: src.id } }); },
  });

  if (!workBrands.length) return <div className="mb-6"><Empty title="You cannot add sources yet">Ask an administrator for a producer or researcher role on a brand or show.</Empty></div>;

  return (
    <form className="panel p-5 md:p-6 mb-8 grid gap-4 md:grid-cols-2" onSubmit={(e: FormEvent) => { e.preventDefault(); submit.mutate(); }}>
      <Field label="Type">
        <select className="field-input" value={form.kind} onChange={(e) => { set('kind', e.target.value); setFile(null); }}>
          <option value="transcript">Transcript or captions (fastest)</option>
          {recordings && <option value="recording">Recording (audio or video)</option>}
          <option value="notes">Producer notes</option>
        </select>
      </Field>
      <Field label="Link" help={link ? link.info.help : 'Where this material lives (for example a YouTube or Facebook link).'}>
        <input className="field-input" type="url" value={form.origin_url} onChange={(e) => set('origin_url', e.target.value)} placeholder="https://www.youtube.com/watch?v=…" />
      </Field>
      <div className="md:col-span-2">
        <Field label="Title" help={link?.info.titleOptional ? 'Leave blank to use the title from the link.' : undefined}>
          <input className="field-input" value={form.title} onChange={(e) => set('title', e.target.value)} required={!link?.info.titleOptional} placeholder={link?.info.titleOptional ? 'Filled in from the link' : 'Episode or item title'} />
        </Field>
      </div>
      <Field label="Brand">
        <select className="field-input" value={form.brand_id} onChange={(e) => setForm({ ...form, brand_id: e.target.value, show_id: '' })}>
          {workBrands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </Field>
      <Field label="Show" help="Leave blank for brand-level material.">
        <select className="field-input" value={form.show_id} onChange={(e) => set('show_id', e.target.value)}>
          <option value="">No specific show</option>
          {brandShows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="Originating programme" help="As it should be attributed."><input className="field-input" value={form.programme_name} onChange={(e) => set('programme_name', e.target.value)} /></Field>
      <Field label="Language" help={form.language === 'tw' ? 'Twi is a supervised beta: every passage is flagged for a qualified reviewer.' : undefined}>
        <select className="field-input" value={form.language} onChange={(e) => set('language', e.target.value)}>
          {Object.entries(LANGUAGE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <Field label="Who can use it" help="Controls whether other brands' shows can build briefs from this source.">
        <select className="field-input" value={form.share_scope} onChange={(e) => set('share_scope', e.target.value)}>
          <option value="show">This show only</option>
          <option value="brand">This brand</option>
          <option value="organisation">Whole organisation (cross-brand)</option>
        </select>
      </Field>
      <Field label="Rights">
        <select className="field-input" value={form.rights_status} onChange={(e) => set('rights_status', e.target.value)}>
          <option value="unknown">Unknown — needs clearance</option>
          <option value="owned">Owned by us</option>
          <option value="licensed">Licensed</option>
          <option value="permitted_reference">Reference only (no reuse of media)</option>
          <option value="restricted">Restricted</option>
        </select>
      </Field>
      <Field label="Rights notes"><input className="field-input" value={form.rights_notes} onChange={(e) => set('rights_notes', e.target.value)} /></Field>
      {form.kind !== 'recording' && (
        <Field label="Author"><input className="field-input" value={form.author} onChange={(e) => set('author', e.target.value)} /></Field>
      )}
      <div className="md:col-span-2">
        <Field label={form.kind === 'recording' ? 'Recording file' : 'File'} help={form.kind === 'recording'
          ? 'Audio or video. For long shows, upload audio only (an MP3 of a 60-minute show is about 30–60 MB); Orb.IT transcribes it with real timestamps so every moment can be played back.'
          : form.kind === 'transcript'
            ? 'A .txt or Word (.docx) transcript, or caption files (.srt, .vtt) exported from your editing tool or YouTube. Caption files keep their timings, so moments can be cited by time. Nothing is transcribed, so this is ready in seconds.'
            : 'A text or Word file, or paste below.'}>
          <input className="field-input" type="file" accept={ACCEPT[form.kind]} onChange={(e) => setFile(e.target.files?.[0] ?? null)} required={form.kind === 'recording'} />
          {link?.info.transcriptOptional && form.kind === 'transcript' && (
            <span className="block text-[13px] mt-2 bg-paper border border-line rounded-md px-3 py-2">{link.info.transcriptOptionalHelp}</span>
          )}
        </Field>
        {form.kind !== 'recording' && !file && (
          <div className="mt-3">
            <Field label="Or paste text" help={form.kind === 'transcript' ? 'Lines like "[00:12:30] HOST: …" keep their times. Text without times is never given invented ones.' : undefined}>
              <textarea className="field-input source-text min-h-[180px]" value={pasted} onChange={(e) => setPasted(e.target.value)} />
            </Field>
          </div>
        )}
      </div>
      <div className="md:col-span-2 flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={submit.isPending || (!form.title.trim() && !link?.info.titleOptional) || !form.brand_id}>
          {fetchedByModule && link ? link.info.submitLabel : 'Add and process'}
        </button>
        {step && <span className="text-sm text-ink-soft" aria-live="polite">{step}…</span>}
      </div>
      <div className="md:col-span-2">
        <ErrorNote error={submit.error} />
        {duplicate && (
          <p className="text-sm mt-2">Existing source: <Link className="underline font-semibold" to="/sources/$sourceId" params={{ sourceId: duplicate.id }}>{duplicate.title}</Link></p>
        )}
      </div>
    </form>
  );
}
