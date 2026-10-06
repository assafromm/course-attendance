import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, digest } from '../server/store.js';

test('revocation immediately stops existing lecturer sessions and course access',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'attendance-access-test-')),'fixture.sqlite');
  const fixture=createStore(path),teacherToken='test-lecturer-session-token',teacher='teacher@mail.huji.ac.il';
  fixture.run("INSERT INTO teachers(email,role) VALUES(?,'teacher')",teacher);
  fixture.run('INSERT INTO auth_sessions VALUES(?,?,?)',digest(teacherToken),teacher,Date.now()+600000);fixture.db.close();
  const child=spawn(process.execPath,['server/index.js'],{cwd:process.cwd(),env:{...process.env,PORT:'4191',HOST:'127.0.0.1',NODE_ENV:'development',DEV_LOGIN:'true',DATABASE_PATH:path,FRONTEND_URL:'http://localhost:4191'},stdio:['ignore','pipe','pipe']});
  let output='',adminToken='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const api=async(route,body,token=adminToken)=>{const r=await fetch(`http://127.0.0.1:4191/api${route}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
  try{
    for(let i=0;i<150;i++){try{if((await api('/config')).status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));if(i===149)throw new Error(output);}
    adminToken=(await api('/auth/dev',{})).data.token;
    const c=(await api('/courses',{name:'גישה לבדיקה',code:'00000',group_name:'1'})).data;
    await api(`/courses/${c.id}/members`,{email:teacher});
    assert.equal((await api(`/courses/${c.id}`,null,teacherToken)).status,200);
    assert.equal((await api('/teachers',null,teacherToken)).status,403);
    assert.equal((await api(`/courses/${c.id}/members/revoke`,{email:teacher},teacherToken)).status,403);
    await api(`/courses/${c.id}/members/revoke`,{email:teacher});
    assert.equal((await api(`/courses/${c.id}`,null,teacherToken)).status,403);
    assert.equal((await api('/me',null,teacherToken)).status,200);
    await api(`/courses/${c.id}/members`,{email:teacher});
    await api('/teachers/revoke',{email:teacher});
    assert.equal((await api('/me',null,teacherToken)).status,401);
    assert.equal((await api(`/courses/${c.id}/members`,{email:teacher})).status,403);
    assert.equal((await api('/teachers')).data.find(t=>t.email===teacher).active,0);
    await api('/teachers',{email:teacher});
    assert.equal((await api('/teachers')).data.find(t=>t.email===teacher).active,1);
    assert.equal((await api('/me',null,teacherToken)).status,401);
    assert.equal((await api('/teachers/revoke',{email:'demo@local.test'})).status,400);
    assert.equal((await api(`/courses/${c.id}/members/revoke`,{email:'demo@local.test'})).status,400);
  }finally{child.kill();}
});
