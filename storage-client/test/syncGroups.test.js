import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSyncGroupRegistry } from '../../server/src/syncGroups.js';
import { createSyncGroupManager } from '../src/syncGroupManager.js';
import { SyncStore } from '../src/syncStore.js';

const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nas-groups-'));
  const nodes = ['A', 'B', 'C'].map(id => ({ id, status: 'online' }));
  const notices = [];
  const registry = createSyncGroupRegistry({ filename: path.join(root, 'groups.json'), clients: () => nodes, notify: (...args) => notices.push(args) });
  for (const c of nodes) registry.report(c.id, { protocol: 3 });
  const body = { name: 'test', coordinatorId: 'A', members: nodes.map(c => ({ clientId: c.id, directory: 'sync-test' })) };
  return { root, registry, body, notices };
};
const remoteStore = b => ({
  scan: () => b.scan(), stat: p => b.stat(p), remove: (p,h) => b.remove(p,h),
  download: async (r,out) => { const c = await b.capture(r.path,r.contentHash); try { await fs.copyFile(c.temp,out,1); } finally { await fs.unlink(c.temp); } },
  upload: async (p,c,h) => { const t = await b.staging(); try { await fs.copyFile(c.temp,t,1); await b.commit(p,t,h,c.contentHash); } finally { await fs.unlink(t).catch(()=>{}); } }
});
test('web registry supports multiple nodes, scopes, immediate unlink and persistent revisions', async () => {
  const f = await fixture();
  try {
    const g = f.registry.create(f.body,'admin');
    assert.equal(f.registry.assigned('C').groups.length,1);
    assert.throws(() => f.registry.create(f.body,'admin'), /重复或嵌套/);
    assert.throws(() => f.registry.update(g.id,{members:[{clientId:'A',directory:'../escape'},{clientId:'B',directory:'x'}]}));
    const changed = f.registry.detach(g.id,'A');
    assert.equal(changed.coordinatorId,'B'); assert.equal(changed.revision,2);
    assert.equal(f.registry.assigned('A').groups.length,0);
    f.registry.detach(g.id,'C'); assert.equal(f.registry.list().groups.length,0);
    assert.ok(f.notices.length >= 3);
    assert.throws(() => f.registry.create({...f.body,members:[{clientId:'A',directory:'x'},{clientId:'unknown',directory:'x'}]},'admin'));
  } finally { await fs.rm(f.root,{recursive:true,force:true}); }
});
test('three-node web group automatically converges additions, edits and deletes, then unlink stops writes', async () => {
  const f = await fixture(); let manager;
  try {
    const stores = {};
    for (const id of ['A','B','C']) { await fs.mkdir(path.join(f.root,id,'sync-test'),{recursive:true}); stores[id]=new SyncStore(path.join(f.root,id),'sync-test'); }
    let g = f.registry.create(f.body,'admin'), opens = 0;
    manager = createSyncGroupManager({storageRoot:path.join(f.root,'A'),clientId:()=> 'A',syncFiles:async()=>{},api:async(url,opts)=>url.endsWith('sync-control')?f.registry.report('A',JSON.parse(opts.body)):f.registry.assigned('A'),peerFactory:id=>({ remoteId:id,open:async()=>{opens++;},ping:async()=>{},close(){},remoteStore:()=>remoteStore(stores[id]) })});
    const round = async()=>{ f.registry.run(g.id); await manager.refresh(); await manager.tick(); };
    await fs.writeFile(await stores.B.resolve('file.txt'),'B initial');
    await round(); await round();
    for (const s of Object.values(stores)) assert.equal(await fs.readFile(await s.resolve('file.txt'),'utf8'),'B initial');
    await fs.writeFile(await stores.C.resolve('file.txt'),'C edit'); await round(); await round();
    for (const s of Object.values(stores)) assert.equal(await fs.readFile(await s.resolve('file.txt'),'utf8'),'C edit');
    await fs.unlink(await stores.C.resolve('file.txt')); await round(); await round();
    for (const s of Object.values(stores)) assert.equal(await s.stat('file.txt'),null);
    assert.equal(manager.status().reports[g.id].state,'idle');
    f.registry.remove(g.id); await manager.refresh(); const before=opens;
    await fs.writeFile(await stores.B.resolve('after.txt'),'keep here'); await manager.tick();
    assert.equal(opens,before); assert.equal(await stores.A.stat('after.txt'),null);
  } finally { manager?.stop(); await fs.rm(f.root,{recursive:true,force:true}); }
});
test('revocation discards stale in-flight configuration and cancels staged file mutations', async () => {
  const f = await fixture(); let manager;
  try {
    f.registry.create(f.body,'admin'); let resolve, calls=0;
    manager=createSyncGroupManager({storageRoot:f.root,clientId:()=> 'B',syncFiles:async()=>{},api:async url=>{ if(url.endsWith('sync-control'))return{}; if(++calls===1)return new Promise(r=>resolve=r); return {groups:[],leaseMs:30000}; }});
    const pending=manager.refresh(); manager.changed(); resolve(f.registry.assigned('B')); await pending;
    for(let i=0;i<20 && calls<2;i++)await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(manager.status().assigned,[]);
    let active=true; const store=new SyncStore(f.root,'guarded',{guard:()=>active}); await store.scan();
    await fs.writeFile(await store.resolve('keep.txt'),'keep'); const stat=await store.stat('keep.txt'); active=false;
    await assert.rejects(store.remove('keep.txt',stat.contentHash),/授权|取消/);
    assert.equal(await fs.readFile(path.join(f.root,'guarded/keep.txt'),'utf8'),'keep');
  } finally {manager?.stop(); await fs.rm(f.root,{recursive:true,force:true});}
});
