import { clock } from './format';
import { STATUS_LABEL, type Brief, type BriefVersion, type Evidence, type ReviewDecision, type Task } from './types';

const V: Record<string, string> = {
  verified: 'verified by a person', auto_matched: 'quote matches transcript (not yet listened to)', unverified: 'unverified', failed: 'NOT SUPPORTED',
};

/** Markdown export that carries evidence, uncertainty and review state, not only the polished copy. */
export function briefToMarkdown(args: {
  brief: Brief; version: BriefVersion; evidence: Evidence[]; decisions: ReviewDecision[]; tasks: Task[];
  showName: string; brandName: string; sourceTitle: string | null; person: (id: string | null) => string;
}): string {
  const { brief, version: v, evidence, decisions, tasks } = args;
  const c = v.content;
  const L: string[] = [];
  const h = (s: string) => L.push('', `## ${s}`, '');
  L.push(`# ${c.title}`, '');
  L.push(`${args.showName} (${args.brandName}). Status: ${STATUS_LABEL[brief.status]}. Version ${v.version}, ${new Date(v.created_at).toLocaleString()}.`);
  if (args.sourceTitle) L.push(`Source: ${args.sourceTitle}.`);
  L.push(`Recommendation: ${c.recommendation === 'proceed' ? 'proceed' : 'research first'} — ${c.recommendation_reason}`);
  if (v.generated) L.push(`Drafted by ${v.model} (prompt ${v.prompt_version}); human edits are recorded as later versions.`);

  h('Premise'); L.push(c.premise);
  h('Why now'); L.push(c.why_now);
  h('Audience value'); L.push(c.audience_value);
  h('New contribution'); L.push(c.new_contribution);
  h('Fit with the show profile'); L.push(c.destination_fit.summary, ...c.destination_fit.profile_fields.map((f) => `- ${f.field}: ${f.how_it_fits}`));

  h('Evidence');
  for (const e of evidence) {
    const where = e.start_ms != null ? `${clock(e.start_ms)}–${clock(e.end_ms)}` : `passage ${e.segment_start}–${e.segment_end}`;
    L.push(`- **${e.ref_key}** (${where}${e.attribution ? `, ${e.attribution}` : ''}; ${V[e.verification]})${e.quote ? `: "${e.quote}"` : ''}`);
    const rel = c.evidence.find((x) => x.ref === e.ref_key)?.relevance;
    if (rel) L.push(`  ${rel}`);
  }
  if (!evidence.length) L.push('No source evidence. Treat this brief as a research plan.');
  if (c.uncertainties.length) { h('Uncertainties'); L.push(...c.uncertainties.map((u) => `- ${u}`)); }

  h('Treatment');
  L.push(`${c.treatment.format}, ${c.treatment.duration_minutes} minutes.`, '', `**Opening:** ${c.treatment.presenter_opening}`, '');
  L.push('**Lines of inquiry**', ...c.treatment.lines_of_inquiry.map((l) => `- ${l.question}${l.evidence_refs.length ? ` [${l.evidence_refs.join(', ')}]` : ''}`));
  L.push('', '**Interview questions**', ...c.treatment.interview_questions.map((q) => `- ${q}`), '', `**Takeaway:** ${c.treatment.takeaway}`);

  h('Rundown');
  L.push('| Start | Min | Segment | Purpose | Owner | Evidence |', '|---|---|---|---|---|---|');
  for (const r of c.rundown) {
    L.push(`| ${r.start_minute} | ${r.duration_minutes} | ${r.is_break ? 'BREAK' : r.title} | ${r.purpose} | ${r.owner_role} | ${r.evidence_refs.join(', ')} |`);
  }
  L.push('', `Total: ${c.rundown.reduce((n, r) => n + r.duration_minutes, 0)} minutes.`);

  h('Guests (perspectives, not booked people)');
  for (const g of c.guests) L.push(`- **${g.perspective_needed}** — ${g.suggested_profile}. ${g.why_needed}${g.credentials_to_verify.length ? ` Verify: ${g.credentials_to_verify.join('; ')}.` : ''}`);

  h('Social package (planned, not rendered)');
  for (const a of c.social_package) L.push(`- **${a.asset_type}** for ${a.platform} (${a.format}): ${a.hook}`, `  Caption draft: ${a.caption_draft}`);

  h('Tasks');
  for (const t of tasks) L.push(`- [${t.status === 'done' ? 'x' : ' '}] ${t.title}${t.blocking ? ' (blocking)' : ''} — ${t.owner_role ?? 'unassigned'}`);

  h('Review state');
  const live = decisions.filter((d) => !d.invalidated_at && d.brief_version_id === v.id);
  if (!live.length) L.push('No review decisions on this version.');
  for (const d of live) {
    L.push(`- ${d.is_final_approval ? 'Final approval' : `${d.check_key}: ${d.outcome}`} by ${args.person(d.reviewer)} (${d.reviewer_role}), ${new Date(d.created_at).toLocaleString()}${d.reason ? ` — ${d.reason}` : ''}`);
  }
  for (const f of c.review_flags) L.push(`- Flag (${f.check}, ${f.severity}): ${f.concern}`);

  h('After the programme');
  L.push(...c.continuation.post_show_questions.map((q) => `- ${q}`));
  if (c.continuation.follow_up_ideas.length) L.push('', ...c.continuation.follow_up_ideas.map((f) => `- Follow-up: ${f.title} — ${f.advance}`));
  L.push('', '---', `Exported from Orb.IT ${new Date().toLocaleString()}. Approval applies to version ${v.version} only.`);
  return L.join('\n');
}

export function download(filename: string, text: string, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
