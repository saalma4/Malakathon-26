/**
 * Opens YOUR Chrome (not Playwright's) with the remote debugging port on, so
 * the checker can test games in it: log in to Betsson by hand once, then pick
 * the provider and games in the UI and press Play (each game opens in a new tab
 * of this Chrome, in play-for-fun mode). The UI also opens it by itself if needed.
 *
 *   npm run chrome                      # opens betsson.es
 *   npm run chrome -- "<url>"
 *
 * Chrome only allows remote debugging on a non-default profile, so this uses
 * its own profile in .cache/chrome-profile (git-ignored): log in once, it stays.
 * Port: CDP_PORT (default 9222). Browser path: CHROME_PATH if not auto-found.
 */
import path from 'node:path';
import { CDP_PORT, openChrome } from '../src/runner/chrome';

const url = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'https://www.betsson.es/casino';
try {
  const exe = openChrome(url);
  console.log(`Abierto ${path.basename(exe)} con depuración en el puerto ${CDP_PORT} (perfil .cache/chrome-profile).`);
  console.log('1) Inicia sesión en Betsson a mano (solo la primera vez).  2) En la interfaz elige proveedor y juegos y pulsa Play.');
  console.log('Mientras se prueba, deja la ventana visible y no la toques.');
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
