// The web app's own source, for tests that check what its code says (#602): web/app.js and the modules it was split
// into (web/ui.js, router.js, actions.js, prefs.js and web/views/), as one text. A view's import from '../x.js' reads
// as from './x.js', as it would in web/app.js.
import { readFileSync } from 'node:fs';

export const APP_FILES = ['app.js', 'ui.js', 'router.js', 'actions.js', 'prefs.js', 'views/html.js', 'views/parts.js', 'views/rail.js', 'views/main.js', 'views/drawer.js'];
export const appSource = () => APP_FILES.map((f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8').replace(/ from '\.\.\//g, " from './")).join('\n');
