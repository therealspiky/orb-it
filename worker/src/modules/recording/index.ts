import type { OrbitModule } from '../types.js';
import { makeTranscriber } from './transcribers.js';

/** Audio/video transcription (OpenAI whisper-1 or Deepgram). Transcript-only instances can leave it out. */
export const recordingModule: OrbitModule = {
  key: 'recording_transcription',
  label: 'Recording transcription',
  readiness: (cfg) => {
    if (cfg.transcribeProvider === 'openai' && !cfg.openaiKey) return 'OPENAI_API_KEY is not set';
    if (cfg.transcribeProvider === 'deepgram' && !cfg.deepgramKey) return 'DEEPGRAM_API_KEY is not set';
    return null;
  },
  mediaTranscriber: (cfg) => makeTranscriber(cfg),
};
