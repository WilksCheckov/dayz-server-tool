'use strict';
// Unified player profile: the history of one player gathered from the death log, tickets, the audit log and the dupe
// alerts, matched by DayZ id, Steam64, Discord id or name (and not by a longer name that starts the same).
const STEAM = '76561198000000007';
const t = require('./harness').setup({ name: 'profile', stubs: {
  './players@profile': { get: (k) => k === 'GBOB' ? { key: 'GBOB', id: 'GBOB', names: ['Bob', 'Bobby2'], name: 'Bobby2', steamId: STEAM, discordId: '555' } : null },
  './deathlog@profile': { list: () => [
    { id: 3, ts: 3, key: 'GBOB', name: 'Bobby2', killer: { name: 'Al', id: 'GAL' }, refunds: 1 },
    { id: 2, ts: 2, key: 'GAL', name: 'Al', killer: { name: 'Bob', id: 'GBOB' }, refunds: 0 },
    { id: 1, ts: 1, key: 'GBOB', name: 'Bob', killer: null, refunds: 0 },
    { id: 0, ts: 0, key: 'GTOM', name: 'Tom', killer: { name: 'Al', id: 'GAL' }, refunds: 0 },
  ] },
  './tickets@profile': { all: () => [
    { id: '0001', subject: 'Lost gear', status: 'open', game: { steam: STEAM, guid: 'GBOB', title: 'Lost gear' }, createdAt: '2026-10-01' },
    { id: '0002', subject: 'From Discord', status: 'closed', discordId: '555', channelId: 'c', createdAt: '2026-10-02' },
    { id: '0003', subject: 'Someone else', status: 'open', player: 'Tom', createdAt: '2026-10-03' },
  ] },
  './audit@profile': { list: () => [
    { ts: 5, source: 'game', who: 'Ada', action: 'admin:heal', details: `Bobby2 (${STEAM}) everything` },
    { ts: 4, source: 'game', who: 'Ada', action: 'whitelist add', details: 'Bob' },
    { ts: 3, source: 'app', who: 'Ada', action: 'admin:teleport', details: 'Bobbyfan (76561198000000009) to 1, 2' },
    { ts: 2, source: 'portal', who: 'Ada', action: 'portal login', details: 'Bob' },
  ] },
  './anticheat@profile': { list: () => [
    { id: 9, ts: 9, cls: 'M4A1', source: 'mod', holders: [{ kind: 'player', id: 'GBOB', name: 'Bob' }, { kind: 'world', cls: 'M4A1', pos: '1 2' }], who: ['Bob', 'M4A1 at 1 2'] },
    { id: 8, ts: 8, cls: 'AKM', source: 'mod', holders: [{ kind: 'player', id: 'GAL', name: 'Al' }, { kind: 'player', id: 'GTOM', name: 'Tom' }], who: ['Al', 'Tom'] },
  ] },
} });
const profile = t.mod('profile');

const h = profile.history('GBOB');
t.ok('deaths under any of their names', h.deaths.map(d => d.id).join() === '3,1');
t.ok('kills where they were the killer', h.kills.map(d => d.id).join() === '2');
t.ok('refunds from their refunded deaths', h.refunds.length === 1 && h.refunds[0].deathId === 3);
t.ok('tickets from the game (Steam64) and from Discord (Discord id), not others', h.tickets.map(x => x.id).sort().join() === '0001,0002' && h.counts.openTickets === 1);
t.ok('admin actions by Steam64 and by exact name, not a longer name or portal logins', h.actions.map(a => a.ts).join() === '5,4' && h.actions[0].action === 'heal');
t.ok('dupe alerts they were part of', h.dupes.length === 1 && h.dupes[0].cls === 'M4A1');
t.ok('counts match the lists', h.counts.deaths === 2 && h.counts.kills === 1 && h.counts.actions === 2 && h.counts.dupes === 1);
t.ok('an unknown player is an error', (() => { try { profile.history('NOPE'); return false; } catch { return true; } })());
t.done();
