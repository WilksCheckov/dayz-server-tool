'use strict';
// Built-in Discord bot, modelled on the standalone DayZ whitelist bot:
//  - whitelist applications (button -> modal -> admin embed with Accept/Decline, Steam VAC check, role + nickname)
//  - permanent/temporary bans with reasons, Discord ban/timeout, auto-expiry, Unban button
//  - slash commands for whitelist/priority/ban lists, players, kick, say, status, server control, backups
//  - presence showing online/offline and the live player count, optional action log and live log streaming
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
  ButtonBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType, AttachmentBuilder, ChannelType } = require('discord.js');
const PFB = PermissionFlagsBits;
const { app } = require('electron');
const settings = require('./settings');
const lists = require('./lists');
const rcon = require('./rcon');
const server = require('./server');
const backups = require('./backups');
const scheduler = require('./scheduler');
const mods = require('./mods');

let emitRef = () => {};
let client = null;
let state = { running: false, tag: null, appId: null, guildName: null, error: null, commands: 0, startedAt: null, presence: null, playersOnline: null, liveLogPosted: 0 };
const log = [];

function cfg() {
  const s = settings.load();
  return {
    token: '', guildId: '', adminRoleIds: [], adminChannelId: '', whitelistRoleId: '', priorityRoleId: '', bannedRoleId: '', mutedRoleId: '', steamApiKey: '',
    statusFormat: 'Server Online | {count}/{max} Players', offlineStatus: 'Server Offline',
    logChannelId: '', autoStart: false, liveLogChannelId: '', liveLogKinds: ['adm'], liveLogErrorsOnly: false,
    ticketCategoryId: '', ticketLogChannelId: '', killFeedChannelId: '', joinFeedChannelId: '', deathLogChannelId: '', summaryChannelId: '', summaryTime: '09:00',
    ...(s.discord || {})
  };
}

function status() {
  const c = cfg();
  return { ...state, log: log.slice(-60), config: { ...c, token: c.token ? '••••' + c.token.slice(-4) : '' }, hasToken: !!c.token,
    inviteUrl: state.appId ? `https://discord.com/oauth2/authorize?client_id=${state.appId}&scope=bot%20applications.commands&permissions=1101659225094` : null,
    store: { applications: Object.keys(store().applications).length, bans: store().bans.filter(b => b.status === 'banned').length, tickets: (store().tickets || []).filter(t => t.status === 'open').length } };
}

function addLog(line) {
  log.push({ at: Date.now(), line });
  if (log.length > 300) log.shift();
  emitRef('console', { source: 'discord', line });
  emitRef('discord:state', status());
}

// ---------- local data store (replaces the old bot's MySQL tables) ----------
let storeCache = null;
function storeFile() { return path.join(app.getPath('userData'), 'discord-data.json'); }
function store() {
  if (storeCache) return storeCache;
  try { storeCache = { applications: {}, bans: [], mutes: [], tickets: [], ...JSON.parse(fs.readFileSync(storeFile(), 'utf8')) }; }
  catch { storeCache = { applications: {}, bans: [], mutes: [], tickets: [] }; }
  return storeCache;
}
function saveStore() { fs.writeFileSync(storeFile(), JSON.stringify(store(), null, 2)); }
function activeBanFor(discordId, steamId) {
  return store().bans.find(b => b.status === 'banned' && ((discordId && b.discordId === discordId) || (steamId && b.steamId === steamId)));
}

// ---------- Steam lookups (VAC / trade bans, profile privacy) ----------
async function getSteamInfo(steamid64) {
  const key = cfg().steamApiKey;
  if (!key) return null;
  try { const r = await require('./steambans').check(steamid64); if (r) return r; } catch { /* fall through */ }
  try {
    const [b, s] = await Promise.all([
      fetch(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${key}&steamids=${steamid64}`).then(r => r.json()),
      fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${key}&steamids=${steamid64}`).then(r => r.json())
    ]);
    const bans = b && b.players && b.players[0], sum = s && s.response && s.response.players && s.response.players[0];
    if (!bans || !sum) return null;
    return { vacBanned: bans.VACBanned, vacBans: bans.NumberOfVACBans, gameBans: bans.NumberOfGameBans, tradeBanned: bans.EconomyBan !== 'none', communityBanned: !!bans.CommunityBanned, isPrivate: sum.communityvisibilitystate !== 3, personaName: sum.personaname };
  } catch { return null; }
}

// ---------- command definitions ----------
function buildCommands() {
  const idOpt = (o, d = 'Steam64 ID or DayZ ID') => o.setName('id').setDescription(d);
  const userOpt = o => o.setName('discord_user').setDescription('Discord member (uses their whitelist application to find the Steam64)');
  const nameOpt = o => o.setName('name').setDescription('Player name (for your records)');
  const reasonOpt = o => o.setName('reason').setDescription('Reason');
  const listGroup = (name, desc, idDesc) => new SlashCommandBuilder().setName(name).setDescription(desc)
    .addSubcommand(s => s.setName('add').setDescription(`Add to the ${name}`).addStringOption(o => idOpt(o, idDesc)).addUserOption(userOpt).addStringOption(nameOpt).addStringOption(reasonOpt))
    .addSubcommand(s => s.setName('remove').setDescription(`Remove from the ${name}`).addStringOption(o => idOpt(o, idDesc)).addUserOption(userOpt))
    .addSubcommand(s => s.setName('list').setDescription(`Show the ${name}`));
  return [
    new SlashCommandBuilder().setName('help').setDescription('Show the available commands').setDefaultMemberPermissions(null),
    new SlashCommandBuilder().setName('bantime').setDescription('Check the time remaining on your own ban').setDefaultMemberPermissions(null),
    new SlashCommandBuilder().setName('application').setDescription('Post the whitelist application button in this channel'),
    listGroup('whitelist', 'Manage whitelist.txt', 'Steam64 ID'),
    listGroup('priority', 'Manage priority.txt (login queue skip)', 'Steam64 ID'),
    new SlashCommandBuilder().setName('mute').setDescription('Discord mute: gives the muted role for a while')
      .addSubcommand(s => s.setName('add').setDescription('Mute a member').addUserOption(o => o.setName('discord_user').setDescription('Member').setRequired(true)).addStringOption(o => o.setName('duration').setDescription('e.g. 30m, 2h, 3d (blank = until removed)')).addStringOption(reasonOpt))
      .addSubcommand(s => s.setName('remove').setDescription('Unmute a member').addUserOption(o => o.setName('discord_user').setDescription('Member').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('Show active mutes')),
    new SlashCommandBuilder().setName('ban').setDescription('Ban management')
      .addSubcommand(s => s.setName('permanent').setDescription('Permanently ban a player (game ban + Discord ban, whitelist removed)').addStringOption(o => o.setName('steamid64').setDescription("The player's SteamID64")).addUserOption(userOpt))
      .addSubcommand(s => s.setName('temporary').setDescription('Temporarily ban a player (game ban + Discord timeout) until the ban expires').addIntegerOption(o => o.setName('duration_days').setDescription('How many days').setRequired(true).setMinValue(1)).addStringOption(o => o.setName('steamid64').setDescription("The player's SteamID64")).addUserOption(userOpt))
      .addSubcommand(s => s.setName('battleye').setDescription('BattlEye ban by GUID or IP (live via RCon when connected)').addStringOption(o => o.setName('guid').setDescription('BE GUID or IP').setRequired(true)).addIntegerOption(o => o.setName('minutes').setDescription('0 = permanent').setMinValue(0)).addStringOption(reasonOpt))
      .addSubcommand(s => s.setName('remove').setDescription('Lift a ban and restore whitelist access').addStringOption(o => o.setName('steamid64').setDescription('SteamID64 / DayZ ID / BE GUID')).addUserOption(userOpt))
      .addSubcommand(s => s.setName('list').setDescription('Show current bans')),
    new SlashCommandBuilder().setName('search').setDescription('Everything the bot knows about a player').addUserOption(userOpt).addStringOption(o => o.setName('steamid64').setDescription('SteamID64')).addStringOption(o => o.setName('character_name').setDescription('Character name')),
    new SlashCommandBuilder().setName('players').setDescription('Show online players (needs RCon)'),
    new SlashCommandBuilder().setName('kick').setDescription('Kick an online player (needs RCon)').addStringOption(o => o.setName('player').setDescription('Player number or name').setRequired(true)).addStringOption(reasonOpt),
    new SlashCommandBuilder().setName('say').setDescription('Broadcast a message in-game (needs RCon)').addStringOption(o => o.setName('message').setDescription('Message').setRequired(true)),
    new SlashCommandBuilder().setName('status').setDescription('Server status').setDefaultMemberPermissions(null),
    new SlashCommandBuilder().setName('server').setDescription('Control the server')
      .addSubcommand(s => s.setName('start').setDescription('Start the server'))
      .addSubcommand(s => s.setName('stop').setDescription('Stop the server'))
      .addSubcommand(s => s.setName('restart').setDescription('Restart the server (warns players if RCon is connected)')),
    new SlashCommandBuilder().setName('ticketpanel').setDescription('Post the "Open a ticket" button in this channel'),
    new SlashCommandBuilder().setName('ticket').setDescription('Support tickets')
      .addSubcommand(s => s.setName('close').setDescription('Close the ticket this channel belongs to').addStringOption(reasonOpt))
      .addSubcommand(s => s.setName('add').setDescription('Add a member to this ticket').addUserOption(o => o.setName('discord_user').setDescription('Member').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('Show open tickets')),
    new SlashCommandBuilder().setName('maintenance').setDescription('Re-check everyone against Steam for VAC / game / trade bans and refresh the application embeds'),
    new SlashCommandBuilder().setName('backup').setDescription('Take a backup now'),
    new SlashCommandBuilder().setName('deaths').setDescription('Recent deaths from the death log').addStringOption(o => o.setName('player').setDescription('Player name, or part of it')).addIntegerOption(o => o.setName('count').setDescription('How many (default 10, max 25)')),
    new SlashCommandBuilder().setName('death').setDescription('Full detail of one death: hits, body parts, gear').addIntegerOption(o => o.setName('id').setDescription('Death record number (see /deaths)').setRequired(true)),
    new SlashCommandBuilder().setName('heal').setDescription('Heal an online player: health, bleeding, broken bones, diseases, food and water').addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true)).addStringOption(o => o.setName('what').setDescription('What to fix (default: everything)').addChoices({ name: 'everything', value: 'all' }, { name: 'health, blood and shock', value: 'health' }, { name: 'bleeding and cuts', value: 'bleeding' }, { name: 'broken bones', value: 'bones' }, { name: 'diseases and infections', value: 'cure' }, { name: 'food and water', value: 'food' })),
    new SlashCommandBuilder().setName('teleport').setDescription('Teleport an online player back to where they died, or to coordinates').addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true)).addIntegerOption(o => o.setName('death_id').setDescription('Death record number (see /deaths); default: their latest death')).addNumberOption(o => o.setName('x').setDescription('X coordinate (with z: go there instead of the death position)')).addNumberOption(o => o.setName('z').setDescription('Z coordinate')),
    new SlashCommandBuilder().setName('refund').setDescription('Spawn the gear a player had when they died at their feet (they must be online)').addIntegerOption(o => o.setName('id').setDescription('Death record number (see /deaths); default: the player\'s latest death')).addStringOption(o => o.setName('player').setDescription('Player name, used when no id is given'))
  ].map(c => { const j = c.setDMPermission(false).toJSON(); if (j.default_member_permissions === undefined) j.default_member_permissions = String(PermissionFlagsBits.Administrator); return j; });
}

const PUBLIC_COMMANDS = ['help', 'bantime', 'status'];

// ---------- helpers ----------
function isAllowed(interaction) {
  const c = cfg();
  const m = interaction.member;
  if (!m) return false;
  if (m.permissions && m.permissions.has && m.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const roles = m.roles && m.roles.cache ? [...m.roles.cache.keys()] : (Array.isArray(m.roles) ? m.roles : []);
  return (c.adminRoleIds || []).some(r => roles.includes(String(r).trim()));
}

function fmtList(title, entries, mapper) {
  const lines = entries.map(mapper);
  const text = lines.length ? lines.slice(0, 40).join('\n') + (lines.length > 40 ? `\n…and ${lines.length - 40} more` : '') : '(empty)';
  return new EmbedBuilder().setTitle(`${title} (${entries.length})`).setDescription('```\n' + text + '\n```').setColor(0x4f8cff);
}

async function resolvePlayer(ref) {
  const { players } = await rcon.players();
  const byNum = /^\d+$/.test(ref) ? players.find(p => p.num === Number(ref)) : null;
  return byNum || players.find(p => p.name.toLowerCase() === ref.toLowerCase()) || players.find(p => p.name.toLowerCase().includes(ref.toLowerCase())) || null;
}

async function channel(id) {
  if (!client || !id) return null;
  try { const ch = await client.channels.fetch(id); return ch && ch.isTextBased() ? ch : null; } catch { return null; }
}
async function postAlert({ title, description, color, channelId }) {
  const ch = await channel(channelId || cfg().logChannelId);
  if (!ch) throw new Error('no channel');
  await ch.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(String(description || '-').slice(0, 4000)).setColor(color || 0x4f8cff).setTimestamp(new Date())] });
}
async function postLog(text) { const ch = await channel(cfg().logChannelId); if (ch) ch.send(text).catch(() => {}); }
async function guild() { try { return client ? await client.guilds.fetch(cfg().guildId) : null; } catch { return null; } }
async function member(discordId) { const g = await guild(); if (!g || !discordId) return null; return g.members.fetch(discordId).catch(() => null); }

// Resolve a {steamId, discordId, name} from whatever the caller gave: id/steamid64 string or a Discord user.
function resolveTarget(opt) {
  const apps = store().applications;
  let steamId = (opt.steamid64 || opt.id || '').trim() || null;
  let discordId = opt.discord_user || null;
  let rec = null;
  if (discordId && apps[discordId]) rec = apps[discordId];
  else if (steamId) rec = Object.values(apps).find(a => a.steamId === steamId) || null;
  if (rec) { steamId = steamId || rec.steamId; discordId = discordId || rec.discordId; }
  return { steamId, discordId, name: opt.name || (rec && rec.characterName) || '', rec };
}

// ---------- roles ----------
async function setRole(discordId, roleId, on) {
  if (!discordId || !roleId) return;
  const m = await member(discordId); if (!m) return;
  const has = m.roles.cache.has(roleId);
  if (on && !has) await m.roles.add(roleId).catch(e => addLog(`Could not add role ${roleId} to ${discordId}: ${e.message}`));
  if (!on && has) await m.roles.remove(roleId).catch(e => addLog(`Could not remove role ${roleId} from ${discordId}: ${e.message}`));
}
function parseDuration(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d+)\s*([mhdw]?)$/i); if (!m) return null;
  const n = Number(m[1]); const unit = (m[2] || 'm').toLowerCase();
  return n * { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
}
async function muteUser({ discordId, durationMs, reason, by }) {
  const c = cfg();
  if (!c.mutedRoleId) throw new Error('No muted role configured on the Discord Bot page.');
  const until = durationMs ? Date.now() + durationMs : null;
  store().mutes = (store().mutes || []).filter(x => x.discordId !== discordId);
  store().mutes.push({ discordId, until, reason: reason || '', by: by || null, at: Date.now() });
  saveStore();
  await setRole(discordId, c.mutedRoleId, true);
  const m = await member(discordId); if (m) m.send(`You have been muted${until ? ` until <t:${Math.floor(until / 1000)}:F>` : ''}${reason ? `. Reason: ${reason}` : '.'}`).catch(() => {});
}
async function unmuteUser({ discordId, by }) {
  const c = cfg();
  const had = (store().mutes || []).some(x => x.discordId === discordId);
  store().mutes = (store().mutes || []).filter(x => x.discordId !== discordId); saveStore();
  await setRole(discordId, c.mutedRoleId, false);
  if (had) { const m = await member(discordId); if (m) m.send('You have been unmuted.').catch(() => {}); }
  return had;
}
// Keep Discord roles in step with the lists, wherever a change was made (app, bot, or the files themselves).
let syncing = false;
async function syncRoles() {
  if (syncing || !client || !state.running) return;
  syncing = true;
  try {
    const c = cfg();
    const now = Date.now();
    for (const mu of (store().mutes || []).filter(x => x.until && x.until <= now)) { await unmuteUser({ discordId: mu.discordId, by: 'System (Mute expired)' }); addLog(`Mute expired for ${mu.discordId}`); }
    if (!c.whitelistRoleId && !c.priorityRoleId && !c.bannedRoleId) return;
    const apps = Object.values(store().applications);
    const activeBans = store().bans.filter(b => b.status === 'banned');
    const seen = new Set();
    for (const a of apps) {
      if (!a.discordId || seen.has(a.discordId)) continue; seen.add(a.discordId);
      const banned = activeBans.some(b => b.discordId === a.discordId || b.steamId === a.steamId);
      if (c.whitelistRoleId) await setRole(a.discordId, c.whitelistRoleId, !banned && lists.has('whitelist', a.steamId));
      if (c.priorityRoleId) await setRole(a.discordId, c.priorityRoleId, !banned && lists.has('priority', a.steamId));
      if (c.bannedRoleId) await setRole(a.discordId, c.bannedRoleId, banned);
    }
    // bans on people without an application (banned by Steam64 + Discord user)
    for (const b of activeBans) if (b.discordId && !seen.has(b.discordId) && c.bannedRoleId) { seen.add(b.discordId); await setRole(b.discordId, c.bannedRoleId, true); }
  } catch (e) { addLog('Role sync error: ' + e.message); }
  finally { syncing = false; }
}

// ---------- tickets (simplified: one private channel per ticket, transcript on close) ----------
function ticketById(id) { return (store().tickets || []).find(t => t.id === id); }
function ticketByChannel(channelId) { return (store().tickets || []).find(t => t.channelId === channelId && t.status === 'open'); }
async function openTicket({ discordId, subject, description }) {
  const c = cfg(); const g = await guild();
  if (!g) throw new Error('Bot is not in the guild.');
  if (!c.ticketCategoryId) throw new Error('No ticket category configured. Ask the server staff.');
  const open = (store().tickets || []).filter(t => t.discordId === discordId && t.status === 'open');
  if (open.length >= 2) throw new Error('You already have two open tickets. Close one first.');
  store().tickets = store().tickets || [];
  const id = String((store().ticketSeq || 0) + 1).padStart(4, '0'); store().ticketSeq = (store().ticketSeq || 0) + 1;
  const overwrites = [
    { id: g.roles.everyone.id, deny: [PFB.ViewChannel] },
    { id: discordId, allow: [PFB.ViewChannel, PFB.SendMessages, PFB.ReadMessageHistory, PFB.AttachFiles] },
    { id: client.user.id, allow: [PFB.ViewChannel, PFB.SendMessages, PFB.ManageChannels, PFB.ReadMessageHistory] },
    ...(c.adminRoleIds || []).filter(Boolean).map(r => ({ id: String(r).trim(), allow: [PFB.ViewChannel, PFB.SendMessages, PFB.ReadMessageHistory, PFB.AttachFiles] }))
  ];
  const m = await member(discordId);
  const ch = await g.channels.create({ name: `ticket-${id}-${(m ? m.displayName : 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)}`, type: ChannelType.GuildText, parent: c.ticketCategoryId, permissionOverwrites: overwrites, topic: `Ticket #${id} · ${subject}` });
  const t = { id, channelId: ch.id, discordId, subject, description, status: 'open', createdAt: new Date().toISOString() };
  store().tickets.push(t); saveStore(); emitRef('discord:state', status());
  const embed = new EmbedBuilder().setColor(0x4f8cff).setTitle(`Ticket #${id}: ${subject}`).setDescription(description || '-').addFields({ name: 'Opened by', value: `<@${discordId}>`, inline: true }, { name: 'Opened', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true }).setFooter({ text: 'Staff will reply here. Use the button or /ticket close when it is solved.' });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle('Danger').setCustomId(`ticketclose-${id}`).setLabel('Close ticket'));
  await ch.send({ content: `<@${discordId}>${(c.adminRoleIds || []).length ? ' ' + c.adminRoleIds.map(r => `<@&${String(r).trim()}>`).join(' ') : ''}`, embeds: [embed], components: [row] });
  addLog(`Ticket #${id} opened by ${discordId}: ${subject}`); postLog(`🎫 Ticket #${id} opened by <@${discordId}>: ${subject}`);
  return t;
}
async function closeTicket(id, { by, reason } = {}) {
  const t = ticketById(id); if (!t || t.status !== 'open') return null;
  const c = cfg(); const ch = await channel(t.channelId);
  let transcript = `Ticket #${t.id}: ${t.subject}\nOpened by ${t.discordId} at ${t.createdAt}\nClosed by ${by || 'unknown'} at ${new Date().toISOString()}${reason ? ' — ' + reason : ''}\n\n${t.description || ''}\n\n--- messages ---\n`;
  if (ch) {
    try {
      const msgs = []; let before;
      for (let i = 0; i < 10; i++) { const batch = await ch.messages.fetch({ limit: 100, before }); if (!batch.size) break; msgs.push(...batch.values()); before = batch.last().id; if (batch.size < 100) break; }
      msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const m of msgs) transcript += `[${new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19)}] ${m.author.tag}: ${m.content || ''}${m.attachments.size ? ' ' + [...m.attachments.values()].map(a => a.url).join(' ') : ''}${m.embeds.length && !m.content ? ' [embed]' : ''}\n`;
    } catch (e) { transcript += `(could not read messages: ${e.message})\n`; }
  }
  t.status = 'closed'; t.closedAt = new Date().toISOString(); t.closedBy = by || null; t.closeReason = reason || ''; saveStore(); emitRef('discord:state', status());
  const log = await channel(c.ticketLogChannelId || c.logChannelId);
  if (log) await log.send({ content: `🎫 Ticket #${t.id} (${t.subject}) closed by ${by ? `<@${by}>` : 'unknown'}${reason ? `: ${reason}` : ''}`, files: [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: `ticket-${t.id}.txt` })] }).catch(() => {});
  const m = await member(t.discordId); if (m) m.send(`Your ticket #${t.id} (${t.subject}) was closed${reason ? ': ' + reason : '.'}`).catch(() => {});
  if (ch) { await ch.send('This ticket is closed. The channel will be deleted in 10 seconds.').catch(() => {}); setTimeout(() => ch.delete('Ticket closed').catch(() => {}), 10000); }
  addLog(`Ticket #${t.id} closed by ${by || '?'}`);
  return t;
}
async function canTouchTicket(interaction, t) { return isAllowed(interaction) || (t && t.discordId === interaction.user.id); }

// ---------- kill / join feeds from the admin log ----------
const feedQueue = {}; let feedTimer = null;
function deathLine(r) {
  const range = r.distance !== null && r.distance !== undefined ? ` from ${Math.round(r.distance)} m` : '';
  return r.cause === 'player' && r.killer ? `killed by **${r.killer.name}**${r.weapon ? ` with ${r.weapon}` : ''}${range}${r.finalPart ? ` (${r.finalPart})` : ''}` : r.causeText;
}
function deathEmbed(r) {
  const e = new EmbedBuilder().setColor(r.cause === 'player' ? 0x8b0000 : 0x6b7280).setTitle(`Death #${r.id}: ${r.name}`).setDescription(deathLine(r)).setTimestamp(new Date(r.ts));
  const parts = Object.entries(r.byPart || {}).sort((a, b) => b[1].damage - a[1].damage).map(([p, v]) => `${p}: ${v.hits} hit${v.hits === 1 ? '' : 's'}, ${Math.round(v.damage)} dmg`).join('\n');
  if (parts) e.addFields({ name: `Damage by body part (${r.hits.length} hits, ${Math.round(r.totalDamage)} total)`, value: parts.slice(0, 1000) });
  if (r.attackers && r.attackers.length > 1) e.addFields({ name: 'Attackers', value: r.attackers.map(a => `${a.name}: ${a.hits} hits, ${Math.round(a.damage)} dmg`).join('\n').slice(0, 1000) });
  if (r.gear && r.gear.length) { const counts = {}; for (const g of r.gear) counts[g.c] = (counts[g.c] || 0) + 1; e.addFields({ name: `Gear (${r.gear.length} items, ${r.gearFromCorpse ? 'from the body' : 'last snapshot before death'})`, value: Object.entries(counts).map(([c, n]) => n > 1 ? `${c} ×${n}` : c).join(', ').slice(0, 1000) }); }
  else e.addFields({ name: 'Gear', value: 'No snapshot (bridge script not running when they died)' });
  if (r.refunds && r.refunds.length) e.addFields({ name: 'Refunds', value: r.refunds.map(f => `<t:${Math.floor(f.ts / 1000)}:R> by ${f.by}: ${f.ok}/${f.items} items`).join('\n').slice(0, 1000) });
  e.setFooter({ text: `/refund id:${r.id} spawns this gear at the player's feet while they are online` });
  return e;
}
async function postDeath(r) { const c = cfg(); if (!state.running || !c.deathLogChannelId || !r) return; const ch = await channel(c.deathLogChannelId); if (ch) ch.send({ embeds: [deathEmbed(r)] }).catch(() => {}); }
function feedEvent(ev) {
  if (!client || !state.running || !ev || !ev.type) return;
  if (ev.ts < Date.now() - 2 * 60 * 1000) return; // replayed history, not live
  const c = cfg();
  let line = null, chId = null;
  if (ev.type === 'kill') { chId = c.killFeedChannelId; line = `☠️ **${ev.killer.name}** killed **${ev.name}**${ev.weapon ? ` with ${ev.weapon}` : ''}`; }
  else if (ev.type === 'death') { chId = c.killFeedChannelId; line = `💀 **${ev.name}** died${/bled out/i.test(ev.body || '') ? ' (bled out)' : /suicide/i.test(ev.body || '') ? ' (suicide)' : ''}`; }
  else if (ev.type === 'connect') { chId = c.joinFeedChannelId; line = `🟢 **${ev.name}** joined`; }
  else if (ev.type === 'disconnect') { chId = c.joinFeedChannelId; line = `🔴 **${ev.name}** left`; }
  if (!chId || !line) return;
  (feedQueue[chId] = feedQueue[chId] || []).push(line);
  if (!feedTimer) feedTimer = setTimeout(flushFeeds, 4000);
}
async function flushFeeds() {
  feedTimer = null;
  for (const [chId, lines] of Object.entries(feedQueue)) {
    delete feedQueue[chId];
    const ch = await channel(chId); if (!ch) continue;
    let chunk = '';
    for (const l of lines) { if (chunk.length + l.length + 1 > 1900) { await ch.send(chunk).catch(() => {}); chunk = ''; } chunk += (chunk ? '\n' : '') + l; }
    if (chunk) await ch.send(chunk).catch(() => {});
  }
}

// ---------- whitelist application flow ----------
async function applyWhitelist({ steamId, discordId, name, reviewerId }) {
  lists.add('whitelist', { id: steamId, discordId, name }, { name, note: reviewerId ? `accepted by ${reviewerId}` : '' });
  const m = await member(discordId);
  const c = cfg();
  if (m && c.whitelistRoleId) m.roles.add(c.whitelistRoleId).catch(e => addLog(`Could not add whitelist role: ${e.message}`));
  if (m && name) m.setNickname(name).catch(() => {});
}
async function revokeWhitelist({ steamId, discordId }) {
  if (steamId) lists.remove('whitelist', steamId);
  if (discordId) lists.remove('whitelist', discordId);
  const m = await member(discordId);
  const c = cfg();
  if (m && c.whitelistRoleId) m.roles.remove(c.whitelistRoleId).catch(() => {});
}

function steamFields(steamInfo) {
  const u = v => v === null || v === undefined ? 'Unknown' : v;
  return [
    { name: 'VAC Ban', value: steamInfo ? (steamInfo.vacBanned ? `Yes (${steamInfo.vacBans})` : 'No') : 'Unknown (no Steam API key)', inline: true },
    { name: 'Trade Ban', value: steamInfo ? (steamInfo.tradeBanned ? 'Yes' : 'No') : u(null), inline: true },
    { name: 'Ban Count', value: steamInfo ? String((steamInfo.vacBans || 0) + (steamInfo.gameBans || 0)) + (steamInfo.communityBanned ? ' (+community ban)' : '') : u(null), inline: true },
    { name: 'Profile Privacy', value: steamInfo ? (steamInfo.isPrivate ? 'Private' : 'Public') : u(null), inline: true }];
}
// Re-read the stored Steam ban result for every application and update the fields on its embed (the old bot's /maintenance).
async function refreshApplicationEmbeds() {
  if (!client || !state.running) return { updated: 0 };
  const c = cfg(); const ch = await channel(c.adminChannelId); if (!ch) return { updated: 0 };
  const sb = require('./steambans'); let updated = 0;
  for (const a of Object.values(store().applications)) {
    if (!a.messageId) continue;
    const info = sb.get(a.steamId); if (!info) continue;
    const msg = await ch.messages.fetch(a.messageId).catch(() => null);
    if (!msg || !msg.embeds[0]) continue;
    const map = Object.fromEntries(steamFields(info).map(f => [f.name, f]));
    const fields = (msg.embeds[0].fields || []).map(f => map[f.name] ? { ...map[f.name], inline: f.inline } : f);
    for (const f of Object.values(map)) if (!fields.some(x => x.name === f.name)) fields.push(f);
    const changed = JSON.stringify(fields) !== JSON.stringify(msg.embeds[0].fields || []);
    if (!changed) continue;
    const embed = EmbedBuilder.from(msg.embeds[0]).setFields(fields);
    if (sb.flagged(info) && a.status === 'accepted') embed.setColor(0xf5b942);
    await msg.edit({ embeds: [embed] }).catch(() => {}); updated++;
  }
  if (updated) addLog(`Maintenance: refreshed Steam ban fields on ${updated} application(s)`);
  return { updated };
}
// Which of the configured roles each Discord member currently holds. Used by the player database.
async function rolesFor(discordIds) {
  const c = cfg(); const out = {};
  if (!client || !state.running) return out;
  for (const id of discordIds) {
    const m = await member(id);
    if (!m) { out[id] = { member: false }; continue; }
    const has = r => !!(r && m.roles.cache.has(r));
    out[id] = { member: true, whitelist: c.whitelistRoleId ? has(c.whitelistRoleId) : null, priority: c.priorityRoleId ? has(c.priorityRoleId) : null, banned: c.bannedRoleId ? has(c.bannedRoleId) : null, muted: c.mutedRoleId ? has(c.mutedRoleId) : null };
  }
  return out;
}
function applicationEmbed(interaction, { steamId, character, biography, bansText, rules, steamInfo }) {
  const u = v => v === null || v === undefined ? 'Unknown' : v;
  return new EmbedBuilder().setColor(0x4f8cff)
    .setAuthor({ name: `${interaction.member.displayName}'s Application`, iconURL: interaction.member.displayAvatarURL() })
    .setDescription(`**Biography:**\n${biography}`)
    .addFields(
      { name: 'Discord User', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'SteamID64', value: steamId, inline: true },
      { name: 'Character Name', value: character, inline: true },
      { name: 'User Reported Bans', value: bansText || '-', inline: true },
      { name: 'Accepted Rules', value: rules || '-', inline: true },
      ...steamFields(steamInfo));
}
const acceptedRow = (steamId, discordId) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setStyle('Danger').setCustomId(`remove-${steamId}-${discordId}`).setLabel('Remove From Whitelist'),
  new ButtonBuilder().setStyle('Danger').setCustomId(`banperm-${steamId}-${discordId}`).setLabel('Ban (Permanent)'),
  new ButtonBuilder().setStyle('Danger').setCustomId(`bantemp-${steamId}-${discordId}`).setLabel('Ban (Temporary)'),
  new ButtonBuilder().setStyle('Link').setLabel('Steam Profile').setURL(`https://steamcommunity.com/profiles/${steamId}`));

// ---------- ban flow ----------
async function banUser({ steamId, discordId, reason, bannedBy, expiresAt, name }) {
  if (!steamId) throw new Error('No SteamID64 known for that player.');
  await revokeWhitelist({ steamId, discordId });
  lists.add('ban', { id: steamId, discordId, name, reason }, { name, note: reason });
  if (discordId) await setRole(discordId, cfg().bannedRoleId, true);
  const m = await member(discordId);
  if (m) m.send(`You have been banned. Reason: ${reason}${expiresAt ? ` (expires <t:${Math.floor(new Date(expiresAt) / 1000)}:F>)` : ''}`).catch(() => {});
  const g = await guild();
  if (discordId && g) {
    if (!expiresAt) g.members.ban(discordId, { reason: `Permanently banned: ${reason}` }).catch(e => addLog(`Discord ban failed: ${e.message}`));
    else if (m) { const ms = Math.min(new Date(expiresAt) - Date.now(), 28 * 86400000); if (ms > 0) m.timeout(ms, `Temporarily banned: ${reason}`).catch(() => {}); }
  }
  const embed = new EmbedBuilder().setColor(0x8b0000).setTitle('Player Banned').addFields(
    { name: 'Discord User', value: discordId ? `<@${discordId}>` : 'Unknown', inline: true },
    { name: 'SteamID64', value: steamId, inline: true },
    { name: 'Banned By', value: bannedBy ? `<@${bannedBy}>` : 'Admin tool', inline: true },
    { name: 'Reason', value: reason || '-' },
    { name: 'Expires', value: expiresAt ? `<t:${Math.floor(new Date(expiresAt) / 1000)}:F>` : 'Never (permanent)', inline: true });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle('Success').setCustomId(`unban-${steamId}-${discordId || '0'}`).setLabel('Unban'));
  const ch = await channel(cfg().adminChannelId);
  let msg = null;
  if (ch) msg = await ch.send({ embeds: [embed], components: [row] }).catch(() => null);
  store().bans.push({ messageId: msg ? msg.id : null, steamId, discordId: discordId || null, reason, bannedBy: bannedBy || null, bannedAt: new Date().toISOString(), expiresAt: expiresAt || null, status: 'banned', name: name || '' });
  if (discordId && store().applications[discordId]) store().applications[discordId].status = 'banned';
  saveStore();
  emitRef('discord:state', status());
}

async function unbanUser({ steamId, discordId, unbannedBy }) {
  const ban = store().bans.find(b => b.status === 'banned' && ((steamId && b.steamId === steamId) || (discordId && discordId !== '0' && b.discordId === discordId)));
  const sid = steamId || (ban && ban.steamId);
  const did = (discordId && discordId !== '0') ? discordId : (ban && ban.discordId);
  if (sid) lists.remove('ban', sid);
  if (did) lists.remove('ban', did);
  const g = await guild();
  if (did) await setRole(did, cfg().bannedRoleId, false);
  if (did && g) {
    if (!ban || !ban.expiresAt) g.members.unban(did, 'Ban lifted').catch(() => {});
    const m = await member(did);
    if (m) { m.timeout(null, 'Ban lifted').catch(() => {}); m.send('You have been unbanned and your whitelist access has been restored.').catch(() => {}); }
  }
  const appRec = did && store().applications[did];
  if (appRec && appRec.status === 'banned') { appRec.status = 'accepted'; await applyWhitelist({ steamId: appRec.steamId, discordId: did, name: appRec.characterName }); }
  if (ban) {
    ban.status = 'unbanned'; ban.unbannedBy = unbannedBy || 'Admin tool'; ban.unbannedAt = new Date().toISOString();
    const ch = await channel(cfg().adminChannelId);
    if (ch && ban.messageId) {
      const msg = await ch.messages.fetch(ban.messageId).catch(() => null);
      if (msg && msg.embeds[0]) msg.edit({ embeds: [EmbedBuilder.from(msg.embeds[0]).setColor(0x3ddc84).addFields({ name: 'Unbanned By', value: /^\d+$/.test(String(ban.unbannedBy)) ? `<@${ban.unbannedBy}>` : String(ban.unbannedBy), inline: true })], components: [] }).catch(() => {});
    }
  }
  saveStore();
  emitRef('discord:state', status());
  return !!(ban || sid);
}

let expiryTimer = null;
async function checkExpiredBans() {
  const now = Date.now();
  for (const b of store().bans.filter(b => b.status === 'banned' && b.expiresAt && new Date(b.expiresAt).getTime() <= now)) {
    try { await unbanUser({ steamId: b.steamId, discordId: b.discordId, unbannedBy: 'System (Ban Expired)' }); addLog(`Ban expired for ${b.steamId}`); } catch (e) { addLog(`Auto-unban failed: ${e.message}`); }
  }
  // Discord timeouts cap at 28 days: renew them for longer temp bans.
  const g = await guild();
  if (!g) return;
  for (const b of store().bans.filter(b => b.status === 'banned' && b.expiresAt && b.discordId)) {
    const m = await g.members.fetch(b.discordId).catch(() => null);
    if (!m || (m.communicationDisabledUntilTimestamp && m.communicationDisabledUntilTimestamp > now)) continue;
    const ms = Math.min(new Date(b.expiresAt) - now, 28 * 86400000);
    if (ms > 0) m.timeout(ms, 'Renewing temporary ban').catch(() => {});
  }
}

// ---------- slash command execution (pure enough to unit test) ----------
async function execute(name, sub, opt, user) {
  const who = user ? `${user.tag || user} via Discord` : 'Discord';
  const by = user && user.id ? user.id : null;
  if (name === 'help') {
    const lines = [
      '**/application** — Post the whitelist application button here. *(Admin)*',
      '**/ticketpanel**, **/ticket close|add|list** — Support tickets: members open one with a button, each gets a private channel; closing posts a transcript to the ticket log. *(Admin, except using the button)*',
      '**/maintenance** — Re-check everyone against Steam for new VAC / game / trade bans and refresh the application embeds. *(Admin)*',
      '**/whitelist add|remove|list**, **/priority …** — Manage the server lists by Steam64 or Discord user; roles follow. *(Admin)*',
      '**/mute add|remove|list** — Give a member the muted role for a duration (30m, 2h, 3d); it is removed when time is up. *(Admin)*',
      '**/ban permanent|temporary** — Ban a player (game + Discord), with a reason prompt. **/ban battleye** for GUID/IP bans, **/ban remove** to lift, **/ban list**. *(Admin)*',
      '**/search** — Player dossier: application, whitelist, bans, notes. *(Admin)*',
      '**/heal player [what]** — Heal an online player: everything, or just health, bleeding, broken bones, diseases or food. **/teleport player [death_id | x z]** — send them back to where they died, or to coordinates. *(Admin)*',
      '**/deaths**, **/death id**, **/refund** — Death log: recent deaths, the full detail of one (every hit, damage per body part, gear carried) and spawning a player\'s lost gear at their feet while they are online. *(Admin)*',
      '**/players**, **/kick**, **/say** — Live via RCon. *(Admin)*',
      '**/server start|stop|restart**, **/backup** — Control the server. *(Admin)*',
      '**/status** — Server status and player count.',
      '**/bantime** — Check your own ban.'
    ];
    return { embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('Available Commands').setDescription(lines.join('\n'))] };
  }
  if (name === 'bantime') {
    const b = activeBanFor(by, null);
    if (!b) return { content: 'You are not currently banned.' };
    if (!b.expiresAt) return { content: `You are permanently banned. Reason: ${b.reason}` };
    const ms = new Date(b.expiresAt) - Date.now();
    return { content: ms <= 0 ? 'Your ban has expired and will be lifted shortly.' : `You are banned. Reason: ${b.reason}\nExpires <t:${Math.floor(new Date(b.expiresAt) / 1000)}:R>.` };
  }
  const listKindFor = { whitelist: 'whitelist', priority: 'priority' };
  if (name in listKindFor) {
    const kind = listKindFor[name];
    if (sub === 'list') return { embeds: [fmtList(lists.KINDS[kind].label, lists.read(kind).entries, e => `${e.steamId || e.id}  ${e.name || ''}${e.discordId ? ' <' + e.discordId + '>' : ''}${e.note ? ' — ' + e.note : ''}`)] };
    const t = resolveTarget(opt);
    if (!t.steamId) return { content: '❌ Give a Steam64 ID, or a Discord user who has a whitelist application on file.' };
    if (sub === 'add') {
      if (kind === 'whitelist') await applyWhitelist({ steamId: t.steamId, discordId: t.discordId, name: t.name, reviewerId: by });
      else { lists.add(kind, { id: t.steamId, discordId: t.discordId, name: t.name }, { name: t.name, note: opt.reason || '' }); if (t.discordId) await setRole(t.discordId, cfg().priorityRoleId, true); }
      return { content: `✅ Added \`${t.steamId}\`${t.name ? ` (${t.name})` : ''} to the ${kind}.`, log: `${who}: ${kind} add ${t.steamId}` };
    }
    if (sub === 'remove') {
      if (kind === 'whitelist') await revokeWhitelist({ steamId: t.steamId, discordId: t.discordId }); else { lists.remove(kind, t.steamId); if (t.discordId) await setRole(t.discordId, cfg().priorityRoleId, false); }
      return { content: `✅ Removed \`${t.steamId}\` from the ${kind}.`, log: `${who}: ${kind} remove ${t.steamId}` };
    }
  }
  if (name === 'mute') {
    if (sub === 'list') return { embeds: [fmtList('Active mutes', store().mutes || [], m => `<@${m.discordId}>  ${m.until ? 'until ' + new Date(m.until).toLocaleString() : 'indefinite'}${m.reason ? ' — ' + m.reason : ''}`)] };
    if (!opt.discord_user) return { content: '❌ Pick a Discord member.' };
    if (sub === 'add') { const ms = parseDuration(opt.duration); if (opt.duration && !ms) return { content: '❌ Duration looks wrong. Use 30m, 2h, 3d or 1w.' }; await muteUser({ discordId: opt.discord_user, durationMs: ms, reason: opt.reason, by }); return { content: `✅ Muted <@${opt.discord_user}>${ms ? ` for ${opt.duration}` : ''}.`, log: `${who}: mute ${opt.discord_user} ${opt.duration || ''}` }; }
    if (sub === 'remove') { const had = await unmuteUser({ discordId: opt.discord_user, by }); return { content: had ? `✅ Unmuted <@${opt.discord_user}>.` : `ℹ️ <@${opt.discord_user}> was not muted (role removed anyway).`, log: `${who}: unmute ${opt.discord_user}` }; }
  }
  if (name === 'ban') {
    if (sub === 'list') {
      const g = lists.read('ban').entries, b = lists.read('bebans').entries;
      return { embeds: [fmtList('Game bans (ban.txt)', g, e => `${e.steamId || e.id}  ${e.name || ''}${e.note ? ' — ' + e.note : ''}`), fmtList('BattlEye bans (bans.txt)', b, e => `${e.id}  ${e.minutes === '0' ? 'perm' : e.minutes + 'm'}  ${e.reason || ''}`)] };
    }
    if (sub === 'battleye') {
      if (rcon.status().connected) { await rcon.addBan(opt.guid, opt.minutes || 0, opt.reason || ''); lists.saveNote(opt.guid, { note: opt.reason || '' }); return { content: `✅ BattlEye ban added live via RCon for \`${opt.guid}\`.`, log: `${who}: BE ban ${opt.guid}` }; }
      lists.add('bebans', { id: opt.guid, minutes: opt.minutes || 0, reason: opt.reason || '' });
      return { content: `✅ Added \`${opt.guid}\` to bans.txt (run loadBans or restart).`, log: `${who}: BE ban ${opt.guid}` };
    }
    if (sub === 'remove') {
      const t = resolveTarget(opt);
      const id = t.steamId || opt.steamid64;
      if (lists.has('bebans', id)) { lists.remove('bebans', id); return { content: `✅ Removed \`${id}\` from bans.txt.`, log: `${who}: BE unban ${id}` }; }
      const ok = await unbanUser({ steamId: t.steamId, discordId: t.discordId, unbannedBy: by || who });
      return { content: ok ? `✅ Ban lifted for \`${id}\`${t.discordId ? ' and whitelist access restored' : ''}.` : `❌ No ban found for \`${id}\`.`, log: `${who}: unban ${id}` };
    }
    // permanent / temporary: handled interactively with a reason modal in onInteraction; direct call bans with opt.reason
    const t = resolveTarget(opt);
    if (!t.steamId) return { content: '❌ Give a Steam64 ID, or a Discord user who has a whitelist application on file.' };
    if (activeBanFor(t.discordId, t.steamId)) return { content: '⚠️ That player is already banned.' };
    const expiresAt = sub === 'temporary' ? new Date(Date.now() + (opt.duration_days || 1) * 86400000).toISOString() : null;
    await banUser({ steamId: t.steamId, discordId: t.discordId, reason: opt.reason || 'No reason given', bannedBy: by, expiresAt, name: t.name });
    return { content: `✅ ${sub === 'temporary' ? `Banned for ${opt.duration_days} day(s)` : 'Permanently banned'}: \`${t.steamId}\`.`, log: `${who}: ban ${sub} ${t.steamId} (${opt.reason || '-'})` };
  }
  if (name === 'search') {
    const t = resolveTarget(opt);
    let rec = t.rec;
    if (!rec && opt.character_name) rec = Object.values(store().applications).find(a => (a.characterName || '').toLowerCase().includes(opt.character_name.toLowerCase())) || null;
    const steamId = t.steamId || (rec && rec.steamId), discordId = t.discordId || (rec && rec.discordId);
    if (!steamId && !discordId) return { content: 'No information found for that player.' };
    const ban = store().bans.filter(b => (steamId && b.steamId === steamId) || (discordId && b.discordId === discordId)).slice(-1)[0];
    const notes = settings.load().playerNotes || {};
    const note = (steamId && notes[steamId]) || {};
    const e = new EmbedBuilder().setColor(0x5865F2).setTitle('Player Dossier').addFields(
      { name: 'Discord User', value: discordId ? `<@${discordId}>` : 'Unknown', inline: true },
      { name: 'SteamID64', value: steamId || 'Unknown', inline: true },
      { name: 'Character Name', value: (rec && rec.characterName) || note.name || 'Unknown', inline: true },
      { name: 'Application', value: rec ? `${rec.status}${rec.reviewerId ? ` (by <@${rec.reviewerId}>)` : ''}${rec.reason ? ` — ${rec.reason}` : ''}` : 'None on file', inline: true },
      { name: 'Whitelist', value: steamId && lists.has('whitelist', steamId) ? 'Yes' : 'No', inline: true },
      { name: 'Priority', value: steamId && lists.has('priority', steamId) ? 'Yes' : 'No', inline: true },
      { name: 'Ban', value: ban ? `${ban.status === 'banned' ? 'Currently banned' : 'Previously banned'} — ${ban.reason}${ban.expiresAt ? ` (expires <t:${Math.floor(new Date(ban.expiresAt) / 1000)}:R>)` : ''}` : 'None' });
    if (note.note) e.addFields({ name: 'Notes', value: note.note });
    try { const pr = require('./players').all({ query: steamId || (rec && rec.characterName) || '', limit: 1 })[0]; if (pr) e.addFields({ name: 'Playtime', value: `${Math.floor(pr.playtimeSec / 3600)}h ${Math.floor((pr.playtimeSec % 3600) / 60)}m over ${pr.connects} joins`, inline: true }, { name: 'Last seen', value: pr.lastSeen ? `<t:${Math.floor(pr.lastSeen / 1000)}:R>` : '-', inline: true }, { name: 'K / D', value: `${pr.kills} / ${pr.deaths}`, inline: true }); } catch { /* ignore */ }
    return { embeds: [e] };
  }
  if (name === 'players') {
    if (!rcon.status().connected) return { content: '⚠️ RCon is not connected in the admin tool.' };
    const { players } = await rcon.players();
    return { embeds: [fmtList('Online players', players, p => `#${p.num}  ${p.name}${p.lobby ? ' (lobby)' : ''}  ping ${p.ping}`)], ephemeral: false };
  }
  if (name === 'kick') {
    if (!rcon.status().connected) return { content: '⚠️ RCon is not connected in the admin tool.' };
    const p = await resolvePlayer(opt.player);
    if (!p) return { content: `❌ No online player matches "${opt.player}".` };
    await rcon.kick(p.num, opt.reason || '');
    return { content: `✅ Kicked **${p.name}** (#${p.num}).`, log: `${who}: kick ${p.name}` };
  }
  if (name === 'say') {
    if (!rcon.status().connected) return { content: '⚠️ RCon is not connected in the admin tool.' };
    await rcon.say(opt.message);
    return { content: `📢 Sent: ${opt.message}`, ephemeral: false, log: `${who}: say ${opt.message}` };
  }
  if (name === 'deaths') {
    const dl = require('./deathlog');
    const rows = dl.list({ q: opt.player || '', limit: Math.min(25, Math.max(1, Number(opt.count) || 10)) });
    if (!rows.length) return { content: 'No deaths recorded' + (opt.player ? ` for "${opt.player}"` : '') + '.' };
    const lines = rows.map(r => `#${r.id}  <t:${Math.floor(r.ts / 1000)}:R>  **${r.name}** — ${deathLine(r)}${r.gearCount ? ` · ${r.gearCount} items` : ''}`);
    return { embeds: [new EmbedBuilder().setColor(0x8b0000).setTitle('Death log').setDescription(lines.join('\n').slice(0, 4000)).setFooter({ text: '/death id:<number> for the detail, /refund id:<number> to give the gear back' })] };
  }
  if (name === 'death') {
    const r = require('./deathlog').get(opt.id);
    if (!r) return { content: `No death record #${opt.id}.` };
    return { embeds: [deathEmbed(r)] };
  }
  if (name === 'heal' || name === 'teleport') {
    const dl = require('./deathlog');
    const p = dl.findPlayer(opt.player); if (!p) return { content: `No player called "${opt.player}" in the player database.` };
    if (!p.online) return { content: `${p.name} is not online.` };
    try {
      let res, what;
      if (name === 'heal') { what = opt.what || 'all'; res = await dl.heal(p.key, what, { by: who }); }
      else if (opt.x !== undefined && opt.x !== null && opt.z !== undefined && opt.z !== null) { res = await dl.teleport(p.key, [opt.x, opt.z], { by: who }); res.pos = [opt.x, opt.z]; }
      else { let r = opt.death_id ? dl.get(opt.death_id) : null; if (!r) { const s0 = dl.forPlayer(p.key, 1)[0]; if (s0) r = dl.get(s0.id); } if (!r) return { content: `No recorded death for ${p.name}.` }; if (r.key !== p.key) return { content: `Death #${r.id} belongs to ${r.name}, not ${p.name}.` }; res = await dl.teleportToDeath(r.id, { by: who }); }
      if (res.status === 'done') { const msg = name === 'heal' ? `💚 Healed **${p.name}** (${dl.HEAL_KINDS[what]})` : `📍 Teleported **${p.name}** to ${Math.round(res.pos[0])}, ${Math.round(res.pos[1])}`; await postLog(`${msg} by ${who}`); return { content: msg }; }
      if (res.status === 'offline') return { content: `${p.name} is not in game right now (they must be online and alive).` };
      return { content: 'The server did not answer in time. Is the bridge script installed (Death log page) and the server running?' };
    } catch (e) { return { content: '⚠️ ' + e.message }; }
  }
  if (name === 'refund') {
    const dl = require('./deathlog');
    let r = opt.id ? dl.get(opt.id) : null;
    if (!r && opt.player) { const s0 = dl.list({ q: opt.player, limit: 1 })[0]; if (s0) r = dl.get(s0.id); }
    if (!r) return { content: 'Give a death record number (see /deaths) or the name of a player with a recorded death.' };
    if (!r.gear || !r.gear.length) return { content: `Death #${r.id} of ${r.name} has no gear snapshot (the bridge script was not running).` };
    try {
      const res = await dl.refund(r.id, { by: who });
      if (res.status === 'done') { await postLog(`↩️ ${who} refunded ${res.ok}/${res.items} items to ${r.name} (death #${r.id})`); return { content: `✅ Refunded ${res.ok} of ${res.items} items to **${r.name}** at their feet${res.fail ? ` (${res.fail} could not be spawned)` : ''}.` }; }
      if (res.status === 'offline') return { content: `${r.name} is not in game right now; they must be online and alive to receive a refund.` };
      return { content: 'The server did not answer in time. Is the bridge script installed (Death log page) and the server running?' };
    } catch (e) { return { content: '⚠️ ' + e.message }; }
  }
  if (name === 'status') {
    const st = server.status(), sc = scheduler.state();
    let online = 'RCon not connected';
    if (rcon.status().connected) { try { online = `${(await rcon.players()).players.length}${maxPlayers() ? ' / ' + maxPlayers() : ''}`; } catch { online = '?'; } }
    const up = st.running ? Math.round((Date.now() - st.startedAt) / 60000) : 0;
    const e = new EmbedBuilder().setTitle('DayZ server status').setColor(st.running ? 0x3ddc84 : 0xff5f5f).addFields(
      { name: 'State', value: st.running ? `🟢 Online (${Math.floor(up / 60)}h ${up % 60}m)` : '🔴 Offline', inline: true },
      { name: 'Players', value: online, inline: true },
      { name: 'Mods', value: String(mods.list().filter(m => m.enabled).length), inline: true },
      ...(function(){ try { const h = require('./health').current(); return st.running && h.at ? [{ name: 'CPU / RAM / FPS', value: `${h.cpu === null ? '?' : h.cpu + '%'} / ${h.ramMB ? (h.ramMB / 1024).toFixed(1) + ' GB' : '?'} / ${h.fps === null ? '?' : h.fps}`, inline: true }] : []; } catch { return []; } })(),
      { name: 'Next restart', value: sc.nextRestart ? `<t:${Math.floor(sc.nextRestart / 1000)}:R>` : 'none', inline: true },
      { name: 'Next backup', value: sc.nextBackup ? `<t:${Math.floor(sc.nextBackup / 1000)}:R>` : 'none', inline: true });
    return { embeds: [e], ephemeral: false };
  }
  if (name === 'server') {
    if (sub === 'start') { server.start(); return { content: '✅ Server starting.', log: `${who}: server start` }; }
    if (sub === 'stop') { await server.stop(); return { content: '✅ Server stopped.', log: `${who}: server stop` }; }
    if (sub === 'restart') { scheduler.restartNow().catch(() => {}); return { content: '✅ Restart started (players are warned if RCon is connected; backup taken if enabled).', log: `${who}: server restart` }; }
  }
  if (name === 'ticket') {
    if (sub === 'list') { const open = (store().tickets || []).filter(t => t.status === 'open'); return { embeds: [fmtList('Open tickets', open, t => `#${t.id} <#${t.channelId}> — ${t.subject} (<@${t.discordId}>)`)] }; }
    const t = ticketByChannel(opt._channelId);
    if (!t) return { content: '❌ Use this inside a ticket channel.' };
    if (sub === 'close') { await closeTicket(t.id, { by, reason: opt.reason }); return { content: `✅ Ticket #${t.id} closed.`, log: `${who}: closed ticket #${t.id}` }; }
    if (sub === 'add') { const ch = await channel(t.channelId); if (ch) await ch.permissionOverwrites.edit(opt.discord_user, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }); return { content: `✅ Added <@${opt.discord_user}> to ticket #${t.id}.` }; }
  }
  if (name === 'maintenance') {
    const r = await require('./steambans').checkAll();
    const e = await refreshApplicationEmbeds();
    return { content: `✅ Checked ${r.checked} Steam account(s). ${r.newBans && r.newBans.length ? `⚠️ New bans: ${r.newBans.map(b => `${b.personaName || b.steamId} (${b.steamId})`).join(', ')}` : 'No new bans.'} Refreshed ${e.updated} application embed(s).`, log: `${who}: maintenance` };
  }
  if (name === 'backup') {
    const r = await backups.create('discord');
    return { content: `✅ Backup saved: \`${r.name}\` (${(r.size / 1048576).toFixed(1)} MB).`, log: `${who}: backup` };
  }
  return { content: '❌ Unknown command.' };
}

function optionsOf(interaction) {
  const out = {};
  const walk = arr => { for (const o of arr || []) { if (o.options) walk(o.options); else out[o.name] = o.type === 6 && o.user ? o.user.id : o.value; } };
  walk(interaction.options && interaction.options.data);
  return out;
}

const reasonModal = (id, title, withDuration = false) => {
  const m = new ModalBuilder().setCustomId(id).setTitle(title);
  if (withDuration) m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('duration').setStyle(TextInputStyle.Short).setLabel('Duration in days').setRequired(true).setPlaceholder('e.g. 7')));
  m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setLabel('Reason').setPlaceholder('Enter the reason').setRequired(true)));
  return m;
};

async function onInteraction(interaction) {
  const c = cfg();
  const ephemeralErr = (content) => (interaction.deferred || interaction.replied ? interaction.editReply({ content }) : interaction.reply({ content, ephemeral: true })).catch(() => {});
  try {
    // ----- slash commands -----
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;
      let sub = null; try { sub = interaction.options.getSubcommand(false); } catch { /* none */ }
      if (!PUBLIC_COMMANDS.includes(name) && !isAllowed(interaction)) return ephemeralErr('⛔ You need Administrator or one of the configured admin roles.');
      const opt = optionsOf(interaction);
      if (name === 'application') {
        const embed = new EmbedBuilder().setColor(0x3ddc84).setAuthor({ name: `${interaction.guild.name} Whitelist Application` }).setThumbnail(interaction.guild.iconURL()).setDescription('Interested in joining the server? Click the button below to begin your whitelist application.');
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle('Success').setCustomId('application').setLabel('Whitelist Application'));
        return interaction.reply({ embeds: [embed], components: [row] });
      }
      if (name === 'ticketpanel') {
        if (!c.ticketCategoryId) return ephemeralErr('Set a ticket category ID on the Discord Bot page first.');
        const embed = new EmbedBuilder().setColor(0x4f8cff).setAuthor({ name: `${interaction.guild.name} Support` }).setThumbnail(interaction.guild.iconURL()).setDescription('Need help, want to report a player, or have a base or compensation request? Click below to open a private ticket with the staff.');
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle('Primary').setCustomId('ticketopen').setLabel('Open a ticket'));
        return interaction.reply({ embeds: [embed], components: [row] });
      }
      if (name === 'ban' && (sub === 'permanent' || sub === 'temporary')) {
        const t = resolveTarget(opt);
        if (!t.steamId) return ephemeralErr('❌ Give a Steam64 ID, or a Discord user who has a whitelist application on file.');
        if (activeBanFor(t.discordId, t.steamId)) return ephemeralErr('⚠️ That player is already banned.');
        const days = sub === 'temporary' ? opt.duration_days : 0;
        return interaction.showModal(reasonModal(`modal-ban-${t.steamId}-${t.discordId || '0'}-${days}`, sub === 'temporary' ? `Ban for ${days} day(s)` : 'Permanently Ban Player'));
      }
      await interaction.deferReply({ ephemeral: true });
      opt._channelId = interaction.channelId;
      const r = await execute(name, sub, opt, interaction.user);
      const payload = { content: r.content, embeds: r.embeds };
      if (r.ephemeral === false) { await interaction.deleteReply().catch(() => {}); await interaction.followUp({ ...payload, ephemeral: false }); }
      else await interaction.editReply(payload);
      if (r.log) { addLog(r.log); postLog(`📝 ${r.log}`); }
      try { require('./audit').log('discord', interaction.user.tag, `/${name}${sub ? ' ' + sub : ''}`, r.log || r.content || ''); } catch { /* ignore */ }
      return;
    }
    // ----- buttons -----
    if (interaction.isButton()) {
      const [req, a, b] = interaction.customId.split('-');
      if (req === 'application') {
        if (activeBanFor(interaction.user.id, null)) return ephemeralErr('You are currently banned and cannot apply.');
        const rec = store().applications[interaction.user.id];
        if (rec && rec.status === 'pending') return ephemeralErr('Your whitelist application is already pending.');
        if (rec && rec.status === 'accepted') return ephemeralErr('You are already on the whitelist.');
        const m = new ModalBuilder().setCustomId('modal-application').setTitle('Whitelist Application');
        const f = (id, label, style, extra = {}) => { const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(true); if (extra.min) t.setMinLength(extra.min); if (extra.max) t.setMaxLength(extra.max); if (extra.ph) t.setPlaceholder(extra.ph); return new ActionRowBuilder().addComponents(t); };
        m.addComponents(f('steamid64', "What's your SteamID64?", TextInputStyle.Short, { min: 17, max: 17, ph: '7656119...' }), f('character', 'Character name', TextInputStyle.Short, { ph: 'John Doe' }), f('biography', "Your character's biography", TextInputStyle.Paragraph, { min: 50, ph: '50 characters minimum' }), f('bans', 'Any bans on record? If so, why?', TextInputStyle.Short), f('rules', 'Do you agree to follow the rules? (Yes / No)', TextInputStyle.Short));
        return interaction.showModal(m);
      }
      if (!isAllowed(interaction)) return ephemeralErr('⛔ Admins only.');
      if (req === 'accept') {
        await interaction.deferReply({ ephemeral: true });
        const steamId = a, discordId = b;
        const rec = store().applications[discordId];
        await applyWhitelist({ steamId, discordId, name: rec && rec.characterName, reviewerId: interaction.user.id });
        if (rec) { rec.status = 'accepted'; rec.reviewerId = interaction.user.id; rec.reviewedAt = new Date().toISOString(); saveStore(); }
        await interaction.message.edit({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x3ddc84).addFields({ name: 'Reviewed By', value: `<@${interaction.user.id}> (Accepted)`, inline: true })], components: [acceptedRow(steamId, discordId)] }).catch(() => {});
        const m = await member(discordId); if (m) m.send('Your whitelist application has been accepted.').catch(() => {});
        addLog(`${interaction.user.tag}: accepted application ${steamId}`); postLog(`✅ <@${interaction.user.id}> accepted the whitelist application of <@${discordId}> (${steamId})`);
        emitRef('discord:state', status());
        return interaction.editReply({ content: 'Added to the whitelist.' });
      }
      if (req === 'ticketopen') {
        if (activeBanFor(interaction.user.id, null)) return ephemeralErr('You are banned and cannot open tickets.');
        const m = new ModalBuilder().setCustomId('modal-ticket').setTitle('Open a ticket');
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject').setLabel('Subject').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setPlaceholder('e.g. Player report, Base issue, Compensation')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('What happened?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500)));
        return interaction.showModal(m);
      }
      if (req === 'ticketclose') {
        const t = ticketById(a);
        if (!t || t.status !== 'open') return ephemeralErr('This ticket is already closed.');
        if (!(await canTouchTicket(interaction, t))) return ephemeralErr('Only staff or the person who opened the ticket can close it.');
        await interaction.deferReply({ ephemeral: true });
        await closeTicket(t.id, { by: interaction.user.id });
        return interaction.editReply({ content: `Ticket #${t.id} closed.` });
      }
      if (req === 'decline') return interaction.showModal(reasonModal(`modal-decline-${a}`, 'Decline Application'));
      if (req === 'remove') {
        await interaction.deferReply({ ephemeral: true });
        await revokeWhitelist({ steamId: a, discordId: b });
        delete store().applications[b]; saveStore();
        await interaction.message.edit({ components: [] }).catch(() => {});
        addLog(`${interaction.user.tag}: removed ${a} from whitelist`); postLog(`🚫 <@${interaction.user.id}> removed <@${b}> (${a}) from the whitelist`);
        return interaction.editReply({ content: 'Removed from the whitelist.' });
      }
      if (req === 'banperm' || req === 'bantemp') {
        if (activeBanFor(b, a)) return ephemeralErr('This player is already banned.');
        return interaction.showModal(reasonModal(`modal-ban-${a}-${b}-0`, req === 'banperm' ? 'Permanently Ban Player' : 'Temporarily Ban Player', req === 'bantemp'));
      }
      if (req === 'unban') {
        await interaction.deferReply({ ephemeral: true });
        const ok = await unbanUser({ steamId: a, discordId: b, unbannedBy: interaction.user.id });
        addLog(`${interaction.user.tag}: unban ${a}`); postLog(`♻️ <@${interaction.user.id}> lifted the ban on ${a}`);
        return interaction.editReply({ content: ok ? 'Ban lifted and whitelist access restored.' : 'No active ban found.' });
      }
      return;
    }
    // ----- modals -----
    if (interaction.isModalSubmit()) {
      const id = interaction.customId;
      if (id === 'modal-application') {
        const steamId = interaction.fields.getTextInputValue('steamid64').trim();
        if (!lists.isSteam64(steamId)) return ephemeralErr('Please enter a valid SteamID64 (17 digits starting with 7656119).');
        await interaction.deferReply({ ephemeral: true });
        const character = interaction.fields.getTextInputValue('character').trim();
        const steamInfo = await getSteamInfo(steamId);
        const embed = applicationEmbed(interaction, { steamId, character, biography: interaction.fields.getTextInputValue('biography'), bansText: interaction.fields.getTextInputValue('bans'), rules: interaction.fields.getTextInputValue('rules'), steamInfo });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle('Success').setCustomId(`accept-${steamId}-${interaction.user.id}`).setLabel('Accept'),
          new ButtonBuilder().setStyle('Danger').setCustomId(`decline-${interaction.user.id}`).setLabel('Decline'),
          new ButtonBuilder().setStyle('Link').setLabel('Steam Profile').setURL(`https://steamcommunity.com/profiles/${steamId}`));
        const ch = await channel(c.adminChannelId);
        if (!ch) return interaction.editReply({ content: 'The admin channel is not configured. Tell the server staff.' });
        const msg = await ch.send({ embeds: [embed], components: [row] });
        store().applications[interaction.user.id] = { messageId: msg.id, steamId, discordId: interaction.user.id, status: 'pending', characterName: character, submittedAt: new Date().toISOString() };
        saveStore(); emitRef('discord:state', status());
        addLog(`Application submitted by ${interaction.user.tag} (${steamId})`);
        return interaction.editReply({ content: 'Your application was submitted. You will be notified once it is reviewed.' });
      }
      if (id === 'modal-ticket') {
        await interaction.deferReply({ ephemeral: true });
        try { const t = await openTicket({ discordId: interaction.user.id, subject: interaction.fields.getTextInputValue('subject').trim(), description: interaction.fields.getTextInputValue('description').trim() }); return interaction.editReply({ content: `Your ticket #${t.id} is open: <#${t.channelId}>` }); }
        catch (e) { return interaction.editReply({ content: '❌ ' + e.message }); }
      }
      if (id.startsWith('modal-decline-')) {
        const discordId = id.split('-')[2];
        const reason = interaction.fields.getTextInputValue('reason');
        const rec = store().applications[discordId];
        if (rec) { rec.status = 'declined'; rec.reviewerId = interaction.user.id; rec.reviewedAt = new Date().toISOString(); rec.reason = reason; saveStore(); }
        if (interaction.message && interaction.message.embeds[0]) await interaction.message.edit({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0xff5f5f).addFields({ name: 'Reviewed By', value: `<@${interaction.user.id}> (Declined)`, inline: true }, { name: 'Reason', value: reason })], components: [] }).catch(() => {});
        const m = await member(discordId); if (m) m.send(`Your whitelist application has been declined. ${reason}`).catch(() => {});
        addLog(`${interaction.user.tag}: declined application of ${discordId}`);
        return interaction.reply({ content: 'Application declined.', ephemeral: true });
      }
      if (id.startsWith('modal-ban-')) {
        const [, , steamId, discordId, presetDays] = id.split('-');
        let days = Number(presetDays) || 0;
        if (!days) { try { days = parseInt(interaction.fields.getTextInputValue('duration'), 10) || 0; } catch { days = 0; } }
        const reason = interaction.fields.getTextInputValue('reason');
        await interaction.deferReply({ ephemeral: true });
        const rec = discordId !== '0' ? store().applications[discordId] : null;
        const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;
        await banUser({ steamId, discordId: discordId !== '0' ? discordId : null, reason, bannedBy: interaction.user.id, expiresAt, name: rec && rec.characterName });
        const appMsg = rec && rec.messageId ? await (await channel(c.adminChannelId))?.messages.fetch(rec.messageId).catch(() => null) : null;
        if (appMsg) appMsg.edit({ components: [] }).catch(() => {});
        addLog(`${interaction.user.tag}: ban ${days ? days + 'd' : 'permanent'} ${steamId} (${reason})`); postLog(`🔨 <@${interaction.user.id}> banned ${discordId !== '0' ? `<@${discordId}>` : steamId} ${days ? `for ${days} day(s)` : 'permanently'}: ${reason}`);
        return interaction.editReply({ content: days ? `Banned for ${days} day(s).` : 'Permanently banned.' });
      }
    }
  } catch (e) {
    addLog(`Interaction failed: ${e.message}`);
    await ephemeralErr(`❌ ${e.message}`);
  }
}

// ---------- presence: online/offline + player count ----------
let presenceTimer = null;
let lastPresence = '';
function maxPlayers() {
  try { const m = fs.readFileSync(settings.paths().configPath, 'utf8').match(/maxPlayers\s*=\s*(\d+)/); return m ? Number(m[1]) : null; } catch { return null; }
}
async function updatePresence() {
  if (!client || !state.running || !client.user) return;
  const c = cfg();
  const st = server.status();
  let text, presence;
  if (st.running) {
    let count = null;
    if (rcon.status().connected) { try { count = (await rcon.players()).players.length; } catch { count = null; } }
    const max = maxPlayers();
    text = (c.statusFormat || 'Server Online | {count}/{max} Players').replace('{count}', count === null ? '?' : String(count)).replace('{max}', max ? String(max) : '?');
    presence = 'online';
    state.playersOnline = count;
  } else {
    text = st.restartPending ? 'Server restarting…' : (c.offlineStatus || 'Server Offline');
    presence = st.restartPending ? 'idle' : 'dnd';
    state.playersOnline = null;
  }
  const key = presence + '|' + text;
  if (key === lastPresence) return;
  lastPresence = key;
  try { client.user.setPresence({ status: presence, activities: [{ name: text, type: ActivityType.Playing }] }); state.presence = text; emitRef('discord:state', status()); } catch { /* ignore */ }
}
function startPresence() { stopPresence(); lastPresence = ''; updatePresence().catch(() => {}); presenceTimer = setInterval(() => updatePresence().catch(() => {}), 20000); }
function stopPresence() { clearInterval(presenceTimer); presenceTimer = null; }

// ---------- live log streaming ----------
const tail = { timer: null, flush: null, files: {}, queue: [], paused: false, posted: 0 };
const ERR_RE = /SCRIPT\s+\(E\)|ERROR|Error|Can't|Cannot|failed|Failed|Access violation|Warning Message|kicked|banned|BattlEye/;
function newestFile(kind) {
  const p = settings.paths();
  try {
    const re = kind === 'adm' ? /\.adm$/i : /\.rpt$/i;
    const files = fs.readdirSync(p.profilesDir).filter(f => re.test(f)).map(f => ({ f: path.join(p.profilesDir, f), m: fs.statSync(path.join(p.profilesDir, f)).mtimeMs }));
    files.sort((a, b) => b.m - a.m);
    return files[0] ? files[0].f : null;
  } catch { return null; }
}
function pollLogs() {
  const c = cfg();
  if (!client || !state.running || !c.liveLogChannelId) return;
  for (const kind of (c.liveLogKinds || [])) {
    const file = newestFile(kind);
    if (!file) continue;
    let size = 0; try { size = fs.statSync(file).size; } catch { continue; }
    const cur = tail.files[kind];
    if (!cur || cur.file !== file) { tail.files[kind] = { file, offset: size, rest: '' }; continue; }
    if (size < cur.offset) cur.offset = 0;
    if (size === cur.offset) continue;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size - cur.offset, 256 * 1024));
      const n = fs.readSync(fd, buf, 0, buf.length, cur.offset);
      cur.offset += n;
      const lines = (cur.rest + buf.toString('utf8', 0, n)).split(/\r?\n/);
      cur.rest = lines.pop() || '';
      for (const l of lines) { const line = l.trim(); if (!line) continue; if (c.liveLogErrorsOnly && !ERR_RE.test(line)) continue; tail.queue.push(`[${kind.toUpperCase()}] ${line}`); }
    } finally { fs.closeSync(fd); }
  }
  if (tail.queue.length > 400) tail.queue.splice(0, tail.queue.length - 400);
}
async function flushLogs() {
  const c = cfg();
  if (!client || !state.running || !c.liveLogChannelId || !tail.queue.length || tail.paused) return;
  const lines = tail.queue.splice(0, tail.queue.length);
  const chunks = []; let cur = '';
  for (const l of lines) { const piece = l.length > 1800 ? l.slice(0, 1800) + '…' : l; if ((cur + '\n' + piece).length > 1850) { chunks.push(cur); cur = piece; } else cur = cur ? cur + '\n' + piece : piece; }
  if (cur) chunks.push(cur);
  try {
    const ch = await client.channels.fetch(c.liveLogChannelId);
    if (!ch || !ch.isTextBased()) throw new Error('Live log channel is not a text channel.');
    for (const chunk of chunks.slice(0, 4)) { await ch.send('```\n' + chunk.replace(/```/g, "'''") + '\n```'); tail.posted++; }
    if (chunks.length > 4) await ch.send(`⚠️ ${chunks.length - 4} more chunk(s) skipped to respect Discord rate limits.`);
    state.liveLogPosted = tail.posted;
  } catch (e) { tail.paused = true; addLog(`Live log posting paused: ${e.message}`); setTimeout(() => { tail.paused = false; }, 60000); }
}
function startTail() { stopTail(); tail.files = {}; tail.queue = []; tail.posted = 0; tail.timer = setInterval(() => { try { pollLogs(); } catch (e) { addLog(`Log tail error: ${e.message}`); } }, 2000); tail.flush = setInterval(() => flushLogs().catch(() => {}), 4000); }
function stopTail() { clearInterval(tail.timer); clearInterval(tail.flush); tail.timer = tail.flush = null; }
function applyLiveLog() { if (!state.running) return; if (cfg().liveLogChannelId) startTail(); else stopTail(); }

// ---------- lifecycle ----------
async function start() {
  const c = cfg();
  if (!c.token) throw new Error('Bot token is empty. Create a bot at discord.com/developers and paste its token.');
  if (!c.guildId) throw new Error('Guild (server) ID is empty. Enable Developer Mode in Discord, right-click your server, Copy Server ID.');
  await stop(true);
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], partials: [Partials.Channel, Partials.GuildMember, Partials.User] });
  state = { ...state, running: false, tag: null, appId: null, guildName: null, error: null, commands: 0, startedAt: null, presence: null };
  client.on('interactionCreate', onInteraction);
  client.on('error', e => addLog(`Client error: ${e.message}`));
  client.on('shardDisconnect', () => { if (state.running) require('./alerts').alert('bot-offline', 'Discord bot disconnected', 'The gateway connection dropped; discord.js will try to reconnect.'); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Login timed out. Check the token and your internet connection.')), 20000);
    client.once('ready', async () => {
      clearTimeout(timer);
      try {
        state.tag = client.user.tag; state.appId = client.application.id; state.running = true; state.startedAt = Date.now();
        const rest = new REST({ version: '10' }).setToken(c.token);
        const cmds = buildCommands();
        await rest.put(Routes.applicationGuildCommands(state.appId, c.guildId), { body: cmds });
        await rest.put(Routes.applicationCommands(state.appId), { body: [] }).catch(() => {}); // clear stray global commands
        state.commands = cmds.length;
        try { const g = await client.guilds.fetch(c.guildId); state.guildName = g.name; } catch { state.guildName = null; state.error = 'Bot is not in that guild yet. Use the invite link.'; }
        addLog(`Bot online as ${state.tag}; ${cmds.length} slash commands registered${state.guildName ? ' in ' + state.guildName : ''}.`);
        startPresence();
        clearInterval(expiryTimer); expiryTimer = setInterval(() => { checkExpiredBans().catch(() => {}); syncRoles().catch(() => {}); }, 5 * 60 * 1000); checkExpiredBans().catch(() => {}); setTimeout(() => syncRoles().catch(() => {}), 5000);
        if (c.liveLogChannelId) { startTail(); addLog(`Live log streaming to channel ${c.liveLogChannelId} (${(c.liveLogKinds || []).join(', ').toUpperCase() || 'nothing selected'}${c.liveLogErrorsOnly ? ', errors only' : ''}).`); }
        resolve();
      } catch (e) { clearTimeout(timer); reject(e); }
    });
    client.login(c.token).catch(e => { clearTimeout(timer); reject(new Error(/token/i.test(e.message) ? 'Invalid bot token.' : /intents/i.test(e.message) ? 'Enable "Server Members Intent" for the bot in the Discord developer portal (Bot → Privileged Gateway Intents).' : e.message)); });
  }).catch(async e => { state.error = e.message; addLog(`Start failed: ${e.message}`); await stop(true); throw e; });
  emitRef('discord:state', status());
  return status();
}

async function stop(silent = false) {
  stopTail(); stopPresence(); clearInterval(expiryTimer); expiryTimer = null;
  if (client) { try { client.removeAllListeners(); await client.destroy(); } catch { /* ignore */ } client = null; }
  const was = state.running;
  state.running = false; state.startedAt = null; state.presence = null;
  if (!silent && was) addLog('Bot stopped.');
  emitRef('discord:state', status());
  return status();
}

function notify(ch) { if (ch === 'server:status') updatePresence().catch(() => {}); }
function init(emit) { emitRef = emit; if (cfg().autoStart && cfg().token) setTimeout(() => start().catch(() => {}), 4000); }

module.exports = { postDeath, postAlert, refreshApplicationEmbeds, rolesFor, feedEvent, openTicket, closeTicket, syncRoles, muteUser, unmuteUser, parseDuration, init, start, stop, status, execute, buildCommands, isAllowed, cfg, applyLiveLog, notify, updatePresence, banUser, unbanUser, store, _tail: { pollLogs, flushLogs, tail, useStubClient(c) { client = c; state.running = true; } } };
