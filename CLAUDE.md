# Orb.IT — notes for coding agents

- Spec: Orb.IT Product Vision and Requirements (30 Oct 2026). Status and gaps: docs/STATUS.md.
- Authorisation lives in Postgres (supabase/migrations): RLS policies plus security-definer workflow
  functions. Never move an authorisation or approval rule into the web app or into model output.
- Evidence rules are enforced in worker/src/lib/validateBrief.ts. Quotes must be verbatim, times come
  from transcript segments, guests are roles. Keep these deterministic and tested.
- Briefs are versioned: content changes go through save_brief_version(); approvals bind to a version.
- Run before committing: `supabase/tests/run.sh`, `cd worker && npm test && npx tsc --noEmit`,
  `cd web && npm run build`.
