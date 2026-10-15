import React, { useEffect, useState } from 'react';
import { apiRequest } from '../api.js';
import './SyncGroupsPanel.css';

export default function SyncGroupsPanel({ token, clients }) {
  const [data, setData] = useState({ groups: [], capabilities: {} });
  const [members, setMembers] = useState({}), [name, setName] = useState('文件同步组');
  const [coordinator, setCoordinator] = useState(''), [editing, setEditing] = useState('');
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState('');
  const label = id => clients.find(c => c.id === id)?.name || id;
  const load = async () => setData(await apiRequest('/api/sync-groups', { token }));
  useEffect(() => { let alive = true; const refresh = () => apiRequest('/api/sync-groups', { token }).then(d => { if (alive) setData(d); }).catch(e => { if (alive) setFeedback(e.message); }); refresh(); const timer = setInterval(refresh, 5000); return () => { alive = false; clearInterval(timer); }; }, [token]);
  const action = async (url, method, body, message) => {
    setBusy(true); setFeedback('');
    try { await apiRequest(url, { token, method, body }); await load(); setFeedback(message); return true; }
    catch (e) { setFeedback(e.message); return false; }
    finally { setBusy(false); }
  };
  const reset = () => { setEditing(''); setMembers({}); setCoordinator(''); setName('文件同步组'); };
  const selected = Object.keys(members);
  const save = async event => {
    event.preventDefault();
    if (await action('/api/sync-groups' + (editing ? '/' + editing : ''), editing ? 'PATCH' : 'POST', { name, coordinatorId: coordinator || selected[0], members: selected.map(clientId => ({ clientId, directory: members[clientId] })) }, '已关联，终端将自动开始同步。')) reset();
  };
  return <section className="syncGroupsPanel" aria-label="同步组">
    <div className="syncGroupsHeading"><h2>同步组</h2><span>关联即同步 · 双向更新 · 删除同步</span></div>
    <p>选择 2–8 个终端及各自的子目录。同组内的新增、修改和删除会自动同步；取消关联后保留已同步的文件。</p>
    <form onSubmit={save} className="syncGroupsForm">
      <label>组名称<input aria-label="组名称" value={name} maxLength={80} onChange={e => setName(e.target.value)} required /></label>
      <div className="syncGroupsMembers">{clients.map(client => {
        const ready = data.capabilities[client.id]?.protocol === 3 && client.status !== 'disabled';
        return <div className="syncGroupsMember" key={client.id}>
          <label><input type="checkbox" checked={client.id in members} disabled={busy || (!ready && !(client.id in members))} onChange={e => { setMembers(old => { const next = { ...old }; if (e.target.checked) next[client.id] = 'sync-test'; else delete next[client.id]; return next; }); if (coordinator === client.id && !e.target.checked) setCoordinator(''); }} />{client.name || client.id}<small>{ready ? '可关联' : '请升级并启动终端'}</small></label>
          {client.id in members && <input aria-label={label(client.id) + ' 同步目录'} value={members[client.id]} placeholder="例如 sync-test" required onChange={e => setMembers(old => ({ ...old, [client.id]: e.target.value }))} />}
        </div>;
      })}</div>
      <label>协调终端<select aria-label="协调终端" value={coordinator || selected[0] || ''} onChange={e => setCoordinator(e.target.value)}><option value="" disabled>请选择终端</option>{selected.map(id => <option key={id} value={id}>{label(id)}</option>)}</select></label>
      <p className="syncGroupsHint">目录相对于各端存储根目录，例如本机 sync-test 对应 D:\Nas\sync-test。协调终端需保持运行，每 60 秒检查一次变化。首次关联合并现有文件；同时修改的内容另存冲突副本。删除的文件移入各端 .nas-bot 下的同步回收区。</p>
      <div className="syncGroupsActions"><button disabled={busy || selected.length < 2 || selected.length > 8} type="submit">{editing ? '保存关联' : '关联并开始同步'}</button>{editing && <button type="button" onClick={reset}>取消编辑</button>}</div>
    </form>
    {feedback && <p role="status" className="syncGroupsFeedback">{feedback}</p>}
    <div className="syncGroupsCards">{data.groups.map(group => <article key={group.id} className="syncGroupsCard">
      <div className="syncGroupsHeading"><h3>{group.name}</h3><span>{group.members.length} 个终端 · 协调端 {label(group.coordinatorId)}</span></div>
      {group.members.map(member => { const report = group.reports?.[member.clientId]; return <div className="syncGroupsLinked" key={member.clientId}><div><strong>{label(member.clientId)}</strong><code>{member.directory}</code><small>{data.capabilities[member.clientId] ? report?.message || '等待终端接收配置' : '终端离线或尚未升级'}{report?.summary && ' · ' + report.summary}</small></div><button disabled={busy} onClick={() => action('/api/sync-groups/' + group.id + '/members/' + encodeURIComponent(member.clientId), 'DELETE', undefined, '已取消关联。在线终端立即停止相关同步；断线终端的授权最多 30 秒后失效。已同步文件保留。')}>取消关联</button></div>; })}
      <div className="syncGroupsActions"><button disabled={busy} onClick={() => action('/api/sync-groups/' + group.id + '/run', 'POST', {}, '已通知协调端立即同步。')}>立即同步</button><button disabled={busy} onClick={() => { setEditing(group.id); setName(group.name); setMembers(Object.fromEntries(group.members.map(m => [m.clientId, m.directory]))); setCoordinator(group.coordinatorId); }}>编辑关联</button><button disabled={busy} onClick={() => action('/api/sync-groups/' + group.id, 'DELETE', undefined, '已解除整组关联，文件保留。断线终端的授权最多 30 秒后失效。')}>解除整组关联</button></div>
    </article>)}</div>
    {!data.groups.length && <p className="syncGroupsHint">还没有同步组。关联后会自动执行，无需运行命令。</p>}
  </section>;
}
