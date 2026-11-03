import type { OrbitModule } from '../types.js';
import { runMapEpisode } from './mapEpisode.js';

/** The content inventory of an episode: conversations, moments, show and platform fits. */
export const episodeMapModule: OrbitModule = {
  key: 'episode_map',
  label: 'Episode map',
  jobs: { map_episode: (job, ctx) => runMapEpisode(job, ctx) },
};
