import type { Config } from '../config.js';
import type { Db } from '../lib/db.js';
import type { LlmClient } from '../lib/llm.js';
import type { JobRow, Segment } from '../types.js';

/** Shared services a module receives. Core code never imports a module directly. */
export interface ModuleContext { db: Db; cfg: Config; llm: LlmClient; modules: ModuleState }

export type JobHandler = (job: JobRow, ctx: ModuleContext) => Promise<Record<string, unknown>>;

/** Turns an audio/video file into timed segments (provided by the recording module). */
export interface MediaTranscriber {
  transcribe(mediaPath: string, workDir: string, language: string,
    onProgress: (pct: number, message: string) => Promise<void>): Promise<{ provider: string; model: string; segments: Segment[] }>;
}

export interface OrbitModule {
  /** Matches instance_modules.key in the database. */
  key: string;
  label: string;
  /** Job kinds this module owns; they are refused when the module is off. */
  jobs?: Record<string, JobHandler>;
  /** Optional services used by core jobs. */
  mediaTranscriber?: (cfg: Config) => MediaTranscriber | null;
  /** Reason the module cannot run on this worker (missing keys), or null when ready. */
  readiness?: (cfg: Config) => string | null;
}

export interface ModuleState {
  /** Licensed on this instance (database) and, when it has worker code, installed on this worker. */
  isEnabled(key: string): boolean;
  installed(key: string): OrbitModule | undefined;
}
