export type Role =
  | 'org_admin' | 'brand_editor' | 'show_editor' | 'producer' | 'researcher'
  | 'social_producer' | 'commercial' | 'legal_reviewer' | 'viewer';

export const ROLE_LABEL: Record<Role, string> = {
  org_admin: 'Organisation admin',
  brand_editor: 'Brand editor',
  show_editor: 'Show editor',
  producer: 'Producer',
  researcher: 'Researcher',
  social_producer: 'Social producer',
  commercial: 'Commercial',
  legal_reviewer: 'Legal / standards reviewer',
  viewer: 'Read only',
};

export const EDITOR_ROLES: Role[] = ['org_admin', 'brand_editor', 'show_editor'];
export const WORK_ROLES: Role[] = [...EDITOR_ROLES, 'producer', 'researcher', 'social_producer'];
export const REVIEWER_ROLES: Role[] = [...EDITOR_ROLES, 'producer', 'researcher', 'legal_reviewer'];

export interface Organisation { id: string; name: string }
export interface Membership { id: string; org_id: string; user_id: string; role: Role; brand_id: string | null; show_id: string | null }
export interface Brand {
  id: string; org_id: string; name: string; description: string | null; languages: string[]; archived_at: string | null;
  current_profile_version_id: string | null;
}
export interface Show {
  id: string; org_id: string; brand_id: string; name: string; description: string | null;
  current_profile_version_id: string | null; archived_at: string | null;
}
export interface ProfileVersion {
  id: string; show_id: string; version: number; status: 'draft' | 'approved' | 'superseded';
  profile: ShowProfile; change_note: string | null; created_at: string; created_by: string | null;
  approved_at: string | null; approved_by: string | null;
}

export type ShowProfile = Record<string, Record<string, unknown>>;

export type SourceKind = 'recording' | 'transcript' | 'notes';
export type SourceStatus = 'queued' | 'processing' | 'needs_attention' | 'ready' | 'failed';
export interface Source {
  id: string; org_id: string; brand_id: string; show_id: string | null; kind: SourceKind; title: string;
  programme_name: string | null; origin_url: string | null; storage_path: string | null; mime_type: string | null;
  size_bytes: number | null; checksum_sha256: string | null; duration_seconds: number | null; language: string;
  twi_beta: boolean; rights_status: string; rights_notes: string | null; share_scope: 'show' | 'brand' | 'organisation';
  timestamps_genuine: boolean; author: string | null; status: SourceStatus; status_message: string | null;
  created_at: string;
}
export interface Segment {
  id: string; idx: number; start_ms: number | null; end_ms: number | null; speaker: string | null; text: string;
  confidence: number | null; is_uncertain: boolean; version: number;
}

export type BriefStatus =
  | 'discovered' | 'researching' | 'drafted' | 'producer_review' | 'specialist_review'
  | 'approved' | 'scheduled' | 'produced' | 'closed' | 'rejected' | 'archived';

export const STATUS_LABEL: Record<BriefStatus, string> = {
  discovered: 'Discovered', researching: 'Researching', drafted: 'Drafted', producer_review: 'In review',
  specialist_review: 'Specialist review', approved: 'Approved', scheduled: 'Scheduled', produced: 'Produced',
  closed: 'Closed', rejected: 'Rejected', archived: 'Archived',
};

export interface Brief {
  id: string; org_id: string; brand_id: string; show_id: string; origin_source_id: string | null;
  generation_group: string | null; title: string; status: BriefStatus; recommendation: 'proceed' | 'research' | null;
  current_version_id: string | null; evidence_changed_at: string | null; status_reason: string | null;
  episode_map_id: string | null; conversation_key: string | null;
  created_at: string; updated_at: string;
}
export interface BriefVersion {
  id: string; brief_id: string; version: number; content: BriefContent; locked_sections: string[];
  profile_version_id: string | null; brand_profile_version_id: string | null; generated: boolean; model: string | null; prompt_version: string | null;
  validation: { checks?: { name: string; status: 'ok' | 'warn' | 'fail'; detail: string }[] };
  change_note: string | null; created_by: string | null; created_at: string;
}
export type Verification = 'unverified' | 'auto_matched' | 'verified' | 'failed';
export interface Evidence {
  id: string; brief_version_id: string; ref_key: string; source_id: string; segment_start: number; segment_end: number;
  start_ms: number | null; end_ms: number | null; quote: string | null; attribution: string | null;
  kind: string; verification: Verification; note: string | null; verified_at: string | null;
}
export type Check = 'fact' | 'fairness' | 'privacy' | 'rights' | 'language' | 'commercial';
export interface ReviewDecision {
  id: string; brief_version_id: string; check_key: Check | null; outcome: 'passed' | 'failed' | 'not_applicable' | null;
  is_final_approval: boolean; reviewer: string; reviewer_role: Role; reason: string | null; conditions: string | null;
  created_at: string; invalidated_at: string | null; invalidated_reason: string | null;
}
export interface Task {
  id: string; brief_id: string; title: string; detail: string | null; owner_role: string | null; due_date: string | null;
  blocking: boolean; status: 'open' | 'in_progress' | 'done' | 'blocked'; origin: 'manual' | 'generated' | 'unresolved';
  created_at: string;
}
export interface Comment { id: string; brief_id: string; body: string; author: string; created_at: string }
export interface Job {
  id: string; kind: string; payload: Record<string, unknown>; status: string; progress: number;
  message: string | null; error: string | null; created_at: string; updated_at: string;
}

// Brief content (mirrors worker/src/lib/schemas.ts)
export interface BriefContent {
  title: string; premise: string; why_now: string; audience_value: string;
  destination_fit: { summary: string; profile_fields: { field: string; how_it_fits: string }[] };
  new_contribution: string; recommendation: 'proceed' | 'research'; recommendation_reason: string;
  evidence: { ref: string; relevance: string; kind: string }[];
  uncertainties: string[];
  contradictory_evidence: { description: string; evidence_refs: string[] }[];
  treatment: {
    format: string; duration_minutes: number; lines_of_inquiry: { question: string; evidence_refs: string[] }[];
    presenter_opening: string; interview_questions: string[]; takeaway: string;
  };
  rundown: RundownItem[];
  guests: { perspective_needed: string; why_needed: string; suggested_profile: string; credentials_to_verify: string[]; conflicts_to_check: string[]; status?: string }[];
  production_tasks: { title: string; detail: string; owner_role: string; blocking: boolean }[];
  social_package: SocialAsset[];
  review_flags: { check: Check; concern: string; severity: 'low' | 'medium' | 'high' | 'critical' }[];
  continuation: { success_criteria: string[]; post_show_questions: string[]; follow_up_ideas: { title: string; advance: string }[] };
  unresolved: { field: string; reason: string; next_action: string; owner_role: string }[];
}
export interface RundownItem {
  title: string; purpose: string; start_minute: number; duration_minutes: number; is_break: boolean;
  owner_role: string; prompts: string; evidence_refs: string[]; cues: string; fallback: string;
}
export interface SocialAsset {
  asset_type: string; platform: string; format: string; hook: string; caption_draft: string;
  clip_candidate: { segment_start: number; segment_end: number; rationale: string } | null;
  thumbnail_direction: string | null; render_state?: 'planned' | 'rendering' | 'rendered' | 'failed';
}

// Episode map (mirrors worker/src/lib/schemas.ts EpisodeMapSchema after validation)
export interface MapConversation {
  key: string; question: string; summary: string; angle: string; why_it_travels: string;
  moments: { segment_start: number; segment_end: number; hook: string | null; note: string; start_ms: number | null; end_ms: number | null }[];
  needs_outside_evidence: boolean; sensitivities: string[];
  show_fits: { show_id: string; fit: 'strong' | 'possible'; treatment: string; why: string }[];
  platform_fits: { platform: string; format: string; why: string }[];
}
export interface EpisodeMapRow {
  id: string; source_id: string; created_at: string; model: string; considered_shows: string[];
  result: { summary: string; conversations: MapConversation[] };
  validation: { skipped_no_profile?: number };
}
