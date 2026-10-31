import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Download, Lock, Unlock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { EvidenceRail } from '../components/brief/EvidenceRail';
import { DiscussionPanel, TasksPanel, VersionsPanel } from '../components/brief/Panels';
import { ReviewPanel } from '../components/brief/ReviewPanel';
import {
  ContinuationSection, DecisionSection, GuestsSection, RundownSection, SectionHead, SocialSection, TreatmentSection,
} from '../components/brief/Sections';
import { BriefBadge, ErrorNote, Spinner } from '../components/ui';
import { briefToMarkdown, download } from '../lib/exportBrief';
import { ago } from '../lib/format';
import { useOrg, usePeople } from '../lib/org';
import { check, supabase } from '../lib/supabase';
import {
  EDITOR_ROLES, REVIEWER_ROLES, WORK_ROLES, type Brief, type BriefContent, type BriefStatus, type BriefVersion,
  type Comment, type Evidence, type ReviewDecision, type Segment, type Source, type Task,
} from '../lib/types';

type Tab = 'decision' | 'treatment' | 'rundown' | 'guests' | 'social' | 'continuation' | 'tasks' | 'review' | 'versions' | 'discussion';
const TABS: { key: Tab; label: string; lockable?: boolean }[] = [
  { key: 'decision', label: 'Angle and fit', lockable: true },
  { key: 'treatment', label: 'Treatment', lockable: true },
  { key: 'rundown', label: 'Rundown', lockable: true },
  { key: 'guests', label: 'Guests', lockable: true },
  { key: 'social', label: 'Social package', lockable: true },
  { key: 'continuation', label: 'After the show', lockable: true },
  { key: 'tasks', label: 'Tasks' },
  { key: 'review', label: 'Review and approval' },
  { key: 'versions', label: 'Versions' },
  { key: 'discussion', label: 'Discussion' },
];

export function BriefWorkspace() {
  const { briefId } = useParams({ from: '/app/briefs/$briefId' });
  const { org, userId, can, showName, brandName } = useOrg();
  const person = usePeople();
  const [tab, setTab] = useState<Tab>('decision');
  const [activeRef, setActiveRef] = useState<string | null>(null);
  const [draft, setDraft] = useState<BriefContent | null>(null);
  const [locked, setLocked] = useState<string[]>([]);
  const [note, setNote] = useState('');

  const brief = useQuery({
    queryKey: ['brief', briefId],
    queryFn: async () => check(await supabase.from('briefs').select('*').eq('id', briefId).single()) as Brief,
  });
  const b = brief.data;
  const versions = useQuery({
    queryKey: ['brief-versions', briefId, b?.current_version_id],
    enabled: !!b,
    queryFn: async () => check(await supabase.from('brief_versions').select('*').eq('brief_id', briefId).order('version', { ascending: false })) as BriefVersion[],
  });
  const current = versions.data?.find((v) => v.id === b?.current_version_id);
  const evidence = useQuery({
    queryKey: ['evidence', current?.id],
    enabled: !!current,
    queryFn: async () => check(await supabase.from('evidence').select('*').eq('brief_version_id', current!.id).order('ref_key')) as Evidence[],
  });
  const source = useQuery({
    queryKey: ['source', b?.origin_source_id],
    enabled: !!b?.origin_source_id,
    queryFn: async () => (await supabase.from('sources').select('*').eq('id', b!.origin_source_id!).maybeSingle()).data as Source | null,
  });
  const segments = useQuery({
    queryKey: ['segments-for-brief', b?.origin_source_id, b?.evidence_changed_at],
    enabled: !!source.data,
    queryFn: async () => check(await supabase.from('transcript_segments').select('*').eq('source_id', b!.origin_source_id!).order('idx').limit(5000)) as Segment[],
  });
  const mediaUrl = useQuery({
    queryKey: ['media-url', source.data?.storage_path],
    enabled: !!source.data?.storage_path && source.data.kind === 'recording',
    staleTime: 50 * 60_000,
    queryFn: async () => check(await supabase.storage.from('media').createSignedUrl(source.data!.storage_path!, 3600))!.signedUrl,
  });
  const profile = useQuery({
    queryKey: ['profile-version', current?.profile_version_id],
    enabled: !!current?.profile_version_id,
    queryFn: async () => (await supabase.from('show_profile_versions').select('version,profile').eq('id', current!.profile_version_id!).maybeSingle()).data as
      { version: number; profile: Record<string, Record<string, unknown>> } | null,
  });
  const tasks = useQuery({
    queryKey: ['tasks', briefId],
    queryFn: async () => check(await supabase.from('research_tasks').select('*').eq('brief_id', briefId).order('created_at')) as Task[],
  });
  const decisions = useQuery({
    queryKey: ['decisions', briefId, b?.current_version_id, b?.status],
    queryFn: async () => check(await supabase.from('review_decisions').select('*').eq('brief_id', briefId).order('created_at', { ascending: false })) as ReviewDecision[],
  });
  const blockers = useQuery({
    queryKey: ['blockers', briefId, b?.current_version_id, b?.status, decisions.dataUpdatedAt, evidence.dataUpdatedAt, tasks.dataUpdatedAt],
    enabled: !!b,
    queryFn: async () => check(await supabase.rpc('approval_blockers', { p_brief: briefId })) as string[],
  });
  const comments = useQuery({
    queryKey: ['comments', briefId],
    queryFn: async () => check(await supabase.from('brief_comments').select('*').eq('brief_id', briefId).order('created_at')) as Comment[],
  });

  useEffect(() => {
    if (current) { setDraft(structuredClone(current.content)); setLocked(current.locked_sections ?? []); }
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => !!current && !!draft &&
    (JSON.stringify(current.content) !== JSON.stringify(draft) || JSON.stringify(current.locked_sections ?? []) !== JSON.stringify(locked)), [current, draft, locked]);

  const refreshAll = () => {
    void brief.refetch(); void versions.refetch(); void evidence.refetch(); void tasks.refetch();
    void decisions.refetch(); void blockers.refetch(); void comments.refetch();
  };

  const save = useMutation({
    mutationFn: async () => check(await supabase.rpc('save_brief_version', {
      p_brief: briefId, p_base_version: current!.id, p_content: draft, p_locked: locked, p_note: note || null,
    })),
    onSuccess: () => { setNote(''); refreshAll(); },
  });
  const setStatus = useMutation({
    mutationFn: async ({ status, reason }: { status: BriefStatus; reason?: string }) =>
      check(await supabase.rpc('set_brief_status', { p_brief: briefId, p_status: status, p_reason: reason ?? null })),
    onSuccess: refreshAll,
  });

  if (brief.error) return <ErrorNote error={brief.error} />;
  if (!b || !current || !draft) return <Spinner />;

  const canWork = can(WORK_ROLES, b.brand_id, b.show_id);
  const canReview = can(REVIEWER_ROLES, b.brand_id, b.show_id);
  const canEditorial = can(EDITOR_ROLES, b.brand_id, b.show_id);
  const closed = ['closed', 'archived', 'rejected'].includes(b.status);
  const refStates = Object.fromEntries((evidence.data ?? []).map((e) => [e.ref_key, e.verification]));
  const set = (patch: Partial<BriefContent>) => setDraft({ ...draft, ...patch });
  const isLocked = (k: Tab) => locked.includes(k);
  const sectionProps = (k: Tab) => ({
    c: draft, set, disabled: !canWork || closed || isLocked(k), refStates, activeRef,
    onPick: (r: string) => setActiveRef(r),
  });
  const slot = Number(profile.data?.profile?.voice?.episode_length_minutes) || null;
  const tabMeta = TABS.find((t) => t.key === tab)!;
  const openBlocking = (tasks.data ?? []).filter((t) => t.blocking && t.status !== 'done').length;

  function exportMd() {
    const md = briefToMarkdown({
      brief: b!, version: { ...current!, content: draft! }, evidence: evidence.data ?? [], decisions: decisions.data ?? [],
      tasks: tasks.data ?? [], showName: showName(b!.show_id), brandName: brandName(b!.brand_id),
      sourceTitle: source.data?.title ?? null, person,
    });
    download(`${draft!.title.replace(/[^\w]+/g, '-').slice(0, 60)}-v${current!.version}.md`, md);
  }
  function exportJson() {
    download(`brief-${b!.id}-v${current!.version}.json`, JSON.stringify({
      brief: b, version: current, evidence: evidence.data, review_decisions: decisions.data, tasks: tasks.data,
    }, null, 2), 'application/json');
  }

  return (
    <>
      <header className="pb-5 mb-6 border-b border-line">
        <p className="text-sm text-ink-soft">
          <Link to="/briefs" className="hover:underline">Briefs</Link> / {brandName(b.brand_id)} / {showName(b.show_id)}
        </p>
        <div className="flex flex-wrap items-start justify-between gap-4 mt-1">
          <div className="min-w-0 max-w-[80ch]">
            <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">{draft.title}</h1>
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft">
              <BriefBadge status={b.status} />
              <span>{draft.recommendation === 'research' ? 'Recommendation: research first' : 'Recommendation: proceed'}</span>
              <span>Version {current.version}, {current.generated ? `drafted by ${current.model}` : `edited by ${person(current.created_by)}`} {ago(current.created_at)}</span>
              {profile.data && <Link to="/shows/$showId" params={{ showId: b.show_id }} className="underline">Show profile v{profile.data.version}</Link>}
              {source.data && <Link to="/sources/$sourceId" params={{ sourceId: source.data.id }} className="underline">Source</Link>}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canWork && ['discovered', 'researching', 'drafted'].includes(b.status) && (
              <button className="btn btn-primary" disabled={dirty} title={dirty ? 'Save your edits first' : undefined}
                onClick={() => setStatus.mutate({ status: 'producer_review' })}>Submit for review</button>
            )}
            {canWork && b.status === 'producer_review' && (
              <button className="btn btn-quiet" onClick={() => setStatus.mutate({ status: 'specialist_review', reason: 'Escalated for specialist review' })}>Escalate to specialist</button>
            )}
            {canWork && b.status === 'approved' && <button className="btn btn-quiet" onClick={() => setStatus.mutate({ status: 'scheduled' })}>Mark scheduled</button>}
            {canWork && b.status === 'scheduled' && <button className="btn btn-quiet" onClick={() => setStatus.mutate({ status: 'produced' })}>Mark produced</button>}
            {canWork && b.status === 'produced' && <button className="btn btn-quiet" onClick={() => setStatus.mutate({ status: 'closed' })}>Close</button>}
            {(canEditorial || canWork) && !closed && (
              <button className="btn btn-danger" onClick={() => {
                const reason = window.prompt('Why reject this opportunity? (Recorded so future recommendations learn the right lesson.)');
                if (reason?.trim()) setStatus.mutate({ status: 'rejected', reason: reason.trim() });
              }}>Reject</button>
            )}
            {closed && canWork && b.status !== 'archived' && <button className="btn btn-quiet" onClick={() => setStatus.mutate({ status: 'drafted', reason: 'Reopened' })}>Reopen</button>}
            <button className="btn btn-quiet" onClick={exportMd}><Download size={14} aria-hidden /> Export</button>
            <button className="btn btn-quiet" onClick={exportJson}>JSON</button>
          </div>
        </div>
        {b.evidence_changed_at && (
          <p className="mt-3 text-sm bg-blocked-soft text-blocked rounded-md px-3 py-2">
            A passage this brief cites was corrected {ago(b.evidence_changed_at)}. Re-check the affected evidence, then save a new version; earlier approvals were withdrawn.
          </p>
        )}
        {b.status_reason && !b.evidence_changed_at && <p className="mt-2 text-sm text-ink-soft">{b.status_reason}</p>}
        <ErrorNote error={setStatus.error} />
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[190px_minmax(0,1fr)] xl:grid-cols-[190px_minmax(0,1fr)_380px]">
        <nav aria-label="Brief sections" className="min-w-0 lg:sticky lg:top-6 self-start">
          <ul className="flex lg:flex-col gap-1 overflow-x-auto pb-2 lg:pb-0">
            {TABS.map((t) => (
              <li key={t.key}>
                <button onClick={() => setTab(t.key)}
                  className={`w-full text-left flex items-center justify-between gap-2 px-3 py-2 rounded-md text-[14px] whitespace-nowrap ${tab === t.key ? 'bg-ink text-white font-semibold' : 'hover:bg-line/60'}`}>
                  {t.label}
                  {isLocked(t.key) && <Lock size={12} aria-label="locked" />}
                  {t.key === 'tasks' && openBlocking > 0 && <span className={`text-[11px] font-bold rounded-full px-1.5 ${tab === t.key ? 'bg-white text-blocked' : 'bg-blocked text-white'}`}>{openBlocking}</span>}
                  {t.key === 'review' && (blockers.data?.length ?? 0) === 0 && b.status !== 'approved' && ['producer_review', 'specialist_review'].includes(b.status) && <span className="text-[11px] font-bold text-verified">ready</span>}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <section className="min-w-0">
          {tabMeta.lockable && (
            <SectionHead title={tabMeta.label}>
              {canWork && !closed && (
                <button className="inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
                  onClick={() => setLocked(isLocked(tab) ? locked.filter((x) => x !== tab) : [...locked, tab])}>
                  {isLocked(tab) ? <><Unlock size={14} aria-hidden /> Unlock section</> : <><Lock size={14} aria-hidden /> Lock as accepted</>}
                </button>
              )}
            </SectionHead>
          )}
          {!tabMeta.lockable && <SectionHead title={tabMeta.label} />}

          {tab === 'decision' && <DecisionSection {...sectionProps('decision')} />}
          {tab === 'treatment' && <TreatmentSection {...sectionProps('treatment')} />}
          {tab === 'rundown' && <RundownSection {...sectionProps('rundown')} slotMinutes={slot} />}
          {tab === 'guests' && <GuestsSection {...sectionProps('guests')} />}
          {tab === 'social' && <SocialSection {...sectionProps('social')} />}
          {tab === 'continuation' && <ContinuationSection {...sectionProps('continuation')} />}
          {tab === 'tasks' && <TasksPanel briefId={b.id} orgId={org!.id} tasks={tasks.data ?? []} canWork={canWork} onChanged={() => { void tasks.refetch(); void blockers.refetch(); }} />}
          {tab === 'review' && (
            <ReviewPanel brief={b} versionId={current.id} versionNumber={current.version} content={current.content}
              decisions={decisions.data ?? []} blockers={blockers.data ?? []} canReview={canReview} canApprove={canEditorial}
              dirty={dirty} onChanged={refreshAll} />
          )}
          {tab === 'versions' && <VersionsPanel versions={versions.data ?? []} />}
          {tab === 'discussion' && <DiscussionPanel briefId={b.id} orgId={org!.id} userId={userId!} comments={comments.data ?? []} canComment={canReview || canWork} onChanged={() => void comments.refetch()} />}

          {dirty && (
            <div className="sticky bottom-4 mt-8 panel p-3 flex flex-wrap items-center gap-3 shadow-[0_6px_24px_rgba(23,35,59,0.12)]">
              <span className="text-sm font-semibold">Unsaved changes</span>
              <input className="field-input flex-1 min-w-[200px]" placeholder="What changed (optional)" aria-label="Change note" value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="btn btn-quiet" onClick={() => { setDraft(structuredClone(current.content)); setLocked(current.locked_sections ?? []); }}>Discard</button>
              <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Save as version {current.version + 1}</button>
              {['approved', 'scheduled', 'specialist_review'].includes(b.status) && <span className="text-[13px] text-blocked w-full">Saving withdraws the current approval and checks.</span>}
              <div className="w-full"><ErrorNote error={save.error} /></div>
            </div>
          )}
        </section>

        <aside className="lg:col-span-2 xl:col-span-1 min-w-0">
          <EvidenceRail evidence={evidence.data ?? []} content={current.content} segments={segments.data ?? []} source={source.data ?? null}
            mediaUrl={mediaUrl.data ?? null} activeRef={activeRef} onPick={setActiveRef} canVerify={canReview} isCurrent
            onChanged={() => { void evidence.refetch(); void blockers.refetch(); }} />
        </aside>
      </div>
    </>
  );
}
