#!/usr/bin/env node
'use strict';

/**
 * Cross-platform command line entry point.
 *
 *     npx -y github:OWNER/REPO install
 *
 * Two things this file exists for:
 *
 * 1. The command is byte-for-byte identical on Windows, macOS and Linux.
 *    Underneath it dispatches to the platform's own installer, because
 *    installing a system service genuinely differs per OS — systemd, launchd
 *    and Scheduled Tasks have nothing in common.
 *
 * 2. It runs straight from the GitHub repository. npm can install from a git
 *    spec, so there is no package to publish and no registry account needed.
 *    Whatever is on the branch is what gets installed.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const menu = require('./menu');

// If nothing upstream set this, decide it here — this process is then the top
// of the chain. Downstream shell scripts cannot distinguish a real terminal
// from the pty sudo hands them under `Defaults use_pty`, so the answer has to
// be captured where stdin is still the user's own.
if (process.env.PALRP_STDIN_TTY === undefined) {
  process.env.PALRP_STDIN_TTY = process.stdin.isTTY ? '1' : '0';
}

const PKG_ROOT = path.join(__dirname, '..');
const PKG = require(path.join(PKG_ROOT, 'package.json'));

/**
 * Rebuild the `github:owner/repo` spec from package.json, so messages quote a
 * command that actually works for whoever is running this — including forks.
 */
function repoSpec() {
  const url = PKG.repository?.url || '';
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  return m ? `github:${m[1]}/${m[2]}` : null;
}
const SPEC = repoSpec();
const NPX = SPEC ? `npx -y ${SPEC}` : 'npx palworld-rp';
const DEPLOY = path.join(PKG_ROOT, 'deploy');
const PLATFORM = process.platform === 'win32' ? 'windows'
  : process.platform === 'darwin' ? 'macos'
  : process.platform === 'linux' ? 'linux'
  : null;

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', n: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', n: '' };

const say  = (m) => console.log(m);
const ok   = (m) => console.log(`${C.g}  ok${C.n}    ${m}`);
const warn = (m) => console.log(`${C.y}  warn${C.n}  ${m}`);
const die  = (m) => { console.error(`\n${C.r}  error${C.n} ${m}\n`); process.exit(1); };

// ---------------------------------------------------------------------------
// Where each platform puts things. Kept in step with the installers.
// ---------------------------------------------------------------------------
const LAYOUT = {
  linux:   { conf: '/etc/palworld-rp-backend',            data: '/var/lib/palworld-rp-backend' },
  macos:   { conf: '/usr/local/etc/palworld-rp-backend',  data: '/usr/local/var/palworld-rp-backend' },
  windows: {
    conf: path.join(process.env.ProgramData || 'C:\\ProgramData', 'PalworldRPBackend', 'config'),
    data: path.join(process.env.ProgramData || 'C:\\ProgramData', 'PalworldRPBackend', 'data'),
  },
};

function isElevated() {
  if (PLATFORM === 'windows') {
    // `net session` fails for non-administrators. Cheap and dependency-free.
    const r = spawnSync('net', ['session'], { stdio: 'ignore', shell: false });
    return r.status === 0;
  }
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** Run a command, inheriting stdio so the user sees progress live. */
function run(cmd, args, { dryRun } = {}) {
  if (dryRun) {
    say(`${C.b}  would run:${C.n} ${cmd} ${args.join(' ')}`);
    return 0;
  }
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  if (r.error) die(`Could not run ${cmd}: ${r.error.message}`);
  return r.status ?? 1;
}

/**
 * Run one of the deploy scripts, elevating first if we are not already root.
 *
 * On Unix we can re-exec ourselves under sudo, so the user never has to
 * remember it. On Windows we cannot: UAC opens a *new* console window, so an
 * automatic elevation would make this window exit while the real work happens
 * somewhere the user is not looking. Telling them plainly is kinder.
 */
function runPrivileged(script, extraArgs, opts) {
  const scriptPath = path.join(DEPLOY, script);
  if (!fs.existsSync(scriptPath)) die(`Missing ${scriptPath}. The package looks incomplete.`);

  if (PLATFORM === 'windows') {
    if (!isElevated() && !opts.dryRun) {
      die([
        'This needs an Administrator PowerShell.',
        '',
        '  1. Press Start, type "PowerShell"',
        '  2. Right-click "Windows PowerShell" and choose "Run as Administrator"',
        '  3. Run the same command again',
        '',
        'Administrator rights are needed to install software, open the firewall,',
        'and register a service that starts with Windows.',
      ].join('\n'));
    }
    return run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...extraArgs], opts);
  }

  if (isElevated()) return run('bash', [scriptPath, ...extraArgs], opts);

  const sudo = spawnSync('sh', ['-c', 'command -v sudo'], { encoding: 'utf8' });
  if (sudo.status !== 0) die('Not running as root, and sudo is not available. Re-run as root.');

  warn('Elevating with sudo — you may be asked for your password.');
  // Pass the caller's configuration through explicitly: sudo strips the
  // environment by default, and these are the settings that matter.
  // sudo strips the environment, so anything the installer needs must be named
  // here. PALRP_STDIN_TTY especially: it records whether a human can actually
  // answer a prompt, and losing it makes the installer guess wrong and hang.
  // VNC_PORT and QUIET were being silently dropped before this list grew.
  const passthrough = [
    'DOMAIN', 'ACME_EMAIL', 'TLS_MODE',
    'VNC_PORT', 'QUIET', 'CADDY_VERSION', 'NODE_MAJOR', 'PALRP_STDIN_TTY',
  ]
    .filter((k) => process.env[k] !== undefined && process.env[k] !== '')
    .map((k) => `${k}=${process.env[k]}`);
  return run('sudo', [...passthrough, 'bash', scriptPath, ...extraArgs], opts);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInstall(args, opts) {
  if (!PLATFORM) die(`Unsupported platform: ${process.platform}. Linux, macOS and Windows are supported.`);
  say(`\n${C.b}  Palworld RP Backend${C.n}   installing on ${PLATFORM}\n`);

  const script = {
    linux: 'install.sh',
    macos: 'install-macos.sh',
    windows: 'install-windows.ps1',
  }[PLATFORM];

  // Windows takes -Domain style parameters; the shell installers read env vars.
  const extra = [];
  if (PLATFORM === 'windows') {
    const domain = optValue(args, '--domain') || process.env.DOMAIN;
    const email = optValue(args, '--email') || process.env.ACME_EMAIL;
    if (domain) extra.push('-Domain', domain);
    if (email) extra.push('-AcmeEmail', email);
  } else {
    const domain = optValue(args, '--domain');
    const email = optValue(args, '--email');
    if (domain) process.env.DOMAIN = domain;
    if (email) process.env.ACME_EMAIL = email;
  }

  const code = runPrivileged(script, extra, opts);
  if (code === 0 && !opts.dryRun) printUrl();
  return code;
}

function cmdDoctor(args, opts) {
  if (PLATFORM === 'windows') {
    say('\nThere is no doctor script on Windows. Check these three things:\n');
    say('  Get-ScheduledTask -TaskName PalworldRPBackend');
    say('  Invoke-WebRequest http://127.0.0.1:3000/health -UseBasicParsing');
    say(`  Get-Content "${path.join(LAYOUT.windows.conf, '..', 'logs', 'err.log')}" -Tail 40\n`);
    return 0;
  }
  return runPrivileged('doctor.sh', [], opts);
}

function cmdUpdate(args, opts) {
  // Nothing to pull: npx already fetched the current state of the branch before
  // this process started, so the copy running right now IS the update. All that
  // remains is to re-run the installer, which is idempotent.
  say('\nRe-running the installer from the copy npx just fetched.');
  say('That copy is the current state of the repository branch.');
  say('Your data and configuration are preserved.\n');
  return cmdInstall(args, opts);
}

function cmdUninstall(args, opts) {
  if (PLATFORM === 'windows') {
    say('\nTo remove it on Windows, in an Administrator PowerShell:\n');
    say('  Unregister-ScheduledTask -TaskName PalworldRPBackend       -Confirm:$false');
    say('  Unregister-ScheduledTask -TaskName PalworldRPBackendCaddy  -Confirm:$false');
    say(`  Remove-Item -Recurse -Force "${path.join(LAYOUT.windows.conf, '..', 'app')}"`);
    say(`\nYour data in ${LAYOUT.windows.data} is left alone. Delete it yourself when sure.\n`);
    return 0;
  }
  return runPrivileged('uninstall.sh', args.filter((a) => a === '--purge-data'), opts);
}

function cmdBackup(args, opts) {
  if (PLATFORM === 'windows') {
    say(`\nCopy the data directory somewhere safe:\n\n  ${LAYOUT.windows.data}\n`);
    say('It contains password hashes, so treat the copy as sensitive.\n');
    return 0;
  }
  return runPrivileged('backup.sh', [], opts);
}

function cmdKeygen(args, opts) {
  const script = path.join(PKG_ROOT, 'scripts', 'keygen.js');
  if (!fs.existsSync(script)) die('scripts/keygen.js is missing from this package.');
  return run(process.execPath, [script], opts);
}

function printUrl() {
  if (!PLATFORM) return;
  const file = path.join(LAYOUT[PLATFORM].conf, 'backend-url.txt');
  try {
    const url = fs.readFileSync(file, 'utf8').trim();
    say(`\n${C.b}  Backend URL for the mod:${C.n}\n\n      ${C.b}${url}${C.n}\n`);
  } catch (err) {
    // EACCES means the file is there but this user cannot reach it, which is a
    // completely different problem from the install being broken. Saying "run
    // doctor" for a permissions issue sends people hunting in the wrong place.
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      warn(`No permission to read ${file}.`);
      warn(`Try: sudo palworld-rp url`);
      warn(`To fix it for good:  sudo chmod 0755 ${path.dirname(file)}`);
    } else if (err.code === 'ENOENT') {
      warn(`${file} does not exist yet. Run "${NPX} doctor" to check the install.`);
    } else {
      warn(`Could not read ${file}: ${err.code || err.message}`);
    }
  }
}

function cmdUrl() {
  printUrl();
  return 0;
}

function cmdStatus(args, opts) {
  if (PLATFORM === 'linux') return run('systemctl', ['status', 'palworld-rp-backend', '--no-pager'], opts);
  if (PLATFORM === 'macos') return run('launchctl', ['print', 'system/io.palworldrp.backend'], opts);
  return run('powershell', ['-NoProfile', '-Command', 'Get-ScheduledTask -TaskName PalworldRPBackend'], opts);
}


// ---------------------------------------------------------------------------
// Interactive menu
//
// Everything here delegates to the same functions the flag-based commands use,
// so there is exactly one implementation of each action. The menu is a front
// end, not a second code path that can drift out of step.
// ---------------------------------------------------------------------------

const PANEL_PORT = process.env.ADMIN_UI_PORT || '8787';

function envFilePath() {
  if (PLATFORM === 'linux') return '/etc/palworld-rp-backend/env';
  if (PLATFORM === 'macos') return '/usr/local/etc/palworld-rp-backend/env';
  return path.join(process.env.ProgramData || 'C:\\ProgramData', 'PalworldRPBackend', 'config', 'env');
}

function readAdminToken() {
  try {
    const text = fs.readFileSync(envFilePath(), 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('ADMIN_TOKEN='));
    return line ? line.slice('ADMIN_TOKEN='.length).trim() : '';
  } catch {
    // Mode 640 root:palrp — unreadable without sudo, which is the point.
    return '';
  }
}

function panelInstructions() {
  const token = readAdminToken();
  say('');
  say(`  ${C.b}Admin panel${C.n}`);
  say('');
  say(`  It listens on 127.0.0.1:${PANEL_PORT} and is deliberately NOT reachable`);
  say('  from the internet. To open it from your own computer, forward the port:');
  say('');
  say(`      ${C.b}ssh -L ${PANEL_PORT}:127.0.0.1:${PANEL_PORT} ${process.env.SUDO_USER || 'you'}@<this-server>${C.n}`);
  say('');
  say(`  then browse to  ${C.b}http://localhost:${PANEL_PORT}${C.n}`);
  say('');
  if (token) {
    say(`  Sign in with the admin token:  ${C.b}${token}${C.n}`);
  } else {
    say(`  ${C.y}Run this with sudo to have the admin token printed here.${C.n}`);
  }
  say('');
}

async function apiCall(pathname, method, body) {
  const token = readAdminToken();
  if (!token) {
    throw new Error('Cannot read the admin token. Re-run with sudo.');
  }
  const base = `http://127.0.0.1:${PANEL_PORT}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!login.ok) throw new Error('The panel rejected the admin token.');
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

  const res = await fetch(base + pathname, {
    method: method || 'GET',
    headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function playersMenu() {
  for (;;) {
    let data;
    try {
      data = await apiCall('/api/players');
    } catch (err) {
      say(`\n  ${C.r}${err.message}${C.n}`);
      say('  The backend must be running for player management to work.\n');
      return;
    }
    if (!data.players.length) {
      say('\n  No accounts registered yet.\n');
      return;
    }
    const items = data.players.slice(0, 40).map((p) => ({
      label: `${p.name.padEnd(26)} ${p.banned ? '[banned]' : p.online ? '[online]' : '[offline]'}`,
      value: p,
    }));
    items.push({ label: 'Back', value: null });

    const chosen = await menu.select(`Players  (${data.total} total)`, items);
    if (!chosen) return;

    const action = await menu.select(`${chosen.name}`, [
      ...(chosen.banned
        ? [{ label: 'Unban', value: 'unban' }]
        : [{ label: 'Ban', value: 'ban' }, { label: 'Kick (disconnect)', value: 'kick' }]),
      { label: 'Delete account permanently', value: 'delete' },
      { label: 'Back', value: null },
    ]);
    if (!action) continue;

    try {
      let body = {};
      if (action === 'ban') {
        body.reason = (await menu.ask('  Reason (shown to them): ')) || 'No reason given.';
      }
      if (action === 'delete' && !(await menu.confirm(`  Permanently delete ${chosen.name}?`))) continue;
      await apiCall(`/api/players/${encodeURIComponent(chosen.name)}/${action}`, 'POST', body);
      say(`\n  ${C.g}${action} ${chosen.name}${C.n}\n`);
    } catch (err) {
      say(`\n  ${C.r}${err.message}${C.n}\n`);
    }
  }
}

async function cmdMenu(args, opts) {
  for (;;) {
    const choice = await menu.select('Palworld RP Backend', [
      { label: 'Status and health', value: 'status' },
      { label: 'Full diagnostic (doctor)', value: 'doctor' },
      { label: 'Players and bans', value: 'players' },
      { label: 'Open the admin panel', value: 'panel' },
      { label: 'Show the backend URL', value: 'url' },
      { label: 'Back up now', value: 'backup' },
      { label: 'View logs', value: 'logs' },
      { label: 'Restart the service', value: 'restart' },
      { label: 'Update to the latest version', value: 'update' },
      { label: 'Quit', value: null },
    ]);

    if (!choice) return 0;

    try {
      switch (choice) {
        case 'status': cmdStatus(args, opts); break;
        case 'doctor': cmdDoctor(args, opts); break;
        case 'url': cmdUrl(args, opts); break;
        case 'backup': cmdBackup(args, opts); break;
        case 'update': cmdUpdate(args, opts); break;
        case 'panel': panelInstructions(); break;
        case 'players': await playersMenu(); break;
        case 'logs':
          if (PLATFORM === 'linux') {
            run('journalctl', ['-u', 'palworld-rp-backend', '-n', '80', '--no-pager'], opts);
          } else {
            say('  Log viewing from the menu is Linux-only. See INSTALL.md.');
          }
          break;
        case 'restart':
          if (await menu.confirm('  Restart the backend now?')) {
            if (PLATFORM === 'linux') run('sudo', ['systemctl', 'restart', 'palworld-rp-backend'], opts);
            else say('  Use palworld-rp status for restart instructions on this platform.');
          }
          break;
        default: break;
      }
    } catch (err) {
      say(`\n  ${C.r}${err.message}${C.n}\n`);
    }

    // Without this the next menu redraw wipes the output that was just printed.
    if (process.stdin.isTTY) await menu.ask('\n  Press Enter to return to the menu... ');
  }
}

// ---------------------------------------------------------------------------
function optValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : null;
}

function usage() {
  say(`
${C.b}Palworld RP Backend${C.n}

  A standalone chat and roleplay-profile server for a Palworld UE4SS mod.
  The same command works on Windows, macOS and Linux.

${C.b}Usage${C.n}
  ${NPX}                     install (no trailing word needed)
  palworld-rp <command>      after installing, this is on your PATH

  Runs directly from the GitHub repository. Nothing is published to npm, and
  npx re-fetches the branch each time, so you always get current code.

  Note: writing a subcommand straight after the npx spec does not work --
  npm reads that word as the command to run rather than an argument. Once
  installed, use the "palworld-rp" command that lands on your PATH instead.

${C.b}Commands${C.n}
  install        Install or upgrade. Sets up Node, Caddy, HTTPS and a boot service.
  update         Re-run the installer against the freshly fetched repository.
  doctor         Check every layer and report what is broken. (Linux/macOS)
  status         Show whether the service is running.
  menu           Interactive menu for everything below, if you would rather
                 not memorise commands.
  url            Print the backend URL to paste into the mod.
  backup         Snapshot the data directory. (Linux/macOS)
  uninstall      Remove the service. Data is kept unless --purge-data.
  keygen         Generate the AES-256 key that goes inside the mod.

${C.b}Options${C.n}
  --domain <name>   Use your own domain instead of an automatic hostname.
  --email <addr>    Address for Let's Encrypt expiry notices.
  --purge-data      With uninstall: also delete accounts and profiles.
  --dry-run         Show what would run without running it.

${C.b}Examples${C.n}
  ${NPX}                                  first install
  ${NPX} -- install --domain rp.example.com
  palworld-rp doctor                      once installed
  palworld-rp url

  Installing needs administrator rights. On Linux and macOS this elevates
  itself with sudo. On Windows, start an Administrator PowerShell first.
`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.filter((a) => !a.startsWith('-')).length === 0) {
    say(`\n${C.b}  No command given — running install.${C.n}`);
    say(`  Run "${NPX} help" to see everything else.\n`);
  }
  const opts = { dryRun: argv.includes('--dry-run') };
  const args = argv.filter((a) => a !== '--dry-run');
  // Default to install when invoked with no command.
  //
  // This exists because of a real npx footgun: `npx <spec> install` makes npm
  // treat "install" as the COMMAND to run, not an argument. There is no bin by
  // that name, so npm falls through to PATH and runs /usr/bin/install, which
  // fails with "missing file operand". Being able to write `npx <spec>` with no
  // trailing word sidesteps the ambiguity entirely.
  const cmd = (args.shift() || 'install').toLowerCase();

  const table = {
    install: cmdInstall,
    upgrade: cmdUpdate,
    update: cmdUpdate,
    doctor: cmdDoctor,
    check: cmdDoctor,
    status: cmdStatus,
    url: cmdUrl,
    backup: cmdBackup,
    uninstall: cmdUninstall,
    remove: cmdUninstall,
    keygen: cmdKeygen,
    menu: cmdMenu,
  };

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return 0; }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    say(PKG.version);
    return 0;
  }

  const fn = table[cmd];
  if (!fn) {
    console.error(`Unknown command: ${cmd}`);
    usage();
    return 2;
  }
  return fn(args, opts);
}

// cmdMenu is async; every other command is synchronous. Supporting both keeps
// the existing commands' exit codes exact rather than making them all async.
const result = main();
if (result && typeof result.then === 'function') {
  result.then(
    (code) => process.exit(code || 0),
    (err) => { console.error(err?.message || err); process.exit(1); }
  );
} else {
  process.exit(result);
}
