'use strict';

/**
 * Migrate profiles from the original backend.
 *
 * The v1 format was a single file per player containing both the public
 * roleplay fields and a plaintext `_password`:
 *
 *   profiles/aely.profile  ->  { "_password": "hunter2", "bio": "...", ... }
 *
 * This script reads those files and produces the v2 layout: a hashed account
 * plus a public profile with no secrets in it. Existing passwords keep working,
 * so nobody has to re-register.
 *
 * Usage:
 *   node scripts/migrate-from-v1.js /path/to/old/profiles
 *
 * It never modifies the source directory. Run it, check the output, and keep
 * the old folder around until you are satisfied.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const store = require('../src/store');
const config = require('../src/config');
const { NAME_RE } = require('../src/validate');

async function main() {
  const source = process.argv[2];
  if (!source) {
    console.error('Usage: node scripts/migrate-from-v1.js /path/to/old/profiles');
    process.exit(2);
  }

  await store.init();

  const files = await fsp.readdir(source);
  const report = { migrated: 0, skippedExisting: 0, skippedBadName: 0, failed: 0, noPassword: [] };

  for (const file of files) {
    if (!file.endsWith('.profile')) continue;
    const name = file.slice(0, -'.profile'.length).toLowerCase();

    if (!NAME_RE.test(name)) {
      console.warn(`SKIP  ${file} — "${name}" is not a legal name in v2 (2-24 chars, a-z 0-9 _ -)`);
      report.skippedBadName += 1;
      continue;
    }
    if (store.getAccount(name)) {
      console.warn(`SKIP  ${file} — account "${name}" already exists`);
      report.skippedExisting += 1;
      continue;
    }

    try {
      const raw = await fsp.readFile(path.join(source, file), 'utf8');
      const data = JSON.parse(raw);
      const { _password: password, password: altPassword, ...fields } = data;
      const existing = password || altPassword;

      if (!existing) {
        // No password on the old record: we cannot invent one, and creating an
        // account with a blank password would let anyone claim the name.
        console.warn(`SKIP  ${file} — no password field; this profile cannot be claimed safely`);
        report.noPassword.push(name);
        continue;
      }
      if (existing.length < config.minPasswordLength) {
        console.warn(
          `NOTE  ${name} — old password is shorter than MIN_PASSWORD_LENGTH (${config.minPasswordLength}). ` +
            'Importing it anyway so the player keeps access; ask them to change it.'
        );
      }

      await store.createAccount(name, existing);
      await store.writeProfile(name, fields);
      console.log(`OK    ${name}`);
      report.migrated += 1;
    } catch (err) {
      console.error(`FAIL  ${file} — ${err.message}`);
      report.failed += 1;
    }
  }

  console.log('\n--- Migration summary ---');
  console.log(`  migrated:          ${report.migrated}`);
  console.log(`  already existed:   ${report.skippedExisting}`);
  console.log(`  illegal names:     ${report.skippedBadName}`);
  console.log(`  no password:       ${report.noPassword.length}`);
  console.log(`  failed:            ${report.failed}`);
  if (report.noPassword.length) {
    console.log(`\n  Unclaimed names: ${report.noPassword.join(', ')}`);
    console.log('  Tell those players to register normally; the name is still free.');
  }
  if (report.migrated > 0) {
    console.log(
      '\nNOTE: imported profiles are stored as PLAINTEXT, because that is how v1 ' +
        'wrote them. If REQUIRE_ENCRYPTION is on, the mod will fetch these and fail ' +
        'to decrypt them. Have each player re-save their profile once from inside ' +
        'the mod; that rewrites it as an encrypted envelope.'
    );
  }
  console.log(
    '\nPasswords imported from v1 were stored in plaintext on the old server. ' +
      'They are hashed now, but anyone who had disk access to the old server has already seen them. ' +
      'Ask players to change their password after logging in.'
  );
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
