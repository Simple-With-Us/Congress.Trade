// Upload the inline dashboard source as a Sentry release artifact.
// Never prints SENTRY_AUTH_TOKEN.  Release is the verified Coolify SHA.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DASHBOARD_SOURCE = resolve(ROOT, 'app/src/ui/dashboardHtml.ts');
const SHA = /^[0-9a-f]{40}$/;

export function resolveBrowserRelease(env = process.env) {
  const raw = (env.SENTRY_RELEASE || env.CT_BUILD_SHA || env.SOURCE_COMMIT || '').trim().toLowerCase();
  if (!SHA.test(raw)) throw new Error('SENTRY_RELEASE (or CT_BUILD_SHA / SOURCE_COMMIT) must be a full SHA');
  return raw;
}

export function uploadBrowserSourcemaps({
  release,
  token,
  spawn = spawnSync,
  source = DASHBOARD_SOURCE,
} = {}) {
  if (!token?.trim()) throw new Error('SENTRY_AUTH_TOKEN is required');
  if (!SHA.test(release || '')) throw new Error('release must be a full SHA');
  if (!existsSync(source)) throw new Error('dashboardHtml.ts is missing');
  const result = spawn('npx', [
    '--yes',
    '@sentry/cli',
    'sourcemaps',
    'upload',
    '--org',
    'simple-with-us',
    '--project',
    'congress-trade',
    '--release',
    release,
    '--strip-prefix',
    ROOT,
    source,
  ], {
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SENTRY_AUTH_TOKEN: token },
  });
  if (result.error) throw new Error('sentry-cli sourcemaps upload failed to start');
  if (result.status !== 0) throw new Error(`sentry-cli sourcemaps upload failed (exit ${result.status})`);
  return { release, uploaded: source };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const release = resolveBrowserRelease();
    if (!process.env.SENTRY_AUTH_TOKEN?.trim()) throw new Error('SENTRY_AUTH_TOKEN is required');
    const result = uploadBrowserSourcemaps({ release, token: process.env.SENTRY_AUTH_TOKEN });
    console.log(`Uploaded browser source maps for release ${result.release}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
