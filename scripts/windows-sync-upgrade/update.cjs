const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalized = value => value.toString('utf8').replace(/\r\n/g, '\n');
function fail(message) { throw new Error(message); }
function once(source, needle, replacement, label) {
  if (source.split(needle).length !== 2) fail('Unsupported source layout: ' + label + '. No files changed.');
  return source.replace(needle, () => replacement);
}
function targetPath(root, relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) fail('Path outside storage-client');
  return target;
}
function atomicWrite(filename, data) {
  const temp = filename + '.p2p-update-' + crypto.randomUUID();
  fs.writeFileSync(temp, data, { flag: 'wx' });
  fs.renameSync(temp, filename);
}
function main() {
  let root = path.resolve(process.argv[2] || '.');
  if (fs.existsSync(path.join(root, 'storage-client/package.json'))) root = path.join(root, 'storage-client');
  root = fs.realpathSync(root);
  const mode = process.argv[3] || '--check';
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'nas-bridge-storage-client' || pkg.type !== 'module') fail('This is not a supported NasBridge storage-client directory.');
  const base = path.join(root, '.nasbridge-updates');
  if (mode === '--rollback') {
    const id = process.argv[4];
    if (!id || !/^[0-9TZ-]+-[a-f0-9]{8}$/.test(id)) fail('Provide the backup ID printed by the update.');
    const backup = path.join(base, id);
    const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
    if (manifest.root !== root || !Array.isArray(manifest.files)) fail('Backup belongs to a different installation.');
    const allowed = new Set(["src/index.js","src/fsIndex.js","src/contentHash.js","src/syncPaths.js","src/syncStore.js","src/syncReceiver.js","src/bidirectionalSync.js","src/peerSync.js","src/syncGroupManager.js",".env"]);
    for (const item of manifest.files) {
      if (!allowed.has(item.relative)) fail('Invalid backup entry');
      const target = targetPath(root, item.relative);
      if (!fs.existsSync(target) || hash(fs.readFileSync(target)) !== item.after) fail('Files changed after upgrade; refusing to overwrite: ' + item.relative);
      if (item.existed && hash(fs.readFileSync(path.join(backup, item.relative))) !== item.before) fail('Backup integrity check failed');
    }
    for (const item of manifest.files) {
      const target = targetPath(root, item.relative);
      if (item.existed) atomicWrite(target, fs.readFileSync(path.join(backup, item.relative)));
      else fs.unlinkSync(target);
    }
    console.log('Rollback complete. Start the storage client using your usual method.');
    return;
  }
  if (!['--check', '--apply'].includes(mode)) fail('Use --check, --apply or --rollback BACKUP_ID');
  if (Number(process.versions.node.split('.')[0]) < 20) fail('Node.js 20 or newer is required.');
  const indexPath = path.join(root, 'src/index.js');
  const scanPath = path.join(root, 'src/fsIndex.js');
  const envPath = path.join(root, '.env');
  const indexBefore = fs.readFileSync(indexPath);
  const scanBefore = fs.readFileSync(scanPath);
  let index = normalized(indexBefore), scan = normalized(scanBefore);
  const hashCode = fs.readFileSync(path.join(__dirname, 'payload/contentHash.js'));
  const hashPath = path.join(root, 'src/contentHash.js');
  if (fs.existsSync(hashPath) && normalized(fs.readFileSync(hashPath)) !== normalized(hashCode)) fail('Existing contentHash.js differs. Manual review is required.');
  const importLine = "import { getContentHash } from './contentHash.js';";
  if (!scan.includes(importLine)) scan = once(scan, 'import mime from "mime-types";', 'import mime from "mime-types";\n' + importLine, 'fsIndex import');
  const hashField = "          ...(process.env.CONTENT_HASH_ENABLED === '1' ? { contentHash: await getContentHash(absolute, stat) } : {}),";
  if (!scan.includes(hashField)) {
    if (scan.includes('contentHash:')) fail('Existing hash implementation differs; manual review is required.');
    scan = once(scan, '          size: stat.size,', '          size: stat.size,\n' + hashField, 'file size field');
  }
  const ping = '    if (message.type === "ping") {\n      safeSend(JSON.stringify({ type: "pong", ts: message.ts }), "pong");\n      return;\n    }';
  const probe = "    if (message.type === 'probe-transfer') {\n      const chunk = Buffer.alloc(64 * 1024);\n      for (let i = 0; i < 4; i++) {\n        await waitForDrain('probe');\n        if (!safeSend(chunk, 'probe')) return;\n      }\n      safeSend(JSON.stringify({ type: 'probe-end', requestId: message.requestId, bytes: 256 * 1024 }), 'probe-end');\n      return;\n    }";
  if (!index.includes(probe)) {
    if (index.includes('probe-transfer')) fail('Existing probe implementation differs; manual review is required.');
    if (!index.includes('waitForDrain') || !index.includes('safeSend')) fail('Required transfer helpers are missing.');
    index = once(index, ping, ping + '\n\n' + probe, 'ping handler');
  }

  const managerImport = "import { createSyncGroupManager } from './syncGroupManager.js';";
  if (!index.includes(managerImport)) index = once(index, 'import { scanFiles, safeJoin } from "./fsIndex.js";', 'import { scanFiles, safeJoin } from "./fsIndex.js";\n' + managerImport, 'manager import');
  const hook = 'function wireDataChannel(channel, remotePeerId = "unknown-peer") {';
  const init = "const syncGroupManager = createSyncGroupManager({ storageRoot, api, clientId: () => state.clientId, iceServers, syncFiles, log: logWarn, sendSignal: (targetId, payload) => {\n  if (state.ws?.readyState !== WebSocket.OPEN) throw new Error('Signaling is offline');\n  state.ws.send(JSON.stringify({ type: 'signal', targetId, payload }));\n} });";
  if (!index.includes('const syncGroupManager =')) index = once(index, hook, init + '\n\n' + hook, 'manager initialization');
  const channel = "  if (process.env.SYNC_MODE === 'web-groups' && syncGroupManager.attach(channel, remotePeerId)) return;";
  if (!index.includes(channel)) index=once(index,hook,hook+'\n'+channel,'managed channel');
  const changeHook = "      if (message.type === 'sync-groups-changed' && process.env.SYNC_MODE === 'web-groups') { syncGroupManager.changed(); return; }";
  if (!index.includes(changeHook)) index=once(index,'      const message = JSON.parse(raw.toString());','      const message = JSON.parse(raw.toString());\n'+changeHook,'group notification');
  const signal = "        if (process.env.SYNC_MODE === 'web-groups' && syncGroupManager.handleSignal(message.fromId, message.payload)) return;";
  if (!index.includes(signal)) index=once(index,'      if (message.type === "signal") {','      if (message.type === "signal") {\n'+signal,'managed signaling');
  const start = "  if (process.env.SYNC_MODE === 'web-groups') await syncGroupManager.start();";
  if (!index.includes(start)) index=once(index,'  scheduleThumbnailBackfill("startup");',start+'\n  scheduleThumbnailBackfill("startup");','manager startup');
  const modules = ["syncPaths.js","syncStore.js","syncReceiver.js","bidirectionalSync.js","peerSync.js","syncGroupManager.js"].map(name => {
    const data=fs.readFileSync(path.join(__dirname,'payload',name)), target=path.join(root,'src',name);
    if(fs.existsSync(target) && normalized(fs.readFileSync(target))!==normalized(data)) fail('Existing '+name+' differs; manual review required.');
    return {relative:'src/'+name,data};
  });

  if (!fs.existsSync(envPath)) fail('storage-client/.env is missing. Find the active installation before updating.');
  const envBefore = fs.readFileSync(envPath);
  let env = normalized(envBefore);
  if (/^\s*export\s+CONTENT_HASH_ENABLED\s*=/m.test(env)) fail('Unusual CONTENT_HASH_ENABLED format; manual review is required.');
  const entries = env.match(/^\s*CONTENT_HASH_ENABLED\s*=.*$/gm) || [];
  if (entries.length > 1) fail('Duplicate CONTENT_HASH_ENABLED settings; manual review is required.');
  env = entries.length ? env.replace(/^\s*CONTENT_HASH_ENABLED\s*=.*$/m, 'CONTENT_HASH_ENABLED=1') : env.replace(/\n?$/, '\nCONTENT_HASH_ENABLED=1\n');

  const modeEntries = env.match(/^\s*SYNC_MODE\s*=.*$/gm) || [];
  if(modeEntries.length>1 || /^\s*export\s+SYNC_MODE\s*=/m.test(env)) fail('Ambiguous SYNC_MODE setting');
  env=modeEntries.length?env.replace(/^\s*SYNC_MODE\s*=.*$/m,'SYNC_MODE=web-groups'):env.replace(/\n?$/,'\nSYNC_MODE=web-groups\n');
  const preserveEol = (text, old) => Buffer.from(old.toString().includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
  const planned = [
    { relative: 'src/index.js', data: preserveEol(index, indexBefore) },
    { relative: 'src/fsIndex.js', data: preserveEol(scan, scanBefore) },
    { relative: 'src/contentHash.js', data: hashCode },
    ...modules,
    { relative: '.env', data: preserveEol(env, envBefore) }
  ];
  // Parse all candidate modules before writing anything into the installation.
  for (const item of planned.filter(item => item.relative.endsWith('.js'))) {
    const check = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: item.data, encoding: 'utf8' });
    if (check.status !== 0) fail('Syntax check failed for ' + item.relative + ': ' + check.stderr);
  }
  const changed = planned.filter(item => !fs.existsSync(targetPath(root, item.relative)) || !fs.readFileSync(targetPath(root, item.relative)).equals(item.data));
  console.log('Compatible installation: ' + root);
  console.log('Files to update: ' + (changed.map(item => item.relative).join(', ') || 'none (already updated)'));
  if (mode === '--check' || !changed.length) return;
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8);
  const backup = path.join(base, id);
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(base, '.gitignore'), '*\n');
  const records = changed.map(item => {
    const target = targetPath(root, item.relative);
    const existed = fs.existsSync(target);
    const before = existed ? fs.readFileSync(target) : null;
    if (existed) {
      const copy = path.join(backup, item.relative);
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.writeFileSync(copy, before, { flag: 'wx' });
    }
    return { relative: item.relative, existed, before: before ? hash(before) : null, after: hash(item.data) };
  });
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify({ root, id, files: records }, null, 2));
  const completed = [];
  try {
    for (const item of changed) {
      atomicWrite(targetPath(root, item.relative), item.data);
      completed.push(item.relative);
    }
  } catch (error) {
    for (const relative of completed.reverse()) {
      const record = records.find(item => item.relative === relative);
      if (record.existed) atomicWrite(targetPath(root, relative), fs.readFileSync(path.join(backup, relative)));
      else fs.unlinkSync(targetPath(root, relative));
    }
    throw error;
  }
  console.log('Update complete. Backup ID: ' + id);
  console.log('Backup directory: ' + backup);
  console.log('Start the storage client using your usual method. Initial hashing may take time.');
}
try { main(); } catch (error) { console.error('ERROR: ' + error.message); process.exitCode = 1; }
