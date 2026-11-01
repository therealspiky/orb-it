export interface Segment {
  idx: number;
  start_ms: number | null;
  end_ms: number | null;
  speaker: string | null;
  text: string;
  confidence: number | null;
  is_uncertain: boolean;
}

export interface SourceRow {
  id: string;
  org_id: string;
  brand_id: string;
  show_id: string | null;
  kind: 'recording' | 'transcript' | 'notes';
  title: string;
  programme_name: string | null;
  origin_url: string | null;
  storage_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  checksum_sha256: string | null;
  duration_seconds: number | null;
  language: string;
  twi_beta: boolean;
  rights_status: string;
  rights_notes: string | null;
  share_scope: 'show' | 'brand' | 'organisation';
  timestamps_genuine: boolean;
  author: string | null;
  status: string;
  external?: Record<string, unknown>;
}

export interface JobRow {
  id: string;
  org_id: string;
  kind: 'transcribe' | 'analyse' | 'generate_briefs' | 'map_episode' | 'youtube_import' | 'youtube_connect';
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  created_by: string | null;
}

/** Thrown for problems a retry cannot fix (bad input, permissions, unsupported media). */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}
