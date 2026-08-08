'use strict';

/**
 * `palworld-rp menu` — an arrow-key menu over the same actions the flag-based
 * commands expose.
 *
 * No dependencies: a TUI library would be the only runtime dependency in the
 * whole CLI, and this needs about eighty lines of raw-mode input instead.
 *
 * Terminals vary more than they should. This degrades in two steps:
 *   1. Full arrow-key menu when stdin is a TTY that supports raw mode.
 *   2. A numbered prompt when it is a TTY without raw mode (some CI shells,
 *      older PowerShell hosts, `ssh` without a pty).
 *   3. A plain list and exit when there is no TTY at all, e.g. piped output,
 *      so that scripting `palworld-rp menu` cannot hang a pipeline forever.
 */

const readline = require('node:readline');

const ESC = '\x1b';
const CLEAR = `${ESC}[2J${ESC}[H`;
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;

function colours() {
  const on = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  const c = (code) => (on ? `${ESC}[${code}m` : '');
  return {
    dim: c('2'), bold: c('1'), reset: c('0'),
    cyan: c('36'), green: c('32'), yellow: c('33'), red: c('31'),
  };
}

/**
 * Render a menu and resolve with the chosen item's value, or null on cancel.
 */
function select(title, items, { hint = '' } = {}) {
  const C = colours();

  // ---- No TTY: print and leave. Never block a non-interactive caller. ----
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`\n  ${title}\n`);
    items.forEach((it, i) => console.log(`    ${i + 1}. ${it.label}`));
    console.log(
      '\n  This is not an interactive terminal, so there is nothing to select.\n' +
      '  Run the command directly instead, for example: palworld-rp status\n'
    );
    return Promise.resolve(null);
  }

  // ---- Raw mode unavailable: numbered fallback. ----
  if (typeof process.stdin.setRawMode !== 'function') {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log(`\n  ${C.bold}${title}${C.reset}\n`);
      items.forEach((it, i) => console.log(`    ${C.cyan}${i + 1}${C.reset}. ${it.label}`));
      rl.question('\n  Choose a number (or blank to go back): ', (answer) => {
        rl.close();
        const n = Number.parseInt(answer.trim(), 10);
        resolve(Number.isFinite(n) && n >= 1 && n <= items.length ? items[n - 1].value : null);
      });
    });
  }

  // ---- Full arrow-key menu. ----
  return new Promise((resolve) => {
    let cursor = 0;

    const draw = () => {
      let out = `${CLEAR}\n  ${C.bold}${title}${C.reset}\n\n`;
      items.forEach((it, i) => {
        const on = i === cursor;
        out += on
          ? `  ${C.cyan}>${C.reset} ${C.bold}${it.label}${C.reset}\n`
          : `    ${it.label}\n`;
      });
      const help = hint || 'up/down to move, Enter to choose, q to go back';
      out += `\n  ${C.dim}${help}${C.reset}\n`;
      process.stdout.write(out);
    };

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write(SHOW);
    };

    // A terminal can deliver several keypresses in ONE chunk — holding an
    // arrow key is the common case, and a fast paste is another. Comparing the
    // whole buffer against a single key would silently ignore all of them, so
    // split the chunk into individual keys first.
    const tokenize = (str) => {
      const keys = [];
      let i = 0;
      while (i < str.length) {
        if (str[i] === ESC && /^\x1b\[[A-D]/.test(str.slice(i))) {
          keys.push(str.slice(i, i + 3));
          i += 3;
        } else {
          keys.push(str[i]);
          i += 1;
        }
      }
      return keys;
    };

    const onData = (buf) => {
      let dirty = false;

      for (const key of tokenize(buf.toString())) {
        // Ctrl-C must always work, even mid-menu. In raw mode the terminal no
        // longer raises SIGINT for us, so it is handled by hand or the menu
        // becomes impossible to escape.
        if (key === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (key === 'q' || key === ESC) {
          cleanup();
          process.stdout.write(CLEAR);
          return resolve(null);
        }
        if (key === '\r' || key === '\n') {
          cleanup();
          process.stdout.write(CLEAR);
          return resolve(items[cursor].value);
        }
        if (key === `${ESC}[A` || key === 'k') {
          cursor = (cursor - 1 + items.length) % items.length;
          dirty = true;
        } else if (key === `${ESC}[B` || key === 'j') {
          cursor = (cursor + 1) % items.length;
          dirty = true;
        } else if (/^[1-9]$/.test(key)) {
          const n = Number(key) - 1;
          if (n < items.length) {
            cursor = n;
            cleanup();
            process.stdout.write(CLEAR);
            return resolve(items[n].value);
          }
        }
      }

      // Redraw once after the whole chunk, not once per key, so holding an
      // arrow key does not flood the terminal with frames.
      if (dirty) draw();
      return undefined;
    };

    process.stdout.write(HIDE);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    draw();
  });
}

/** Free-text prompt, used for ban reasons and player names. */
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function confirm(question) {
  const answer = await ask(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer);
}

module.exports = { select, ask, confirm, colours };
