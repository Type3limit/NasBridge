import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function normalizeGroupDirectory(value) {
  const text = String(value || '').replace(/\\/g, '/').trim();
  if (!text || text.length > 240 || text.startsWith('/') || /[\x00-\x1f:]/.test(text)) throw new Error('请选择存储根目录下的子目录');
  if (text.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /[<>"|?*]/.test(s) || /^\.nas-/i.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) throw new Error('同步目录不合法');
  return text;
}
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
// Chat attachments are mirrored across every storage node by a group the server
// maintains itself; admins cannot edit it and user groups cannot use .nas- folders.
export const CHAT_ATTACHMENT_GROUP_ID = '00000000-0000-4000-8000-00000000c4a7';
const CHAT_ATTACHMENT_DIRECTORY = '.nas-chat-room/attachments';
const isSystemGroup = group => group?.system === 'chat-attachments';
export function createSyncGroupRegistry({ filename = path.resolve(process.cwd(), 'server/data/sync-groups.json'), clients, notify = () => {} }) {
  const reports = new Map();
  const read = () => {
    if (!fs.existsSync(filename)) return { groups: [] };
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(value.groups)) throw new Error('Invalid synchronization registry');
    return value;
  };
  const write = value => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temp = filename + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, filename);
  };
  const capability = id => {
    const report = reports.get(id);
    return report && Date.now() - report.time < 90000 ? report : null;
  };
  const validate = (body, existing, others) => {
    if (!Array.isArray(body.members) || body.members.length < 2 || body.members.length > 8) throw new Error('请选择 2 到 8 个终端');
    const known = new Map(clients().map(c => [c.id, c]));
    const seen = new Set();
    const members = body.members.map(member => {
      const clientId = String(member.clientId || ''), directory = normalizeGroupDirectory(member.directory);
      if (!known.has(clientId) || known.get(clientId).status === 'disabled' || seen.has(clientId)) throw new Error('终端不存在、已禁用或重复');
      seen.add(clientId);
      if (capability(clientId)?.protocol !== 3) throw new Error('请先升级所有所选终端，并保持在线');
      for (const group of others) for (const other of group.members) {
        if (other.clientId === clientId && overlaps(directory.toLowerCase(), other.directory.toLowerCase())) throw new Error('该终端的目录已关联其他同步组，不能重复或嵌套关联');
      }
      return { clientId, directory };
    });
    const coordinatorId = String(body.coordinatorId || existing?.coordinatorId || members[0].clientId);
    if (!seen.has(coordinatorId)) throw new Error('协调终端必须在组内');
    return { name: String(body.name || existing?.name || '同步组').trim().slice(0, 80), members, coordinatorId, enabled: body.enabled !== false };
  };
  const broadcast = (oldGroup, group) => notify([...new Set([...(oldGroup?.members || []), ...(group?.members || [])].map(m => m.clientId))], { type: 'sync-groups-changed' });
  const syncChatAttachmentGroup = data => {
    const nodes = clients().filter(c => c.status !== 'disabled')
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)))
      .slice(0, 8);
    const index = data.groups.findIndex(isSystemGroup);
    const old = index >= 0 ? data.groups[index] : null;
    if (nodes.length < 2) {
      if (old) { data.groups.splice(index, 1); write(data); broadcast(old, null); }
      return data;
    }
    const members = nodes.map(c => ({ clientId: c.id, directory: CHAT_ATTACHMENT_DIRECTORY }));
    // Keep the coordinator while it is online so the pairwise sync state survives.
    const online = nodes.filter(c => c.status === 'online');
    const coordinatorId = online.some(c => c.id === old?.coordinatorId) ? old.coordinatorId
      : online[0]?.id || (members.some(m => m.clientId === old?.coordinatorId) ? old.coordinatorId : members[0].clientId);
    if (old && old.coordinatorId === coordinatorId && old.members.map(m => m.clientId).join() === members.map(m => m.clientId).join()) return data;
    const group = old
      ? { ...old, members, coordinatorId, revision: old.revision + 1, runSequence: (old.runSequence || 0) + 1 }
      : { id: CHAT_ATTACHMENT_GROUP_ID, system: 'chat-attachments', name: '聊天室附件', members, coordinatorId, enabled: true, revision: 1, runSequence: 1, createdBy: 'system', createdAt: new Date().toISOString() };
    if (old) data.groups[index] = group; else data.groups.push(group);
    write(data); broadcast(old, group);
    return data;
  };
  const userGroup = (data, id) => {
    const group = data.groups.find(g => g.id === id);
    if (!group) throw new Error('同步组不存在');
    if (isSystemGroup(group)) throw new Error('聊天室附件同步组由服务器自动维护');
    return group;
  };
  return {
    list() {
      return { groups: syncChatAttachmentGroup(read()).groups.map(g => ({ ...g, reports: Object.fromEntries(g.members.map(m => [m.clientId, capability(m.clientId)?.groups?.[g.id] || null])) })), capabilities: Object.fromEntries(clients().map(c => [c.id, capability(c.id) ? { protocol: capability(c.id).protocol, seenAt: new Date(capability(c.id).time).toISOString() } : null])) };
    },
    assigned(clientId) {
      const all = clients();
      const online = new Map(all.map(c => [c.id, c.status !== 'disabled']));
      const connected = new Set(all.filter(c => c.status === 'online').map(c => c.id));
      // `online` lets the coordinator skip members it cannot reach this round.
      return { leaseMs: 30000, groups: syncChatAttachmentGroup(read()).groups
        .filter(g => g.enabled && g.members.some(m => m.clientId === clientId) && g.members.every(m => online.get(m.clientId)))
        .map(g => ({ ...g, members: g.members.map(m => ({ ...m, online: connected.has(m.clientId) })) })) };
    },
    report(clientId, body) {
      const assigned = new Set(read().groups.filter(g => g.members.some(m => m.clientId === clientId)).map(g => g.id));
      const groups = {};
      for (const [id, report] of Object.entries(body.groups || {}).slice(0, 24)) {
        if (!assigned.has(id)) continue;
        groups[id] = { state: ['idle', 'running', 'error', 'waiting', 'stopped'].includes(report.state) ? report.state : 'idle', revision: Number(report.revision || 0), updatedAt: new Date().toISOString(), message: String(report.message || '').slice(0, 300), lastCompletedAt: String(report.lastCompletedAt || '').slice(0, 40), summary: String(report.summary || '').slice(0, 300) };
      }
      reports.set(clientId, { protocol: body.protocol === 3 ? 3 : 0, time: Date.now(), groups });
      return { ok: true };
    },
    create(body, actor) {
      const data = read();
      if (data.groups.filter(g => !isSystemGroup(g)).length >= 24) throw new Error('最多支持 24 个同步组');
      const group = { id: crypto.randomUUID(), ...validate(body, null, data.groups), revision: 1, runSequence: 1, createdBy: actor, createdAt: new Date().toISOString() };
      data.groups.push(group); write(data); broadcast(null, group); return group;
    },
    update(id, body) {
      const data = read(), old = userGroup(data, id), index = data.groups.indexOf(old);
      const group = { ...old, ...validate({ ...old, ...body }, old, data.groups.filter(g => g.id !== id)), revision: old.revision + 1, runSequence: (old.runSequence || 0) + 1 };
      data.groups[index] = group; write(data); broadcast(old, group); return group;
    },
    remove(id) {
      const data = read(), old = userGroup(data, id);
      data.groups = data.groups.filter(g => g.id !== id); write(data); broadcast(old, null); return { ok: true };
    },
    detach(id, clientId) {
      const data = read(), old = userGroup(data, id);
      const members = old.members.filter(m => m.clientId !== clientId);
      if (members.length === old.members.length) throw new Error('终端不在此同步组中');
      if (members.length < 2) return this.remove(id);
      // Detaching must work even when another endpoint is offline or out of date.
      const group = { ...old, members, coordinatorId: members.some(m => m.clientId === old.coordinatorId) ? old.coordinatorId : members[0].clientId, revision: old.revision + 1, runSequence: (old.runSequence || 0) + 1 };
      data.groups[data.groups.findIndex(g => g.id === id)] = group; write(data); broadcast(old, group); return group;
    },
    run(id) {
      const data = read(), group = data.groups.find(g => g.id === id);
      if (!group) throw new Error('同步组不存在');
      group.runSequence = (group.runSequence || 0) + 1; write(data); broadcast(group, group); return { ok: true };
    }
  };
}

export function installSyncGroupRoutes(app, { requireAuth, requireRole, clients, notify, filename }) {
  const registry = createSyncGroupRegistry({ clients, notify, filename });
  const route = fn => (req, res) => { try { res.json(fn(req)); } catch (e) { res.status(400).json({ message: e.message }); } };
  app.get('/api/sync-groups', requireAuth, requireRole('admin'), route(() => registry.list()));
  app.post('/api/sync-groups', requireAuth, requireRole('admin'), route(req => ({ group: registry.create(req.body, req.auth.sub) })));
  app.patch('/api/sync-groups/:id', requireAuth, requireRole('admin'), route(req => ({ group: registry.update(req.params.id, req.body) })));
  app.delete('/api/sync-groups/:id', requireAuth, requireRole('admin'), route(req => registry.remove(req.params.id)));
  app.delete('/api/sync-groups/:id/members/:clientId', requireAuth, requireRole('admin'), route(req => registry.detach(req.params.id, req.params.clientId)));
  app.post('/api/sync-groups/:id/run', requireAuth, requireRole('admin'), route(req => registry.run(req.params.id)));
  app.get('/api/client/sync-groups', requireAuth, requireRole('client'), route(req => registry.assigned(req.auth.sub)));
  app.post('/api/client/sync-control', requireAuth, requireRole('client'), route(req => registry.report(req.auth.sub, req.body)));
  return registry;
}
