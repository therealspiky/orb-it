import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PermanentError } from '../types.js';

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`)),
    );
  });
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on('data', (d) => hash.update(d)).on('end', () => resolve()).on('error', reject);
  });
  return hash.digest('hex');
}

export interface Probe {
  durationSeconds: number;
  hasAudio: boolean;
  hasVideo: boolean;
  formatName: string;
}

export async function probe(path: string): Promise<Probe> {
  let out: string;
  try {
    ({ stdout: out } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]));
  } catch (e) {
    throw new PermanentError(`The file could not be read as audio or video (${(e as Error).message.slice(0, 200)})`);
  }
  const j = JSON.parse(out) as {
    format?: { duration?: string; format_name?: string };
    streams?: { codec_type?: string; duration?: string }[];
  };
  const streams = j.streams ?? [];
  const duration = Number(j.format?.duration ?? streams.find((s) => s.duration)?.duration ?? 0);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    hasVideo: streams.some((s) => s.codec_type === 'video'),
    formatName: j.format?.format_name ?? 'unknown',
  };
}

export interface AudioChunk {
  path: string;
  offsetMs: number;
}

/**
 * Extracts mono 16 kHz speech-optimised MP3 chunks of `chunkSeconds` each.
 * At 48 kbps a 10-minute chunk is ~3.6 MB, well inside provider upload limits.
 */
export async function extractAudioChunks(input: string, workDir: string, chunkSeconds: number): Promise<AudioChunk[]> {
  const dir = join(workDir, 'chunks');
  await mkdir(dir, { recursive: true });
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k',
    '-f', 'segment', '-segment_time', String(chunkSeconds), '-reset_timestamps', '1',
    join(dir, 'chunk_%04d.mp3'),
  ]);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.mp3')).sort();
  const chunks: AudioChunk[] = [];
  let offset = 0;
  for (const f of files) {
    const path = join(dir, f);
    chunks.push({ path, offsetMs: Math.round(offset * 1000) });
    offset += (await probe(path)).durationSeconds;
  }
  return chunks;
}

/** Full-length speech-optimised audio for providers that accept large files (Deepgram). */
export async function extractAudio(input: string, workDir: string): Promise<string> {
  const out = join(workDir, 'audio.mp3');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'libmp3lame', '-b:a', '48k', out]);
  return out;
}
