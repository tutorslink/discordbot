/**
 * startup-check.js
 *
 * Early startup validation for hosting environments.
 * - Detects a broken .env path (directory instead of file)
 * - Prints clear guidance for environment variable setup
 */

import fs from 'fs';
import path from 'path';

const ENV_PATH = path.resolve(process.cwd(), '.env');

export function runStartupPreflight() {
  try {
    if (fs.existsSync(ENV_PATH)) {
      const stat = fs.statSync(ENV_PATH);
      if (stat.isDirectory()) {
        console.error('[Startup] Fatal: .env is a directory, not a file.');
        console.error('[Startup] This breaks npm/package resolution in some hosts.');
        console.error('[Startup] Fix: remove the .env directory and set variables in your host environment panel.');
        process.exit(1);
      }
    }
  } catch (e) {
    console.warn('[Startup] Preflight check encountered an error:', e.message);
  }
}
