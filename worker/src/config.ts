import { hostname } from 'node:os';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export type TranscribeProvider = 'openai' | 'deepgram';

export interface Config {
  supabaseUrl: string;
  supabaseServiceKey: string;
  anthropicKey: string;
  transcribeProvider: TranscribeProvider;
  openaiKey?: string;
  openaiTranscribeModel: string;
  deepgramKey?: string;
  deepgramModel: string;
  analysisModel: string;
  briefModel: string;
  workerId: string;
  pollMs: number;
  maxUploadMb: number;
  chunkSeconds: number;
}

export function loadConfig(): Config {
  const transcribeProvider = (process.env.TRANSCRIBE_PROVIDER ?? 'openai') as TranscribeProvider;
  if (!['openai', 'deepgram'].includes(transcribeProvider)) {
    throw new Error(`TRANSCRIBE_PROVIDER must be openai or deepgram, got ${transcribeProvider}`);
  }
  const cfg: Config = {
    supabaseUrl: req('SUPABASE_URL'),
    supabaseServiceKey: req('SUPABASE_SERVICE_ROLE_KEY'),
    anthropicKey: req('ANTHROPIC_API_KEY'),
    transcribeProvider,
    openaiKey: process.env.OPENAI_API_KEY,
    // whisper-1 returns real segment timestamps via verbose_json.
    openaiTranscribeModel: process.env.OPENAI_TRANSCRIBE_MODEL ?? 'whisper-1',
    deepgramKey: process.env.DEEPGRAM_API_KEY,
    deepgramModel: process.env.DEEPGRAM_MODEL ?? 'nova-3',
    analysisModel: process.env.ANALYSIS_MODEL ?? 'claude-haiku-5-5',
    briefModel: process.env.BRIEF_MODEL ?? 'claude-sonnet-5-5',
    workerId: process.env.WORKER_ID ?? `${hostname()}-${process.pid}`,
    pollMs: Number(process.env.POLL_MS ?? 3000),
    maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 2048),
    chunkSeconds: Number(process.env.CHUNK_SECONDS ?? 600),
  };
  if (cfg.transcribeProvider === 'openai' && !cfg.openaiKey) {
    throw new Error('OPENAI_API_KEY is required when TRANSCRIBE_PROVIDER=openai');
  }
  if (cfg.transcribeProvider === 'deepgram' && !cfg.deepgramKey) {
    throw new Error('DEEPGRAM_API_KEY is required when TRANSCRIBE_PROVIDER=deepgram');
  }
  return cfg;
}
