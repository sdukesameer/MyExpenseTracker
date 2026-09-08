// ---------------------------------------------------------------------------
//  Regenerate config.js from the environment, at deploy time
//
//  Run by netlify.toml's build command. Without a bundler there is nothing to
//  inline an environment variable into, so this writes the one file the page
//  reads its configuration out of.
//
//  Deliberately a no-op when nothing is set: the committed config.js already
//  holds working values, and a build that quietly blanked them would deploy
//  an app that cannot reach its database. Every variable is independent, so
//  you can override just the proxy and keep the rest.
//
//  It refuses to write a service_role key, which is the one mistake here that
//  would matter: that key bypasses every RLS policy, and this file is served
//  to every visitor.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'config.js');

// env var -> the key it sets in window.APP_CONFIG.
//
// No VITE_ prefix: there is no Vite here, and the prefix means something
// specific — "safe to inline into the client bundle". Applying it to some
// variables and not others invites somebody to make the set uniform by adding
// it to the service_role key, which is the one place it must never appear.
// The line that matters is public vs secret, and it is drawn by whether a
// name appears in this table at all.
const MAPPING = {
  SUPABASE_URL: 'SUPABASE_URL',
  SUPABASE_PROXY_URL: 'SUPABASE_PROXY_URL',
  SUPABASE_ANON_KEY: 'SUPABASE_ANON_KEY',
};

// The names this used to use. Read as a fallback so a deploy keeps working
// while Netlify is being tidied up, and said out loud so it gets tidied up.
const LEGACY = {
  SUPABASE_URL: 'VITE_SUPABASE_URL',
  SUPABASE_PROXY_URL: 'VITE_SUPABASE_PROXY_URL',
  SUPABASE_ANON_KEY: 'VITE_SUPABASE_ANON_KEY',
};

// A service_role JWT carries this in its payload. Catching it here turns a
// catastrophe into a failed build.
function looksLikeServiceKey(value) {
  const text = String(value || '');
  if (/service_role/.test(text)) return true;
  const parts = text.split('.');
  if (parts.length !== 3) return false;
  try {
    return /"role"\s*:\s*"service_role"/.test(
      Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return false;
  }
}

const overrides = {};
for (const [envName, configKey] of Object.entries(MAPPING)) {
  let name = envName;
  let value = process.env[envName];

  if (value === undefined || value === '') {
    const legacy = LEGACY[envName];
    if (legacy && process.env[legacy]) {
      name = legacy;
      value = process.env[legacy];
      console.warn(`  ! ${legacy} is the old name for ${envName}. Rename it in ` +
        'Netlify and delete the old one — this fallback will not be kept forever.');
    }
  }
  if (value === undefined || value === '') continue;

  if (looksLikeServiceKey(value)) {
    console.error(`\n  ✗ ${name} looks like a service_role key.\n` +
      '    config.js is delivered to every visitor and that key bypasses all\n' +
      '    row-level security. Refusing to write it.\n');
    process.exit(1);
  }

  // The functions call Supabase's admin auth endpoints with SUPABASE_URL, and
  // those must not go through the Worker proxy. Setting the proxy here is an
  // easy slip because the browser genuinely does use it.
  if (configKey === 'SUPABASE_URL' && !/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(value)) {
    console.error(`\n  ✗ ${name} is "${value}", which is not a Supabase project URL.\n` +
      '    It must be https://<ref>.supabase.co — the proxy belongs in\n' +
      '    SUPABASE_PROXY_URL. The admin functions call this one directly.\n');
    process.exit(1);
  }

  overrides[configKey] = value;
}

if (!Object.keys(overrides).length) {
  console.log('  config.js: nothing set in the environment, keeping the committed values');
  process.exit(0);
}

// Rewrite the values in place rather than regenerating the file, so the
// comments explaining what may and may not live here survive the deploy.
let source = readFileSync(TARGET, 'utf8');
for (const [key, value] of Object.entries(overrides)) {
  const pattern = new RegExp('(\\b' + key + ':\\s*)(\'[^\']*\'|"[^"]*")');
  if (!pattern.test(source)) {
    console.error(`\n  ✗ config.js has no ${key} to replace. Has it been edited?\n`);
    process.exit(1);
  }
  source = source.replace(pattern, (_, prefix) =>
    prefix + JSON.stringify(String(value)));
  console.log(`  config.js: ${key} set from the environment`);
}
writeFileSync(TARGET, source);
