import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, digest } from '../server/store.js';
function fixture(){
  const s=createStore(':memory:');
  s.run('INSERT INTO courses VALUES(?,?,?,?,?)','c','קורס בדיקה','00000','1','teacher@test.invalid');
  s.run('INSERT INTO members VALUES(?,?)','c','teacher@test.invalid');
  s.run('INSERT INTO students VALUES(?,?,?,?,?)','a','c','000000001','אחד','בדיקה');
  s.run('INSERT INTO students VALUES(?,?,?,?,?)','b','c','000000002','שניים','בדיקה');
  s.run('INSERT INTO students VALUES(?,?,?,?,?)','other','c','000000003','שלוש','בדיקה');
  s.run('INSERT INTO meetings(id,course_id,title,date) VALUES(?,?,?,?)','m','c','מפגש','2026-10-06');
  return s;
}
test('tokens are random, stored hashed, numbered uniquely, and permission protected',()=>{
  const s=fixture();const result=s.issue('teacher@test.invalid','m',2);
  assert.notEqual(result.slips[0].token,result.slips[1].token);
  assert.equal(result.slips[0].token.length,43);
  assert.equal(s.one('SELECT hash FROM slips WHERE number=1').hash,digest(result.slips[0].token));
  assert.throws(()=>s.issue('outsider@test.invalid','m',1),/הרשאה/);
  assert.throws(()=>s.issue('teacher@test.invalid','m',299),/300/);
  assert.equal(s.issue('teacher@test.invalid','m',1).slips[0].number,3);s.db.close();
});
test('duplicate student does not consume a slip; rescanning corrects a single record',()=>{
  const s=fixture(),{slips}=s.issue('teacher@test.invalid','m',3);
  s.claim(slips[0].token,'a');
  assert.throws(()=>s.claim(slips[1].token,'a'),/כבר רשום/);
  assert.equal(s.one('SELECT COUNT(*) n FROM attendance').n,1);
  s.claim(slips[1].token,'b');
  assert.throws(()=>s.claim(slips[0].token,'b'),/כבר רשום/);
  assert.equal(s.one('SELECT student_id FROM attendance WHERE slip_id=(SELECT id FROM slips WHERE number=1)').student_id,'a');
  const corrected=s.claim(slips[0].token,'other');assert.equal(corrected.corrected,true);
  assert.equal(s.one('SELECT COUNT(*) n FROM attendance').n,2);
  s.claim(slips[2].token,'a');assert.equal(s.one('SELECT COUNT(*) n FROM attendance').n,3);
  assert.equal(s.one('SELECT COUNT(*) n FROM audit WHERE action=?','attendance.rejected').n,2);
  assert.throws(()=>s.run('UPDATE audit SET actor=?','hacker'),/immutable/);
  assert.throws(()=>s.run('DELETE FROM audit'),/immutable/);s.db.close();
});
test('closed and time-limited meetings block registrations and corrections',()=>{
  const s=fixture(),{slips}=s.issue('teacher@test.invalid','m',1);
  s.claim(slips[0].token,'a');s.run('UPDATE meetings SET closed=1');
  assert.throws(()=>s.claim(slips[0].token,'b'),/סגור/);
  s.run('UPDATE meetings SET closed=0,opens=?','2099-01-01T00:00:00.000Z');
  assert.throws(()=>s.claim(slips[0].token,'b'),/סגור/);
  s.run('UPDATE meetings SET opens=NULL,closes=?','2000-01-01T00:00:00.000Z');
  assert.throws(()=>s.claim(slips[0].token,'b'),/סגור/);
  assert.equal(s.one('SELECT student_id FROM attendance').student_id,'a');s.db.close();
});
test('invalid token or roster selection cannot create attendance',()=>{
  const s=fixture(),{slips}=s.issue('teacher@test.invalid','m',1);
  assert.throws(()=>s.claim('fake','a'),/תקין/);
  assert.throws(()=>s.claim(slips[0].token,'nonexistent'),/לבחור/);
  assert.equal(s.one('SELECT COUNT(*) n FROM attendance').n,0);s.db.close();
});
test('revoking unused slips blocks reuse, preserves attendance and frees issuance quota',()=>{
  const s=fixture(),{slips}=s.issue('teacher@test.invalid','m',300);
  s.claim(slips[0].token,'a');
  assert.throws(()=>s.revokeSlips('teacher@test.invalid','m',[1,2],'בדיקה'),/כבר נרשם/);
  assert.equal(s.slip(slips[1].token).revoked,0);
  s.revokeSlips('teacher@test.invalid','m',[2],'לא חולק');
  assert.throws(()=>s.claim(slips[1].token,'b'),/בוטל/);
  assert.equal(s.issue('teacher@test.invalid','m',1).slips[0].number,301);
  assert.equal(s.one('SELECT COUNT(*) n FROM attendance').n,1);
  assert.throws(()=>s.revokeSlips('outsider@test.invalid','m',[3],'בדיקה'),/הרשאה/);
  assert.throws(()=>s.revokeSlips('teacher@test.invalid','m',[999],'בדיקה'),/לא נמצא/);s.db.close();
});
