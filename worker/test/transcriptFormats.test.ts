import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { readTextSource } from '../src/jobs/transcribe.js';
import { parseCueTime, parseTextTranscript } from '../src/lib/textTranscript.js';

// Synthetic caption samples written for tests.
const SRT = `1
00:00:01,000 --> 00:00:03,500
HOST: Good morning and welcome to the show.

2
00:00:03,600 --> 00:00:06,000
Today we are talking about trust.

3
00:00:06,200 --> 00:00:09,000
GUEST: Thank you for having me.
`;

const VTT = `WEBVTT
Kind: captions

NOTE produced by an editing tool

00:01.000 --> 00:04.000
<v Ama>Money changes what people forgive.</v>

00:04.500 --> 00:07.000 align:start
<v Kofi>I don't agree with that at all.</v>
`;

// Rolling auto-captions repeat the previous line at the start of each cue.
const ROLLING = `WEBVTT

00:00:00.000 --> 00:00:02.000
so today we are

00:00:02.000 --> 00:00:04.000
so today we are
talking about money

00:00:04.000 --> 00:00:06.000
talking about money
and relationships
`;

describe('caption files', () => {
  it('parses cue times in SRT and VTT forms', () => {
    expect(parseCueTime('00:00:03,500')).toBe(3500);
    expect(parseCueTime('01:02.250')).toBe(62250);
    expect(parseCueTime('1:00:00.000')).toBe(3_600_000);
  });

  it('reads SRT with genuine times, speakers and merged cues', () => {
    const p = parseTextTranscript(SRT, 'transcript');
    expect(p.timestampsGenuine).toBe(true);
    expect(p.segments).toHaveLength(2);
    expect(p.segments[0]).toMatchObject({ speaker: 'HOST', start_ms: 1000, end_ms: 6000, text: 'Good morning and welcome to the show. Today we are talking about trust.' });
    expect(p.segments[1]).toMatchObject({ speaker: 'GUEST', start_ms: 6200 });
  });

  it('reads WebVTT voice tags and ignores headers, notes and cue settings', () => {
    const p = parseTextTranscript(VTT, 'transcript');
    expect(p.segments.map((s) => s.speaker)).toEqual(['Ama', 'Kofi']);
    expect(p.segments[1]!.text).toBe("I don't agree with that at all.");
    expect(p.segments[0]!.start_ms).toBe(1000);
  });

  it('de-duplicates rolling auto-captions', () => {
    const p = parseTextTranscript(ROLLING, 'transcript');
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]!.text).toBe('so today we are talking about money and relationships');
  });

  it('still treats plain transcripts the old way', () => {
    const p = parseTextTranscript('HOST: Hello\nGUEST: Hi', 'transcript');
    expect(p.timestampsGenuine).toBe(false);
    expect(p.segments).toHaveLength(2);
  });
});

describe('Word and other files', () => {
  it('extracts text from a .docx transcript', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>[00:00:05] HOST: Good morning</w:t></w:r></w:p><w:p><w:r><w:t>[00:00:12] GUEST: Thank you</w:t></w:r></w:p></w:body></w:document>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const text = await readTextSource('org/src/show.docx', null, buf);
    const p = parseTextTranscript(text, 'transcript');
    expect(p.timestampsGenuine).toBe(true);
    expect(p.segments.map((s) => s.speaker)).toEqual(['HOST', 'GUEST']);
  });

  it('strips a UTF-8 byte-order mark from text files', async () => {
    const text = await readTextSource('a.txt', 'text/plain', Buffer.from('﻿HOST: Hi', 'utf8'));
    expect(text).toBe('HOST: Hi');
  });

  it('refuses formats it cannot read, with a clear message', async () => {
    await expect(readTextSource('a.pdf', 'application/pdf', Buffer.from('x'))).rejects.toThrow(/cannot be read/);
  });
});

describe('timed fragment transcripts (YouTube "show transcript" style)', () => {
  it('merges two-second fragments into passages with genuine times', () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      const t = 3065 + i * 2; // seconds from 00:51:05
      const mm = String(Math.floor(t / 60)).padStart(2, '0'), ss = String(t % 60).padStart(2, '0');
      lines.push(`00:${mm}:${ss}.220 fragment number ${i}`);
    }
    const p = parseTextTranscript(lines.join('\n'), 'transcript');
    expect(p.timestampsGenuine).toBe(true);
    expect(p.segments.length).toBe(3); // 60 s of fragments in ~25 s passages
    expect(p.segments[0]!.start_ms).toBe(3065 * 1000);
    expect(p.segments[0]!.text.startsWith('fragment number 0 fragment number 1')).toBe(true);
    expect(p.segments.map((s) => s.idx)).toEqual([0, 1, 2]);
  });

  it('does not merge across speakers', () => {
    const p = parseTextTranscript('[00:00:01] HOST: Hi\n[00:00:03] GUEST: Hello\n[00:00:05] HOST: Welcome', 'transcript');
    expect(p.segments.map((s) => s.speaker)).toEqual(['HOST', 'GUEST', 'HOST']);
  });
});
