import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const digest = value => createHash('sha256').update(value).digest('hex');
export class Problem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export function createStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS teachers(email TEXT PRIMARY KEY, role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions(hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS courses(id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL, group_name TEXT NOT NULL, owner TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members(course_id TEXT NOT NULL REFERENCES courses(id), email TEXT NOT NULL, PRIMARY KEY(course_id,email));
    CREATE TABLE IF NOT EXISTS students(id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id), identifier TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, UNIQUE(course_id,identifier));
    CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id), title TEXT NOT NULL, date TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0, opens TEXT, closes TEXT);
    CREATE TABLE IF NOT EXISTS slips(id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id), hash TEXT NOT NULL UNIQUE, number INTEGER NOT NULL, UNIQUE(meeting_id,number));
    CREATE TABLE IF NOT EXISTS attendance(id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id), student_id TEXT NOT NULL REFERENCES students(id), slip_id TEXT UNIQUE REFERENCES slips(id), created TEXT NOT NULL, updated TEXT NOT NULL, UNIQUE(meeting_id,student_id));
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, course_id TEXT, meeting_id TEXT, action TEXT NOT NULL, details TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit is immutable'); END;`);
  if (!db.prepare('PRAGMA table_info(teachers)').all().some(c => c.name === 'active')) db.exec('ALTER TABLE teachers ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  if (!db.prepare('PRAGMA table_info(slips)').all().some(c => c.name === 'revoked')) db.exec('ALTER TABLE slips ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0');
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const audit = (actor, action, course = null, meeting = null, details = {}) => run('INSERT INTO audit(at,actor,course_id,meeting_id,action,details) VALUES(?,?,?,?,?,?)', new Date().toISOString(), actor, course, meeting, action, JSON.stringify(details));
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const permission = (email, course) => { if (!one('SELECT 1 FROM members WHERE course_id=? AND email=?', course, email)) throw new Problem('אין הרשאה לקורס זה', 403); };
  const meeting = id => { const m = one('SELECT * FROM meetings WHERE id=?', id); if (!m) throw new Problem('המפגש לא נמצא', 404); return m; };
  const open = m => { const now = new Date().toISOString(); if (m.closed || (m.opens && now < m.opens) || (m.closes && now > m.closes)) throw new Problem('הרישום למפגש סגור', 409); };
  function slip(token) { if (typeof token !== 'string' || token.length !== 43) throw new Problem('הפתק אינו תקין', 404); const s = one('SELECT * FROM slips WHERE hash=?', digest(token)); if (!s) throw new Problem('הפתק אינו תקין', 404); if(s.revoked)throw new Problem('הפתק בוטל. יש לפנות למרצה לקבלת פתק חדש.',410); return s; }
  function claim(token, studentId) {
    let s, m;
    try {
      return transaction(() => {
        s = slip(token); m = meeting(s.meeting_id); open(m);
        const student = one('SELECT * FROM students WHERE id=? AND course_id=?', studentId, m.course_id);
        if (!student) throw new Problem('יש לבחור סטודנט מרשימת הקורס');
        const previous = one('SELECT * FROM attendance WHERE slip_id=?', s.id);
        const duplicate = one('SELECT * FROM attendance WHERE meeting_id=? AND student_id=?', m.id, studentId);
        if (duplicate && duplicate.id !== previous?.id) throw new Problem('הסטודנט כבר רשום כנוכח במפגש. הפתק לא נוצל.', 409);
        const at = new Date().toISOString();
        if (previous) run('UPDATE attendance SET student_id=?,updated=? WHERE id=?', studentId, at, previous.id);
        else run('INSERT INTO attendance VALUES(?,?,?,?,?,?)', randomUUID(), m.id, studentId, s.id, at, at);
        audit('student', previous ? 'attendance.corrected' : 'attendance.registered', m.course_id, m.id, { slip: s.number, before: previous?.student_id ?? null, after: studentId });
        return { student: { name: `${student.first_name} ${student.last_name}`, identifier: student.identifier }, corrected: !!previous };
      });
    } catch (e) {
      if(!s&&typeof token==='string'&&token.length===43){s=one('SELECT * FROM slips WHERE hash=?',digest(token));if(s)m=meeting(s.meeting_id);}
      audit('student', 'attendance.rejected', m?.course_id, m?.id, { reason: e.message, slip: s?.number ?? null }); throw e;
    }
  }
  function issue(email, meetingId, count) {
    const m = meeting(meetingId); permission(email, m.course_id);
    if (!Number.isInteger(count) || count < 1 || count > 300) throw new Problem('יש לבחור בין 1 ל־300 פתקים');
    return transaction(() => {
      const start = one('SELECT COALESCE(MAX(number),0) AS n FROM slips WHERE meeting_id=?', meetingId).n;
      const active = one('SELECT COUNT(*) n FROM slips WHERE meeting_id=? AND revoked=0', meetingId).n;
      if (active + count > 300) throw new Problem('אפשר להחזיק עד 300 פתקים פעילים למפגש. בטלו פתקים שאבדו לפני הפקה נוספת.');
      const slips = Array.from({ length: count }, (_, i) => {
        const token = randomBytes(32).toString('base64url');
        run('INSERT INTO slips(id,meeting_id,hash,number) VALUES(?,?,?,?)', randomUUID(), meetingId, digest(token), start + i + 1);
        return { token, number: start + i + 1 };
      });
      audit(email, 'slips.issued', m.course_id, m.id, { count }); return { meeting: m, slips };
    });
  }
  function revokeSlips(email, meetingId, numbers, reason) {
    const m=meeting(meetingId);permission(email,m.course_id);
    if(!Array.isArray(numbers)||!numbers.length||numbers.length>300||numbers.some(n=>!Number.isInteger(n)||n<1))throw new Problem('יש לבחור פתקים לביטול');
    if(typeof reason!=='string'||!reason.trim()||reason.length>500)throw new Problem('יש לציין סיבה לביטול');
    return transaction(()=>{
      const selected=[...new Set(numbers)].map(n=>one('SELECT s.*,a.id AS attendance_id FROM slips s LEFT JOIN attendance a ON a.slip_id=s.id WHERE s.meeting_id=? AND s.number=?',meetingId,n));
      if(selected.some(s=>!s))throw new Problem('פתק לא נמצא במפגש');
      if(selected.some(s=>s.attendance_id))throw new Problem('לא ניתן לבטל פתק שכבר נרשם. לתיקון נוכחות השתמשו בתיקון רישום.');
      selected.forEach(s=>run('UPDATE slips SET revoked=1 WHERE id=?',s.id));
      audit(email,'slips.revoked',m.course_id,m.id,{numbers:[...new Set(numbers)],reason:reason.trim()});return {count:selected.length};
    });
  }
  return { db, one, all, run, audit, transaction, permission, meeting, open, slip, claim, issue, revokeSlips };
}
