import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { OutgoingPeer } from './peerSync.js';
import { SyncStore } from './syncStore.js';
import { runBidirectional } from './bidirectionalSync.js';
import { createSyncReceiver } from './syncReceiver.js';
import { checkedDestination, normalizeSyncPath } from './syncPaths.js';

export function createSyncGroupManager({ storageRoot, api, clientId, sendSignal, iceServers, syncFiles, peerFactory, log = () => {} }) {
  let groups = new Map(), leaseUntil = 0, refreshing = null, busy = false, activePeer, timer, tickTimer, stopped = false;
  const reports = {}, lastRun = new Map();
  let changeEpoch = 0;
  const valid = (id, revision) => !stopped && Date.now() < leaseUntil && groups.get(id)?.revision === revision;
  const receiver = createSyncReceiver({ storageRoot, syncFiles, authorize: (peerId, context) => {
    const group = groups.get(context.groupId), member = group?.members.find(m => m.clientId === clientId());
    return member && valid(group.id, context.revision) && group.coordinatorId === peerId ? { directory: member.directory } : null;
  } });
  const invalidate = () => { leaseUntil = 0; activePeer?.close(); receiver.revoke(); };
  const publish = () => api('/api/client/sync-control', { method: 'POST', body: JSON.stringify({ protocol: 3, groups: reports }), maxAttempts: 1 });
  const refresh = () => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const epoch = changeEpoch;
      const response = await api('/api/client/sync-groups', { maxAttempts: 1 });
      if (epoch !== changeEpoch || stopped) return;
      const incoming = new Map();
      for (const group of response.groups || []) {
        if (!/^[a-f0-9-]{36}$/.test(group.id) || !Number.isSafeInteger(group.revision) || group.revision < 1 || !Array.isArray(group.members) || group.members.length < 2 || group.members.length > 8 || !group.enabled) throw new Error('Invalid server sync group');
        for (const member of group.members) normalizeSyncPath(member.directory);
        if (!group.members.some(m => m.clientId === clientId()) || !group.members.some(m => m.clientId === group.coordinatorId)) throw new Error('Invalid group membership');
        incoming.set(group.id, group);
      }
      const changed = [...groups].some(([id, g]) => incoming.get(id)?.revision !== g.revision);
      if (changed) invalidate();
      for (const [id, group] of incoming) {
        if (groups.get(id)?.revision !== group.revision || groups.get(id)?.runSequence !== group.runSequence) lastRun.delete(id);
        if (!reports[id] || groups.get(id)?.revision !== group.revision) reports[id] = { state: 'idle', revision: group.revision, message: group.coordinatorId === clientId() ? '等待下一轮同步' : '已关联，等待协调端' };
      }
      for (const id of Object.keys(reports)) if (!incoming.has(id)) delete reports[id];
      groups = incoming;
      leaseUntil = Date.now() + Math.min(30000, Math.max(1000, Number(response.leaseMs) || 30000));
      await publish();
    })().catch(error => { log('sync-groups-refresh', error.message); }).finally(() => { refreshing = null; });
    return refreshing;
  };
  async function runGroup(group) {
    const me = group.members.find(m => m.clientId === clientId());
    const check = () => { if (!valid(group.id, group.revision)) throw new Error('同步关联已取消或授权已过期'); };
    reports[group.id] = { ...reports[group.id], state: 'running', message: '正在同步', revision: group.revision };
    await publish().catch(() => {});
    const total = { pushed: 0, pulled: 0, deleted: 0, conflicts: 0 }, errors = [];
    // Offline members are skipped; they catch up on a later round.
    for (const member of group.members.filter(m => m.clientId !== clientId() && m.online !== false)) {
      check();
      let peer;
      try {
        peer = peerFactory ? peerFactory(member.clientId, group) : new OutgoingPeer(member.clientId, sendSignal, iceServers, 'nas-sync-v3', { groupId: group.id, revision: group.revision });
        activePeer = peer;
        await peer.open(); await peer.ping(); check();
        const root = await checkedDestination(storageRoot, '.nas-bot/peer-sync-groups/' + group.id);
        await fs.mkdir(root, { recursive: true });
        const identity = JSON.stringify([group.id, group.revision, group.coordinatorId, me.directory, member.clientId, member.directory]);
        const key = crypto.createHash('sha256').update(identity).digest('hex');
        const result = await runBidirectional({ store: new SyncStore(storageRoot, me.directory, { guard: () => valid(group.id, group.revision) }), remote: peer.remoteStore(member.directory), stateFile: path.join(root, key + '.json'), identity, check });
        total.pushed += result.pushed; total.pulled += result.pulled;
        total.deleted += result.deletedLocal + result.deletedRemote; total.conflicts += result.conflicts.length;
      } catch (e) { errors.push(member.clientId + ': ' + e.message); }
      finally { peer?.close(); if (activePeer === peer) activePeer = null; }
    }
    check();
    await syncFiles();
    reports[group.id] = { state: errors.length ? 'error' : 'idle', revision: group.revision, message: errors.join('；').slice(0, 300) || '本轮完成', lastCompletedAt: new Date().toISOString(), summary: `上传 ${total.pushed}，下载 ${total.pulled}，删除 ${total.deleted}，冲突 ${total.conflicts}` };
    await publish().catch(() => {});
  }
  async function tick() {
    if (Date.now() >= leaseUntil) { invalidate(); return; }
    if (busy || stopped) return;
    busy = true;
    try {
      for (const group of groups.values()) {
        if (group.coordinatorId !== clientId() || Date.now() - (lastRun.get(group.id) || 0) < 60000) continue;
        lastRun.set(group.id, Date.now());
        try { await runGroup(group); }
        catch (error) { if (valid(group.id, group.revision)) reports[group.id] = { state: 'error', revision: group.revision, message: error.message }; }
      }
    } finally { busy = false; }
  }
  return {
    attach: receiver.attach,
    handleSignal(fromId, payload) {
      if (activePeer?.remoteId === fromId && ['answer', 'ice'].includes(payload.kind)) { activePeer.signal(payload); return true; }
      return false;
    },
    changed() { changeEpoch++; invalidate(); const pending = refreshing; void (async () => { if (pending) await pending; await refresh(); await tick(); })(); },
    async start() {
      await refresh();
      timer = setInterval(refresh, 10000); timer.unref?.();
      tickTimer = setInterval(() => void tick(), 1000); tickTimer.unref?.();
      void tick();
    },
    stop() { stopped = true; clearInterval(timer); clearInterval(tickTimer); invalidate(); },
    status() { return { busy, assigned: [...groups.keys()], leaseValid: Date.now() < leaseUntil, reports }; },
    refresh, tick
  };
}
