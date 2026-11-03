/**
 * Module registry for this worker deployment.
 *
 * To leave a module out of a deployment, delete its line here and its folder.
 * To switch a module off for an instance without redeploying, set
 * instance_modules.enabled = false in that instance's database.
 * Modules with no worker code (for example brand_profiles) are controlled by the
 * database flag alone.
 */
import { episodeMapModule } from './episode-map/index.js';
import { recordingModule } from './recording/index.js';
import type { OrbitModule } from './types.js';
import { youtubeModule } from './youtube/index.js';

export const INSTALLED_MODULES: OrbitModule[] = [
  recordingModule,
  episodeMapModule,
  youtubeModule,
];
