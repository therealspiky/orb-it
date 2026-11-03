import type { AnyRoute } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import type { Brand, Brief, BriefVersion, Job, Show, Source } from '../lib/types';

/**
 * Named places in core screens where modules can add UI. Core screens render
 * <Slot name="…"> and never import a module, so a module can be removed without
 * touching them.
 */
export interface SlotProps {
  /** Organisation page, after brands and shows. */
  'admin.sections': object;
  /** Under each brand's name on the Organisation page. */
  'admin.brandStatus': { brand: Brand };
  /** Show profile page, under the title. */
  'showProfile.lede': { show: Show };
  /** Source page, main column above the transcript. */
  'source.main': {
    source: Source; briefs: Brief[]; jobs: Job[];
    onPlay: (ms: number) => void; onQueued: () => void;
    /** Lets the page fold the transcript away once the module shows its own view. */
    onPrimaryView: (shown: boolean) => void;
  };
  /** Source page, top of the source record panel. */
  'source.facts': { source: Source };
  /** Source page, general brief panel, above the show list. */
  'source.generateNotice': { source: Source; shows: Show[] };
  /** Brief workspace header, under the title. */
  'brief.headerLine': { brief: Brief; version: BriefVersion; sourceId: string | null };
  /** Brief workspace header, in the metadata row. */
  'brief.headerMeta': { brief: Brief; version: BriefVersion };
}
export type SlotName = keyof SlotProps;

/** Lets a module recognise links pasted into Add source (for example YouTube). */
export interface SourceLinkHandler {
  recognise(url: string): { help: string; titleOptional: boolean; transcriptOptional: boolean; transcriptOptionalHelp: string; submitLabel: string } | null;
  findDuplicate(orgId: string, url: string): Promise<Source | null>;
  afterCreate(args: { orgId: string; source: Source; hasTranscript: boolean; fillTitle: boolean }): Promise<void>;
}

export interface WebModule {
  /** Matches instance_modules.key in the database. */
  key: string;
  label: string;
  routes?: (parent: AnyRoute) => AnyRoute[];
  slots?: { [K in SlotName]?: ComponentType<SlotProps[K]> };
  sourceLink?: SourceLinkHandler;
}
