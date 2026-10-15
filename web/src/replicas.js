export function contentIdentity(file) {
  const hash = String(file?.contentHash || '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) && Number.isSafeInteger(file.size) && file.size >= 0 ? `${hash}:${file.size}` : '';
}

export function groupFileReplicas(files) {
  const groups = new Map();
  for (const file of files) {
    const identity = contentIdentity(file);
    // Preserve the directory tree: copies in other folders stay visible there.
    const directory = String(file.path || '').replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    const key = identity ? `${directory}\0${identity}` : `file:${file.id}`;
    if (!groups.has(key)) groups.set(key, { ...file, replicas: [] });
    const group = groups.get(key);
    group.replicas.push(file);
  }
  return [...groups.values()];
}

export function findReplicas(file, onlineFiles) {
  const identity = contentIdentity(file);
  return onlineFiles.filter(candidate => identity ? contentIdentity(candidate) === identity : candidate.id === file.id);
}

export function rankReplicas(files, samples, bytes = 8 * 1024 * 1024) {
  const score = file => {
    const sample = samples[file.clientId];
    if (sample?.reachable === false) return Infinity;
    const bps = sample?.bytesPerSecond > 0 ? sample.bytesPerSecond : 1024 * 1024;
    const latency = Number.isFinite(sample?.latencyMs) ? sample.latencyMs / 1000 : 1;
    return latency + Math.min(bytes, 8 * 1024 * 1024) / bps;
  };
  return [...files].sort((a, b) => score(a) - score(b));
}

const measurements = new WeakMap();
export async function selectReplica(p2p, file, onlineFiles, role, excluded = []) {
  const candidates = findReplicas(file, onlineFiles).filter(f => !excluded.includes(f.clientId));
  if (!candidates.length) throw new Error('没有可用的在线副本');
  if (candidates.length === 1) return candidates[0];
  let cache = measurements.get(p2p);
  if (!cache) { cache = new Map(); measurements.set(p2p, cache); }
  const samples = {};
  // Bound probing to three nodes; cached samples are reused for one minute.
  await Promise.all([...new Set(candidates.map(f => f.clientId))].slice(0, 3).map(async id => {
    const key = `${role}:${id}`;
    let entry = cache.get(key);
    if (!entry || Date.now() - entry.time > 60000) {
      entry = { time: Date.now(), value: p2p.sampleNode(id, role).catch(() => ({ reachable: false })) };
      cache.set(key, entry);
    }
    samples[id] = await entry.value;
  }));
  const available = candidates.filter(f => samples[f.clientId]?.reachable !== false);
  if (!available.length) throw new Error('副本节点均无法连接');
  return rankReplicas(available, samples, file.size)[0];
}

export async function samplePeerNode(bridge, clientId) {
  const peer = await Promise.race([
    bridge.getPeer(clientId),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Node connection timeout')), 8000))
  ]);
  return new Promise((resolve, reject) => {
    const channel = peer.pc.createDataChannel(`nas-probe-${Date.now()}`, { ordered: true });
    channel.binaryType = 'arraybuffer';
    let pingAt, latencyMs, started, bytes = 0, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); channel.close();
      if (error && latencyMs === undefined) reject(error);
      else resolve({ reachable: true, latencyMs, bytesPerSecond: bytes ? bytes * 1000 / Math.max(1, performance.now() - started) : null, measuredAt: Date.now() });
    };
    const timer = setTimeout(() => finish(new Error('Node probe timeout')), 2000);
    channel.onopen = () => { pingAt = performance.now(); channel.send(JSON.stringify({ type: 'ping', ts: Date.now() })); };
    channel.onmessage = event => {
      if (typeof event.data !== 'string') { bytes += event.data.byteLength; return; }
      const m = JSON.parse(event.data);
      if (m.type === 'pong') {
        latencyMs = performance.now() - pingAt;
        started = performance.now();
        channel.send(JSON.stringify({ type: 'probe-transfer', requestId: 'probe' }));
      }
      if (m.type === 'probe-end') finish();
    };
    channel.onerror = () => finish(new Error('Node probe failed'));
    channel.onclose = () => { if (!settled) finish(new Error('Node probe closed')); };
  });
}
