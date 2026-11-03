/**
 * Module registry for this web app deployment.
 *
 * To leave a module out of a deployment, delete its line here and its folder.
 * To switch a module off for an instance without redeploying, set
 * instance_modules.enabled = false in that instance's database.
 */
import { brandProfilesModule } from './brand-profiles';
import { episodeMapModule } from './episode-map';
import type { WebModule } from './types';
import { youtubeModule } from './youtube';

export const INSTALLED_MODULES: WebModule[] = [
  brandProfilesModule,
  episodeMapModule,
  youtubeModule,
];
