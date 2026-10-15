const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const os = require('node:os');
const updater = path.resolve(__dirname, '../scripts/windows-sync-upgrade/update.cjs');
const baseline = 'f9b9e5d7d85d803f1c3fd763c5f86199f94629fc';
function fixture(eol = '\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasbridge-upgrade-test-'));
  const client = path.join(root, 'storage-client');
  fs.mkdirSync(path.join(client, 'src'), { recursive: true });
  for (const file of ['package.json', 'src/index.js', 'src/fsIndex.js']) {
    const data = execFileSync('git', ['show', baseline + ':storage-client/' + file], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }).replace(/\r\n/g, '\n').replace(/\n/g, eol);
    fs.writeFileSync(path.join(client, file), data + (file.endsWith('.js') ? eol + '// Preserve this installation customization.' + eol : ''));
  }
  fs.writeFileSync(path.join(client, '.env'), ['CLIENT_NAME=LocalStorage-TYPE2ZING', 'STORAGE_ROOT=E:/existing-data', 'JWT_SECRET=dummy-secret-for-offline-test', 'MAGPIE=unchanged', ''].join(eol));
  const before = snapshot(client);
  return { root, client, before };
}
function snapshot(client) {
  return Object.fromEntries(['package.json', 'src/index.js', 'src/fsIndex.js', '.env'].map(file => [file, fs.readFileSync(path.join(client, file))]));
}
function run(root, mode, id) {
  return spawnSync(process.execPath, [updater, root, mode, ...(id ? [id] : [])], { encoding: 'utf8' });
}
function backupId(result) {
  return result.stdout.match(/Backup ID: (\S+)/)?.[1];
}
for (const [name, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(name + ': check, apply, repeat, rollback preserve unrelated code and configuration', () => {
    const f = fixture(eol);
    let result = run(f.root, '--check');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(f.client), f.before);
    result = run(f.root, '--apply');
    assert.equal(result.status, 0, result.stderr);
    const id = backupId(result);
    assert.ok(id);
    const env = fs.readFileSync(path.join(f.client, '.env'), 'utf8');
    assert.ok(env.startsWith(f.before['.env'].toString()));
    assert.ok(env.includes('CONTENT_HASH_ENABLED=1')); assert.ok(env.includes('SYNC_MODE=web-groups'));
    for (const file of ['src/index.js', 'src/fsIndex.js']) assert.ok(fs.readFileSync(path.join(f.client, file), 'utf8').includes('// Preserve this installation customization.'));
    const after = snapshot(f.client);
    result = run(f.client, '--apply');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('already updated'));
    assert.deepEqual(snapshot(f.client), after);
    result = run(f.root, '--rollback', id);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(f.client), f.before);
    for (const name of ["contentHash.js","syncPaths.js","syncStore.js","syncReceiver.js","bidirectionalSync.js","peerSync.js","syncGroupManager.js"]) assert.equal(fs.existsSync(path.join(f.client, 'src', name)), false);
  });
}
test('unsupported source stops before modifying anything', () => {
  const f = fixture();
  const index = path.join(f.client, 'src/index.js');
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('if (message.type === "ping")', 'if (message.type === "custom-ping")'));
  const before = snapshot(f.client);
  const result = run(f.root, '--apply');
  assert.notEqual(result.status, 0);
  assert.deepEqual(snapshot(f.client), before);
  assert.equal(fs.existsSync(path.join(f.client, 'src/contentHash.js')), false);
});
test('rollback refuses to overwrite edits made after update', () => {
  const f = fixture();
  const result = run(f.root, '--apply');
  assert.equal(result.status, 0, result.stderr);
  fs.appendFileSync(path.join(f.client, 'src/index.js'), '\n// Later user edit\n');
  const before = snapshot(f.client);
  const rollback = run(f.root, '--rollback', backupId(result));
  assert.notEqual(rollback.status, 0);
  assert.deepEqual(snapshot(f.client), before);
});
test('hash config is updated without duplicate keys or leaked values', () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.client, '.env'), 'CONTENT_HASH_ENABLED=0\n');
  const result = run(f.root, '--apply');
  assert.equal(result.status, 0, result.stderr);
  const env = fs.readFileSync(path.join(f.client, '.env'), 'utf8');
  assert.equal(env.match(/CONTENT_HASH_ENABLED=/g).length, 1);
  assert.ok(env.includes('CONTENT_HASH_ENABLED=1'));
  assert.ok(!result.stdout.includes('dummy-secret'));
  assert.ok(!result.stderr.includes('dummy-secret'));
});
