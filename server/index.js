import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createStore, digest, Problem } from './store.js';
import { verifySupabaseGoogle } from './identity.js';

const app = express();
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const production = process.env.NODE_ENV === 'production';
const developmentLogin = !production && process.env.DEV_LOGIN === 'true' && ['127.0.0.1','localhost'].includes(host);
const frontend = (process.env.FRONTEND_URL || `http://localhost:${port}`).replace(/\/$/, '');
const origin = new URL(frontend).origin;
const admins = (process.env.ADMIN_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const clientId = process.env.GOOGLE_CLIENT_ID || '';
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/,'');
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';
if(supabaseKey&&!supabaseKey.startsWith('sb_publishable_')){
  let role;try{role=JSON.parse(Buffer.from(supabaseKey.split('.')[1]||'','base64url').toString()).role;}catch{}
  if(role!=='anon')throw new Error('SUPABASE_PUBLISHABLE_KEY must be a public publishable/anon key, never a secret or service-role key');
}
const supabaseConfigured = !!(supabaseUrl && supabaseKey);
if(supabaseUrl && new URL(supabaseUrl).protocol!=='https:')throw new Error('SUPABASE_URL must use HTTPS');
if (production && ((!supabaseConfigured && !clientId) || !admins.length)) throw new Error('Production requires a configured Google/Supabase identity provider and ADMIN_EMAILS');
const store = createStore(process.env.DATABASE_PATH || 'data/attendance.sqlite');
const { one, all, run, audit, transaction, permission, meeting } = store;
admins.forEach(email => run("INSERT INTO teachers(email,role) VALUES(?,'admin') ON CONFLICT(email) DO UPDATE SET role='admin',active=1", email));
if (developmentLogin) run("INSERT OR IGNORE INTO teachers(email,role) VALUES('demo@local.test','admin')");
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Referrer-Policy', 'no-referrer'); res.set('X-Content-Type-Options', 'nosniff'); res.set('Cache-Control', 'no-store');
  if (req.headers.origin) {
    if (req.headers.origin !== origin) return res.status(403).json({ error: 'מקור הבקשה אינו מורשה' });
    res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization'); res.set('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '2mb' }));
const rates = new Map();
app.use('/api', (req, res, next) => {
  const tokenPath = req.path.match(/^\/slip\/([^/]+)/)?.[1];
  const key = `${req.socket.remoteAddress}:${tokenPath ? digest(tokenPath) : req.path.startsWith('/auth') ? 'auth' : 'general'}`; const now = Date.now();
  let r = rates.get(key); if (!r || r.until < now) { r = { until: now + 60000, count: 0 }; rates.set(key,r); }
  const limit = tokenPath || req.path.startsWith('/auth') ? 30 : 1500;
  if (++r.count > limit) return res.status(429).json({ error: 'יותר מדי בקשות, נסו שוב בעוד דקה' });
  if (rates.size > 10000) for (const [k,v] of rates) if (v.until < now) rates.delete(k);
  next();
});
function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  const session = token && one('SELECT s.email,t.role FROM auth_sessions s JOIN teachers t ON t.email=s.email WHERE s.hash=? AND s.expires>? AND t.active=1', digest(token), Date.now());
  if (!session) return res.status(401).json({ error: 'יש להיכנס לחשבון מרצה' });
  req.user = session; next();
}
function login(email) {
  const teacher = one('SELECT * FROM teachers WHERE email=? AND active=1', email);
  if (!teacher) throw new Problem('החשבון אינו מורשה. יש לפנות למנהל המערכת.',403);
  const token = randomBytes(32).toString('base64url');
  run('DELETE FROM auth_sessions WHERE expires<?', Date.now());
  run('INSERT INTO auth_sessions VALUES(?,?,?)', digest(token), email, Date.now()+8*60*60*1000);
  audit(email, 'auth.login'); return { token, user: teacher };
}
const text = (value, label, max=160) => { if (typeof value !== 'string' || !value.trim() || value.length>max) throw new Problem(`ערך לא תקין: ${label}`); return value.trim(); };
const emailValue = value => { const email=text(value,'מייל',254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Problem('כתובת מייל לא תקינה'); return email; };
const windowValues = body => {
  for (const value of [body.opens,body.closes]) if (value && Number.isNaN(Date.parse(value))) throw new Problem('זמן רישום לא תקין');
  const opens = body.opens ? new Date(body.opens).toISOString() : null;
  const closes = body.closes ? new Date(body.closes).toISOString() : null;
  if (opens && closes && opens >= closes) throw new Problem('זמן הסיום צריך להיות אחרי זמן ההתחלה');
  return { opens, closes };
};
app.get('/api/config', (req,res) => res.json({ googleClientId:supabaseConfigured?'':clientId, developmentLogin, frontend, supabase:supabaseConfigured?{url:supabaseUrl,publishableKey:supabaseKey}:null }));
app.post('/api/auth/supabase',async(req,res)=>{
  try { const email=await verifySupabaseGoogle(req.body.accessToken,{url:supabaseUrl,key:supabaseKey});res.json(login(email)); }
  catch(e){audit('anonymous','auth.rejected',null,null,{provider:'supabase',reason:e.message});throw e;}
});
app.post('/api/auth/google', async (req,res) => {
  if (!clientId) throw new Problem('כניסה באמצעות Google טרם הוגדרה',503);
  let payload;
  try { const ticket=await new OAuth2Client(clientId).verifyIdToken({ idToken:req.body.credential, audience:clientId }); payload=ticket.getPayload(); }
  catch { throw new Problem('ההזדהות באמצעות Google לא הצליחה',401); }
  if (!payload?.email_verified || typeof payload.email!=='string') throw new Problem('יש להיכנס באמצעות חשבון Google מאומת',403);
  res.json(login(payload.email.toLowerCase()));
});
app.post('/api/auth/dev', (req,res) => { if (!developmentLogin) throw new Problem('לא נמצא',404); res.json(login('demo@local.test')); });
app.get('/api/me', authenticate, (req,res) => res.json(req.user));
app.post('/api/auth/logout', authenticate, (req,res) => { run('DELETE FROM auth_sessions WHERE hash=?',digest(req.headers.authorization.replace(/^Bearer /,''))); audit(req.user.email,'auth.logout'); res.json({ ok:true }); });
app.get('/api/courses',authenticate,(req,res)=>res.json(all('SELECT c.*, (SELECT COUNT(*) FROM students WHERE course_id=c.id) AS student_count FROM courses c JOIN members m ON m.course_id=c.id WHERE m.email=? ORDER BY c.name',req.user.email)));
app.post('/api/courses/with-roster',authenticate,(req,res)=>{
  const name=text(req.body.name,'שם קורס',120), semester=text(req.body.semester,'סמסטר',20), year=text(req.body.year,'שנת לימודים',20);
  const c={id:randomUUID(),name:`${name} — ${year}, סמסטר ${semester}`,code:text(req.body.code,'מספר קורס',30),group_name:text(req.body.group_name,'קבוצה',60),owner:req.user.email};
  if(!Array.isArray(req.body.students)||!req.body.students.length||req.body.students.length>2000)throw new Problem('יש לצרף רשימה של 1 עד 2000 סטודנטים');
  const seen=new Set();const rows=req.body.students.map(s=>{const identifier=text(s?.identifier,'מזהה',40);if(seen.has(identifier))throw new Problem('נמצאו מזהים כפולים');seen.add(identifier);return {identifier,first_name:text(s.first_name,'שם פרטי'),last_name:text(s.last_name,'שם משפחה')};});
  transaction(()=>{run('INSERT INTO courses VALUES(?,?,?,?,?)',c.id,c.name,c.code,c.group_name,c.owner);run('INSERT INTO members VALUES(?,?)',c.id,c.owner);for(const s of rows)run('INSERT INTO students VALUES(?,?,?,?,?)',randomUUID(),c.id,s.identifier,s.first_name,s.last_name);audit(req.user.email,'course.created',c.id,null,{name:c.name});audit(req.user.email,'roster.imported',c.id,null,{count:rows.length});});
  res.status(201).json({...c,student_count:rows.length});
});
app.post('/api/courses',authenticate,(req,res)=>{
  const c={id:randomUUID(),name:text(req.body.name,'שם קורס'),code:text(req.body.code,'מספר קורס',30),group_name:text(req.body.group_name,'קבוצה',60),owner:req.user.email};
  transaction(()=>{ run('INSERT INTO courses VALUES(?,?,?,?,?)',c.id,c.name,c.code,c.group_name,c.owner); run('INSERT INTO members VALUES(?,?)',c.id,c.owner); audit(req.user.email,'course.created',c.id,null,{name:c.name}); }); res.status(201).json(c);
});
app.get('/api/courses/:id',authenticate,(req,res)=>{
  permission(req.user.email,req.params.id); audit(req.user.email,'course.viewed',req.params.id); res.json({course:one('SELECT * FROM courses WHERE id=?',req.params.id),students:all('SELECT * FROM students WHERE course_id=? ORDER BY last_name,first_name',req.params.id),meetings:all('SELECT m.*, (SELECT COUNT(*) FROM attendance WHERE meeting_id=m.id) AS attendance_count,(SELECT COUNT(*) FROM slips WHERE meeting_id=m.id) AS slip_count FROM meetings m WHERE course_id=? ORDER BY date DESC',req.params.id),members:all('SELECT email FROM members WHERE course_id=?',req.params.id)});
});
app.post('/api/courses/:id/students',authenticate,(req,res)=>{
  const course=req.params.id; permission(req.user.email,course);
  if (!Array.isArray(req.body.students) || !req.body.students.length || req.body.students.length>2000) throw new Problem('יש לייבא בין 1 ל־2000 סטודנטים');
  const seen=new Set(); const rows=req.body.students.map(s=>{ const identifier=text(s.identifier,'מזהה',40); if(seen.has(identifier)) throw new Problem('נמצאו מספרי זיהוי כפולים בקובץ'); seen.add(identifier); return {identifier,first_name:text(s.first_name,'שם פרטי'),last_name:text(s.last_name,'שם משפחה')}; });
  transaction(()=>{ for(const s of rows) run('INSERT INTO students VALUES(?,?,?,?,?) ON CONFLICT(course_id,identifier) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name',randomUUID(),course,s.identifier,s.first_name,s.last_name); audit(req.user.email,'roster.imported',course,null,{count:rows.length}); }); res.json({ count:rows.length });
});
app.post('/api/courses/:id/members',authenticate,(req,res)=>{
  const c=one('SELECT * FROM courses WHERE id=?',req.params.id); if (!c || c.owner!==req.user.email) throw new Problem('רק בעל הקורס יכול להוסיף מרצים',403);
  const email=emailValue(req.body.email); if(one('SELECT active FROM teachers WHERE email=?',email)?.active===0)throw new Problem('חשבון זה הושבת. מנהל המערכת צריך להפעיל אותו מחדש.',403);transaction(()=>{run("INSERT OR IGNORE INTO teachers(email,role) VALUES(?,'teacher')",email);run('INSERT OR IGNORE INTO members VALUES(?,?)',c.id,email);audit(req.user.email,'course.member_added',c.id,null,{email});});res.json({ok:true});
});
app.post('/api/courses/:id/members/revoke',authenticate,(req,res)=>{
  const c=one('SELECT * FROM courses WHERE id=?',req.params.id);if(!c||c.owner!==req.user.email)throw new Problem('רק בעל הקורס יכול לבטל הרשאה',403);
  const email=emailValue(req.body.email);if(email===c.owner)throw new Problem('לא ניתן להסיר את בעל הקורס');
  transaction(()=>{run('DELETE FROM members WHERE course_id=? AND email=?',c.id,email);audit(req.user.email,'course.member_revoked',c.id,null,{email});});res.json({ok:true});
});
app.get('/api/teachers',authenticate,(req,res)=>{if(req.user.role!=='admin')throw new Problem('נדרשת הרשאת מנהל',403);res.json(all('SELECT t.email,t.role,t.active,(SELECT COUNT(*) FROM members WHERE email=t.email) course_count FROM teachers t ORDER BY t.role,t.email'));});
app.post('/api/teachers',authenticate,(req,res)=>{
  if(req.user.role!=='admin') throw new Problem('נדרשת הרשאת מנהל',403);
  const email=emailValue(req.body.email);run("INSERT INTO teachers(email,role) VALUES(?,'teacher') ON CONFLICT(email) DO UPDATE SET active=1",email);audit(req.user.email,'teacher.authorized',null,null,{email});res.json({ok:true});
});
app.post('/api/teachers/revoke',authenticate,(req,res)=>{
  if(req.user.role!=='admin')throw new Problem('נדרשת הרשאת מנהל',403);
  const email=emailValue(req.body.email),teacher=one('SELECT * FROM teachers WHERE email=?',email);
  if(!teacher)throw new Problem('המרצה לא נמצא',404);if(teacher.role==='admin')throw new Problem('לא ניתן להשבית מנהל מערכת');
  transaction(()=>{run('UPDATE teachers SET active=0 WHERE email=?',email);run('DELETE FROM auth_sessions WHERE email=?',email);audit(req.user.email,'teacher.revoked',null,null,{email});});res.json({ok:true});
});
app.post('/api/courses/:id/meetings',authenticate,(req,res)=>{
  permission(req.user.email,req.params.id);const {opens,closes}=windowValues(req.body);const date=text(req.body.date,'תאריך',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new Problem('תאריך לא תקין');
  const m={id:randomUUID(),course_id:req.params.id,title:text(req.body.title,'שם מפגש'),date};
  transaction(()=>{run('INSERT INTO meetings(id,course_id,title,date,opens,closes) VALUES(?,?,?,?,?,?)',m.id,m.course_id,m.title,m.date,opens,closes);audit(req.user.email,'meeting.created',m.course_id,m.id,{opens,closes});});res.status(201).json(m);
});
app.get('/api/meetings/:id',authenticate,(req,res)=>{
  const m=meeting(req.params.id);permission(req.user.email,m.course_id);res.json({meeting:m,attendance:all('SELECT a.*,s.first_name,s.last_name,s.identifier,sl.number AS slip_number FROM attendance a JOIN students s ON s.id=a.student_id LEFT JOIN slips sl ON sl.id=a.slip_id WHERE a.meeting_id=? ORDER BY s.last_name',m.id),slips:all('SELECT s.number,s.revoked,CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS used FROM slips s LEFT JOIN attendance a ON a.slip_id=s.id WHERE s.meeting_id=? ORDER BY s.number',m.id)});
});
app.patch('/api/meetings/:id',authenticate,(req,res)=>{
  const m=meeting(req.params.id);permission(req.user.email,m.course_id);const {opens,closes}=windowValues(req.body);
  transaction(()=>{run('UPDATE meetings SET closed=?,opens=?,closes=? WHERE id=?',req.body.closed===true?1:0,opens,closes,m.id);audit(req.user.email,'meeting.settings_changed',m.course_id,m.id,{closed:req.body.closed===true,opens,closes});});res.json({ok:true});
});
app.post('/api/meetings/:id/slips',authenticate,(req,res)=>res.json(store.issue(req.user.email,req.params.id,req.body.count)));
app.post('/api/meetings/:id/slips/revoke',authenticate,(req,res)=>res.json(store.revokeSlips(req.user.email,req.params.id,req.body.numbers,req.body.reason)));
app.post('/api/meetings/:id/manual',authenticate,(req,res)=>{
  const m=meeting(req.params.id);permission(req.user.email,m.course_id);const reason=text(req.body.reason,'סיבת תיקון',500);const s=one('SELECT * FROM students WHERE id=? AND course_id=?',req.body.studentId,m.course_id);if(!s)throw new Problem('הסטודנט לא נמצא');
  transaction(()=>{const at=new Date().toISOString();run('INSERT INTO attendance VALUES(?,?,?,?,?,?)',randomUUID(),m.id,s.id,null,at,at);audit(req.user.email,'attendance.manual',m.course_id,m.id,{student:s.id,reason});});res.json({ok:true});
});
app.patch('/api/attendance/:id',authenticate,(req,res)=>{
  const a=one('SELECT * FROM attendance WHERE id=?',req.params.id);if(!a)throw new Problem('הרישום לא נמצא',404);
  const m=meeting(a.meeting_id);permission(req.user.email,m.course_id);
  const reason=text(req.body.reason,'סיבת תיקון',500);
  const student=one('SELECT id FROM students WHERE id=? AND course_id=?',req.body.studentId,m.course_id);if(!student)throw new Problem('הסטודנט לא נמצא');
  transaction(()=>{run('UPDATE attendance SET student_id=?,updated=? WHERE id=?',student.id,new Date().toISOString(),a.id);audit(req.user.email,'attendance.teacher_corrected',m.course_id,m.id,{before:a.student_id,after:student.id,reason});});res.json({ok:true});
});
app.get('/api/courses/:id/audit',authenticate,(req,res)=>{if(req.user.role!=='admin')throw new Problem('יומן הפעילות זמין למנהל המערכת בלבד',403);permission(req.user.email,req.params.id);res.json(all('SELECT * FROM audit WHERE course_id=? ORDER BY id DESC LIMIT 500',req.params.id));});
app.get('/api/slip/:token',(req,res)=>{
  const s=store.slip(req.params.token),m=meeting(s.meeting_id),c=one('SELECT name,code,group_name FROM courses WHERE id=?',m.course_id);let isOpen=true;try{store.open(m);}catch{isOpen=false;}
  const a=one('SELECT a.updated,st.identifier,st.first_name,st.last_name,st.id FROM attendance a JOIN students st ON st.id=a.student_id WHERE a.slip_id=?',s.id);
  res.json({course:c,meeting:{title:m.title,date:m.date,id:m.id},courseId:m.course_id,number:s.number,isOpen,previous:a?{studentId:a.id,identifier:a.identifier,name:`${a.first_name} ${a.last_name}`,updated:a.updated}:null,students:isOpen?all('SELECT id,first_name,last_name,substr(identifier,-4) AS suffix FROM students WHERE course_id=? ORDER BY last_name,first_name',m.course_id):[]});
});
app.post('/api/slip/:token/claim',(req,res)=>res.json(store.claim(req.params.token,req.body.studentId)));
app.use('/api',(req,res)=>res.status(404).json({error:'הפעולה לא נמצאה'}));
app.use((err,req,res,next)=>{
  if(req.user) audit(req.user.email,'request.rejected',req.params?.id || null,null,{method:req.method,reason:err.status?err.message:'request_failed'});
  const conflict=err.code?.startsWith('ERR_SQLITE') && /UNIQUE/.test(err.message);
  if(!err.status&&!conflict) console.error('Request failed:',err.message);
  res.status(err.status || (conflict?409:500)).json({error:err.status?err.message:conflict?'הרישום כבר קיים':'אירעה תקלה. נסו שוב.'});
});
if(!production) { const {createServer}=await import('vite');const vite=await createServer({server:{middlewareMode:true,hmr:{port:port+20000}},appType:'spa'});app.use(vite.middlewares); }
else app.use(express.static(resolve('dist')));
app.listen(port,host,()=>console.log(`Attendance app: http://${host}:${port}; local demo login: ${developmentLogin}`));
