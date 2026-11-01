# Status against the product spec

Measured against *Orb.IT Product Vision and Requirements* (30 October 2026). "Built" means code exists and
has automated tests; nothing here has yet been run on real Joy Prime or Hitz FM material, so no
acceptance test is passed until the pilot runs it on fresh sources with real keys.

## Built in Phase 1

| Spec area | What exists |
|---|---|
| §3 Hierarchy and roles | Organisation > brand > show; nine roles scoped to org, brand or show; enforced in Postgres RLS and workflow functions, not the UI. Archive/restore. |
| §3/§4 Brand profiles | Station-wide profile (identity, voice, language, standards and exclusions, rights, commercial context, examples), versioned with brand-editor approval. Briefs are written against the approved brand and show profiles and record both versions; a missing brand profile is recorded as an unresolved item, never guessed. |
| §4 Show profiles | Guided profile covering identity, voice/format, language, boundaries, production, commercial, examples. Versioned drafts, editor approval, side-by-side comparison. Briefs record the profile version used; generation refuses shows without an approved profile. |
| §5 Ingestion and evidence | Upload with SHA-256 fingerprint, duplicate refusal, immutable originals, worker re-verification, ffprobe validation, chunked transcription with genuine timestamps, uncertainty flags, pasted transcripts/notes (no invented times), versioned corrections that reset dependent evidence. Explicit queued / processing / needs review / ready / failed states; retry of an interrupted upload. |
| Episode map (content inventory) | After analysis, every distinct conversation in an episode is mapped with playable moments, verbatim hooks, sensitivities, platform formats, and which eligible shows could take it with a distinct one-line treatment each. One click develops a conversation into briefs for the chosen shows; briefs link back to their conversation. Hooks, moments and show eligibility are validated deterministically. |
| §7 Cross-brand intelligence (core) | One source, several destination shows in one run; each brief sees sister treatments so it must differ. Source sharing scope (show / brand / organisation) enforced at enqueue and again at execution. |
| §8 Complete brief | Schema-validated brief with decision and fit, evidence, treatment, rundown, guests, production tasks, social package, review flags, continuation, unresolved items. Editable sections, versions, compare, section locks, comments, tasks, statuses from discovered to closed. |
| §14 Review enforcement | Fact, fairness, privacy, rights, language (+ commercial when flagged) recorded against one version by named reviewers. Final approval only by editors, only when checks pass, evidence is verified, blocking tasks are done. Any edit or source correction withdraws approvals. Audit log. |
| §16 Architecture | Durable jobs with idempotency keys, bounded retries with backoff, heartbeat and stale-job recovery, provenance on every generated version (model, prompt version, profile version, validation report). Transcript treated as untrusted data in prompts. |
| §14 Languages | English, Pidgin and mixed handled by detection; Twi marked beta, every Twi passage flagged, mandatory language review flag added to briefs. |

## Acceptance tests (§19)

| Test | State |
|---|---|
| AT01 hierarchy and access | Automated database checks pass (tenant isolation, scoped reads/writes, restricted sources leave no trace). Needs a run on the hosted project. |
| AT02 ingestion and recovery | Fingerprinting, duplicate refusal, retries and failure states built. Not yet run on a fresh 60-minute recording. Large uploads (>50 MB on Supabase free tier) need the size limit raised; resumable uploads are not built. |
| AT03 evidence traceability | Quote/range/attribution validation built and unit-tested. Needs the 20-claim sample on real output. |
| AT04 profile effect | Mechanism built (profile-driven prompts, sibling differentiation). Needs editor scoring on four real profiles. |
| AT05 actionable brief | Schema enforces every component or an unresolved item with owner and next action. Needs 10 real briefs rated. |
| AT06 rundown and editing | Arithmetic check, versioning, provenance built. **Targeted AI regeneration that preserves locked sections is not built** (locks currently guard manual edits). |
| AT07 actual media | **Not built** — Phase 2 (clip rendering, captions, thumbnails). Social assets show "planned, not rendered". |
| AT08 review enforcement | Automated database checks pass. |
| AT09 post-show and series | **Not built** — Phase 2. |
| AT10 memory correction | Correction propagation and access revocation covered by database checks. Editorial memory search is not built. |
| AT11 guests and advertisers | **Not built** — guests are roles only; directories come in P1. |
| AT12 connectors and languages | YouTube link import built (official API: details for any public video, captions for connected channels, paste fallback); SRT/VTT/Word transcripts supported. **RSS ingestion not built.** Not yet run against live YouTube. |

## Next, in order

1. **Pilot run (phase 0 exit):** hosted Supabase, keys, 10 representative recordings incl. Pidgin and code-switching; measure word error rate and brief usefulness with editors.
2. **Targeted revision:** "rewrite this section" with locked sections preserved.
3. **Media worker (Phase 2):** 9:16 H.264/AAC clip render from evidence ranges, burned-in and SRT/VTT captions, thumbnails, audiogram for audio-only, render states and checksums.
4. **Post-show report and follow-up:** attach aired recording to the planned episode, plan-vs-aired comparison, linked next-episode proposal.
5. **Editorial memory search, guest and advertiser records, YouTube/RSS ingestion, resumable uploads.**
