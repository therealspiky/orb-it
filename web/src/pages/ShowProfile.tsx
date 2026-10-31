import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { ErrorNote, Field, PageHeader, Spinner } from '../components/ui';
import { ago } from '../lib/format';
import { useOrg, usePeople } from '../lib/org';
import { missingRequired, PROFILE_GROUPS, type ProfileField } from '../lib/profileFields';
import { check, supabase } from '../lib/supabase';
import { EDITOR_ROLES, WORK_ROLES, type ProfileVersion, type ShowProfile } from '../lib/types';

export function ShowProfilePage() {
  const { showId } = useParams({ from: '/app/shows/$showId' });
  const { shows, brandName, can, refresh } = useOrg();
  const person = usePeople();
  const show = shows.find((s) => s.id === showId);

  const versions = useQuery({
    queryKey: ['profile-versions', showId],
    queryFn: async () => check(await supabase.from('show_profile_versions').select('*').eq('show_id', showId)
      .order('version', { ascending: false })) as ProfileVersion[],
  });

  const latest = versions.data?.[0];
  const approved = versions.data?.find((v) => v.status === 'approved');
  const [draft, setDraft] = useState<ShowProfile>({});
  const [note, setNote] = useState('');
  const [compareId, setCompareId] = useState<string>('');

  useEffect(() => { if (latest) setDraft(structuredClone(latest.profile ?? {})); }, [latest?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const canEdit = show ? can(WORK_ROLES, show.brand_id, show.id) : false;
  const canApprove = show ? can(EDITOR_ROLES, show.brand_id, show.id) : false;
  const missing = useMemo(() => missingRequired(draft), [draft]);
  const dirty = latest ? JSON.stringify(latest.profile) !== JSON.stringify(draft) : Object.keys(draft).length > 0;

  const save = useMutation({
    mutationFn: async () => {
      // Edit the open draft in place; approved versions are never modified — a new draft is created instead.
      if (latest?.status === 'draft') {
        check(await supabase.from('show_profile_versions').update({ profile: draft, change_note: note || latest.change_note }).eq('id', latest.id));
        return latest.id;
      }
      return check(await supabase.rpc('create_profile_draft', { p_show: showId, p_profile: draft, p_note: note || null })) as string;
    },
    onSuccess: () => { setNote(''); void versions.refetch(); },
  });
  const approve = useMutation({
    mutationFn: async (id: string) => check(await supabase.rpc('approve_profile', { p_version: id })),
    onSuccess: () => { void versions.refetch(); refresh(); },
  });

  if (!show) return <Spinner />;
  const compare = versions.data?.find((v) => v.id === compareId);

  return (
    <>
      <PageHeader
        title={`${show.name} profile`}
        lede={<>{brandName(show.brand_id)}. This is the editorial contract every brief for this show is written and judged against.
          Existing briefs keep the version they were written with.</>}
        actions={<>
          {canEdit && <button className="btn btn-quiet" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save draft</button>}
          {canApprove && latest?.status === 'draft' && (
            <button className="btn btn-approve" disabled={dirty || missing.length > 0 || approve.isPending} onClick={() => approve.mutate(latest.id)}
              title={dirty ? 'Save the draft first' : missing.length ? 'Fill the required fields first' : 'Approve this version'}>
              Approve version {latest.version}
            </button>
          )}
        </>}
      />
      <ErrorNote error={save.error || approve.error} />
      {versions.isLoading ? <Spinner /> : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-8 min-w-0">
            <StatusLine latest={latest} approved={approved} missing={missing} />
            {PROFILE_GROUPS.map((g) => (
              <fieldset key={g.key} className="panel p-5 md:p-6" disabled={!canEdit}>
                <legend className="sr-only">{g.title}</legend>
                <h2 className="text-[17px] font-semibold">{g.title}</h2>
                <p className="text-ink-soft text-sm mt-0.5 mb-4 max-w-[70ch]">{g.intro}</p>
                <div className="grid gap-4 md:grid-cols-2">
                  {g.fields.map((f) => (
                    <div key={f.key} className={f.kind === 'long' || f.kind === 'list' ? 'md:col-span-2' : ''}>
                      <ProfileInput field={f} value={draft[g.key]?.[f.key]}
                        onChange={(v) => setDraft({ ...draft, [g.key]: { ...(draft[g.key] ?? {}), [f.key]: v } })} />
                    </div>
                  ))}
                </div>
              </fieldset>
            ))}
            {canEdit && (
              <Field label="Change note" help="Why this version differs; shown in the version history.">
                <input className="field-input" value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            )}
          </div>

          <aside className="space-y-4">
            <div className="panel p-4">
              <h2 className="font-semibold mb-2">Versions</h2>
              <ol className="space-y-2 text-sm">
                {(versions.data ?? []).map((v) => (
                  <li key={v.id} className="flex justify-between gap-2">
                    <span>
                      <strong>v{v.version}</strong> {v.status === 'approved' ? <span className="text-verified">approved</span> : v.status}
                      <span className="block text-ink-faint">{v.approved_at ? `by ${person(v.approved_by)} ${ago(v.approved_at)}` : ago(v.created_at)}</span>
                      {v.change_note && <span className="block text-ink-soft">{v.change_note}</span>}
                    </span>
                  </li>
                ))}
                {!versions.data?.length && <li className="text-ink-faint">No versions yet. Fill in the form and save a draft.</li>}
              </ol>
              {(versions.data?.length ?? 0) > 1 && (
                <label className="block mt-4 text-sm">
                  <span className="font-semibold">Compare current form with</span>
                  <select className="field-input mt-1" value={compareId} onChange={(e) => setCompareId(e.target.value)}>
                    <option value="">Choose a version</option>
                    {versions.data!.map((v) => <option key={v.id} value={v.id}>Version {v.version} ({v.status})</option>)}
                  </select>
                </label>
              )}
            </div>
            {compare && <ProfileDiff before={compare.profile} after={draft} label={`v${compare.version} → form`} />}
          </aside>
        </div>
      )}
    </>
  );
}

function StatusLine({ latest, approved, missing }: { latest?: ProfileVersion; approved?: ProfileVersion; missing: string[] }) {
  return (
    <div className={`rounded-md px-4 py-3 text-sm border ${approved ? 'bg-verified-soft border-verified/30' : 'bg-signal-soft border-signal/40'}`}>
      {approved
        ? <>Briefs use <strong>version {approved.version}</strong>.{latest?.status === 'draft' && <> Draft version {latest.version} is waiting for an editor.</>}</>
        : <>No approved profile yet, so Orb.IT cannot write briefs for this show.</>}
      {missing.length > 0 && <span className="block mt-1">Required before approval: {missing.join(', ')}.</span>}
    </div>
  );
}

function ProfileInput({ field, value, onChange }: { field: ProfileField; value: unknown; onChange: (v: unknown) => void }) {
  const label = field.required ? `${field.label} (required)` : field.label;
  switch (field.kind) {
    case 'long':
      return <Field label={label} help={field.help}><textarea className="field-input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} /></Field>;
    case 'number':
      return <Field label={label} help={field.help}><input className="field-input" type="number" min={0} value={(value as number | undefined) ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} /></Field>;
    case 'select':
      return (
        <Field label={label} help={field.help}>
          <select className="field-input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">Not set</option>
            {field.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      );
    case 'bool':
      return (
        <label className="flex items-center gap-2 mt-6">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          <span className="text-sm font-semibold">{field.label}</span>
        </label>
      );
    case 'list':
      return (
        <Field label={label} help={field.help ?? 'One per line.'}>
          <textarea className="field-input" value={Array.isArray(value) ? value.join('\n') : ''}
            onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trimStart()).filter((s, i, a) => s || i === a.length - 1))} />
        </Field>
      );
    default:
      return <Field label={label} help={field.help}><input className="field-input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} /></Field>;
  }
}

function ProfileDiff({ before, after, label }: { before: ShowProfile; after: ShowProfile; label: string }) {
  const rows: { field: string; a: string; b: string }[] = [];
  for (const g of PROFILE_GROUPS) for (const f of g.fields) {
    const a = JSON.stringify(before?.[g.key]?.[f.key] ?? '');
    const b = JSON.stringify(after?.[g.key]?.[f.key] ?? '');
    if (a !== b) rows.push({ field: f.label, a: fmt(before?.[g.key]?.[f.key]), b: fmt(after?.[g.key]?.[f.key]) });
  }
  return (
    <div className="panel p-4 text-sm">
      <h3 className="font-semibold mb-2">Changes {label}</h3>
      {rows.length === 0 ? <p className="text-ink-faint">No differences.</p> : (
        <dl className="space-y-3">
          {rows.map((r) => (
            <div key={r.field}>
              <dt className="font-semibold">{r.field}</dt>
              <dd className="line-through text-ink-faint">{r.a || 'empty'}</dd>
              <dd>{r.b || 'empty'}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function fmt(v: unknown): string {
  if (Array.isArray(v)) return v.filter(Boolean).join('; ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v == null ? '' : String(v);
}
