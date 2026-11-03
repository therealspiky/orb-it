import type { OrbitModule } from '../types.js';
import { makeYouTube, runYouTubeConnect, runYouTubeImport } from './jobs.js';

/** YouTube link import and channel connection (official API only). */
export const youtubeModule: OrbitModule = {
  key: 'youtube',
  label: 'YouTube import',
  jobs: {
    youtube_import: (job, ctx) => runYouTubeImport(job, { db: ctx.db, cfg: ctx.cfg, yt: makeYouTube(ctx.cfg) }),
    youtube_connect: (job, ctx) => runYouTubeConnect(job, { db: ctx.db, cfg: ctx.cfg, yt: makeYouTube(ctx.cfg) }),
  },
};
