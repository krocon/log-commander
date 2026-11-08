import darkJson from './themes/dark.json';
import lightJson from './themes/light.json';
import oneDarkJson from './themes/one-dark.json';
import oneDarkVividJson from './themes/one-dark-vivid.json';
import trueDarkJson from './themes/true-dark.json';
import trueBlackJson from './themes/true-black.json';
import trueLightJson from './themes/true-light.json';
import matrixJson from './themes/matrix.json';
import amberJson from './themes/amber.json';
import solarizedLightJson from './themes/solarized-light.json';
import mysticoC64Json from './themes/mystico-c64.json';
import crimsonJson from './themes/crimson.json';
import rainglowBoldJson from './themes/rainglow-bold.json';
import rainglowEarthsongJson from './themes/rainglow-earthsong.json';
import rainglowLegacyJson from './themes/rainglow-legacy.json';
import rainglowHerokuJson from './themes/rainglow-heroku.json';
import rainglowPiggyJson from './themes/rainglow-piggy.json';
import { Theme } from './theme.models';

/**
 * The schemes shipped with the app (prompt 020), loaded on demand (a chunk of its own, the initial bundle stays
 * small). `dark` and `light` equal the `@theme` blocks of `src/styles.css` (test and `npm run contrast`); every
 * other scheme holds only what differs from the base of its brightness. Origin and licence: `docs/themes.md`.
 */
export const DARK: Theme = darkJson;
export const LIGHT: Theme = lightJson;

/** After editor themes, by way of files-and-folders (`scripts/theme-from-fnf.mjs`). */
export const EXTRA_THEMES: readonly Theme[] = [
  oneDarkJson,
  oneDarkVividJson,
  trueDarkJson,
  trueBlackJson,
  trueLightJson,
  matrixJson,
  amberJson,
  solarizedLightJson,
  mysticoC64Json,
  crimsonJson,
  rainglowBoldJson,
  rainglowEarthsongJson,
  rainglowLegacyJson,
  rainglowHerokuJson,
  rainglowPiggyJson,
];

export const BUILT_IN_THEMES: readonly Theme[] = [DARK, LIGHT, ...EXTRA_THEMES];
