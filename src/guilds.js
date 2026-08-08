'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const config = require('./config');
const log = require('./log');
const store = require('./store');
const { safeJoin, ValidationError } = require('./validate');

/**
 * Guilds.
 *
 * The previous design took `guildId` straight from the client's registration
 * packet, which meant guild chat was joinable by anyone who could guess or
 * observe a guild's ID — not much of a private channel.
 *
 * Our backend cannot verify Palworld's real in-game guild membership (the game
 * server never talks to us; that is the whole point of the design). So guilds
 * here are backend-side objects with a join passcode: a guild leader creates
 * one and shares the passcode with their members the same way they would share
 * a Discord invite. Membership is then recorded on the account, server-side,
 * and the client cannot assert it.
 */

const guildsDir = path.join(config.dataDir, 'guilds');

/** name -> { name, salt, hash, owner, createdAt, memberCount } */
const guilds = new Map();

function guildPath(name) {
  return safeJoin(guildsDir, name, '.guild');
}

async function persist(guild) {
  await store.writeFileAtomic(
    guildPath(guild.name),
    JSON.stringify(
      {
        name: guild.name,
        salt: guild.salt,
        hash: guild.hash,
        owner: guild.owner,
        createdAt: guild.createdAt,
      },
      null,
      2
    )
  );
}

function get(name) {
  return guilds.get(name) || null;
}

function exists(name) {
  return guilds.has(name);
}

async function create(name, passcode, ownerName) {
  if (guilds.has(name)) {
    throw new ValidationError('A guild with that name already exists.', 409);
  }
  const { salt, hash } = await store.hashPassword(passcode);
  const guild = { name, salt, hash, owner: ownerName, createdAt: Date.now() };
  guilds.set(name, guild);
  try {
    await persist(guild);
  } catch (err) {
    guilds.delete(name);
    throw err;
  }
  return guild;
}

async function verifyPasscode(name, passcode) {
  const guild = guilds.get(name) || null;
  // store.verifyPassword runs a dummy hash for a missing guild so that probing
  // for guild existence by response timing does not work.
  return store.verifyPassword(passcode, guild);
}

async function destroy(name) {
  if (!guilds.delete(name)) return false;
  await fsp.rm(guildPath(name), { force: true }).catch(() => {});
  return true;
}

function list() {
  return [...guilds.values()].map((g) => ({
    name: g.name,
    owner: g.owner,
    createdAt: g.createdAt,
  }));
}

async function init() {
  await fsp.mkdir(guildsDir, { recursive: true, mode: 0o700 });
  const files = await fsp.readdir(guildsDir).catch(() => []);
  for (const file of files) {
    if (!file.endsWith('.guild')) continue;
    try {
      const data = JSON.parse(await fsp.readFile(path.join(guildsDir, file), 'utf8'));
      guilds.set(data.name, data);
    } catch (err) {
      log.error('Skipping unreadable guild file', { file, err: err.message });
    }
  }
  log.info('Guilds ready', { count: guilds.size });
}

module.exports = { init, create, get, exists, verifyPasscode, destroy, list, guildsDir };
