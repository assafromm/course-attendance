import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('HTTP workflow: authentication, roster updates, claims, corrections, access control, closure',async()=>{
  const child=spawn(process.execPath,['server/index.js'],{cwd:process.cwd(),env:{...process.env,PORT:'4189',HOST:'127.0.0.1',NODE_ENV:'development',DEV_LOGIN:'true',DATABASE_PATH:':memory:',FRONTEND_URL:'http://localhost:4189'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  let token='';
  const api=async(path,body,method='POST',auth=true)=>{
    const r=await fetch(`http://127.0.0.1:4189/api${path}`,{method:body?method:'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(auth&&token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};
  };
  try{
    for(let i=0;i<150;i++){try{const r=await api('/config');if(r.status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));if(i===149)throw new Error(output);}
    assert.equal((await api('/courses')).status,401);
    token=(await api('/auth/dev',{})).data.token;assert.ok(token);
    const course=(await api('/courses',{name:'בדיקת API',code:'00000',group_name:'1'})).data;
    const students=[{identifier:'000000001',first_name:'נועה',last_name:'בדיקה'},{identifier:'000000002',first_name:'אורי',last_name:'בדיקה'}];
    const newCourse={name:'קורס עם רשימה',code:'55945',group_name:'1',year:'תשפ״ז',semester:'א׳'};
    const before=(await api('/courses')).data.length;
    assert.equal((await api('/courses/with-roster',newCourse)).status,400);
    assert.equal((await api('/courses/with-roster',{...newCourse,students:[students[0],students[0]]})).status,400);
    assert.equal((await api('/courses')).data.length,before);
    const created=await api('/courses/with-roster',{...newCourse,students});
    assert.equal(created.status,201);assert.equal(created.data.student_count,2);
    assert.ok(created.data.name.includes('תשפ״ז'));assert.ok(created.data.name.includes('סמסטר א׳'));
    const imported=(await api(`/courses/${created.data.id}`)).data.students;
    assert.equal(imported.length,2);assert.ok(imported.some(s=>s.identifier==='000000001'));
    assert.equal((await api(`/courses/${course.id}/students`,{students})).status,200);
    assert.equal((await api(`/courses/${course.id}/students`,{students:[students[0],students[0]]})).status,400);
    let roster=(await api(`/courses/${course.id}`)).data.students;assert.equal(roster[0].identifier.length,9);
    const m=(await api(`/courses/${course.id}/meetings`,{title:'מפגש',date:'2026-10-06'})).data;
    const slips=(await api(`/meetings/${m.id}/slips`,{count:3})).data.slips;
    const parallel=await Promise.all(slips.slice(0,2).map(s=>api(`/slip/${s.token}/claim`,{studentId:roster[0].id},'POST',false)));
    assert.deepEqual(parallel.map(r=>r.status).sort(),[200,409]);
    const successful=slips[parallel.findIndex(r=>r.status===200)],unused=slips[parallel.findIndex(r=>r.status===409)];
    assert.equal((await api(`/slip/${unused.token}`)).data.previous,null);
    const correction=await api(`/slip/${successful.token}/claim`,{studentId:roster[1].id},'POST',false);assert.equal(correction.status,200);assert.equal(correction.data.corrected,true);
    assert.equal((await api(`/slip/${successful.token}`)).data.previous.identifier,roster[1].identifier);
    assert.equal((await api(`/slip/${unused.token}/claim`,{studentId:roster[0].id},'POST',false)).status,200);
    students[0].first_name='נועה מעודכנת';await api(`/courses/${course.id}/students`,{students});
    assert.equal((await api(`/meetings/${m.id}`)).data.attendance.length,2);
    assert.equal((await api('/courses/not-owned')).status,403);
    await api(`/meetings/${m.id}`,{closed:true},'PATCH');
    assert.equal((await api(`/slip/${successful.token}/claim`,{studentId:roster[0].id},'POST',false)).status,409);
    assert.equal((await api(`/slip/${successful.token}`)).data.students.length,0);
    const log=(await api(`/courses/${course.id}/audit`)).data;
    assert.ok(log.some(l=>l.action==='attendance.corrected'));
    assert.ok(!JSON.stringify(log).includes(successful.token));
    const existing=(await api(`/meetings/${m.id}`)).data.attendance[0];
    assert.equal((await api(`/attendance/${existing.id}`,{studentId:existing.student_id,reason:'תיקון מתועד לבדיקה'},'PATCH')).status,200);
    assert.equal((await api(`/attendance/${existing.id}`,{studentId:existing.student_id,reason:''},'PATCH')).status,400);
    const evil=await fetch('http://127.0.0.1:4189/api/courses',{headers:{Origin:'https://evil.invalid',Authorization:`Bearer ${token}`}});assert.equal(evil.status,403);
  }finally{child.kill();}
});
