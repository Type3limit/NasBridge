import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installSyncGroupRoutes } from '../src/syncGroups.js';
import { requireAuth, requireRole } from '../src/middleware.js';
import { signUserToken, signClientToken } from '../src/auth.js';

test('group HTTP routes enforce admin management and client-scoped assignment, including unlink while offline', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nas-group-http-')),previous=process.env.JWT_SECRET;
  process.env.JWT_SECRET='isolated-test-secret-never-used-in-production';
  const app=express();app.use(express.json());
  const nodes=[{id:'A',status:'online'},{id:'B',status:'online'},{id:'C',status:'online'}];
  installSyncGroupRoutes(app,{requireAuth,requireRole,filename:path.join(root,'groups.json'),clients:()=>nodes});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const admin=signUserToken({id:'admin',role:'admin'}),user=signUserToken({id:'user',role:'user'}),tokens=Object.fromEntries(nodes.map(c=>[c.id,signClientToken(c)]));
  const call=(url,token,method='GET',body)=>fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  try {
    assert.equal((await call('/api/sync-groups')).status,401);
    for(const token of [user,tokens.A])assert.equal((await call('/api/sync-groups',token,'POST',{})).status,403);
    for(const id of ['A','B'])assert.equal((await call('/api/client/sync-control',tokens[id],'POST',{protocol:3})).status,200);
    const created=await call('/api/sync-groups',admin,'POST',{members:[{clientId:'A',directory:'test'},{clientId:'B',directory:'test'}]});assert.equal(created.status,200);const{group}=await created.json();
    assert.equal((await(await call('/api/client/sync-groups',tokens.C)).json()).groups.length,0);
    assert.equal((await(await call('/api/client/sync-groups',tokens.B)).json()).groups.length,1);
    assert.equal((await call('/api/sync-groups/'+group.id,admin,'PATCH',{members:[{clientId:'A',directory:'test'},{clientId:'C',directory:'test'}]})).status,400);
    nodes[1].status='offline';
    assert.equal((await call('/api/sync-groups/'+group.id+'/members/B',admin,'DELETE')).status,200);
    assert.equal((await(await call('/api/client/sync-groups',tokens.A)).json()).groups.length,0);
  } finally {await new Promise(r=>server.close(r));if(previous===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previous;await fs.rm(root,{recursive:true,force:true});}
});
