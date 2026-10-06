-- New, isolated deployment. Never import local rosters as part of this migration.
begin;
create schema attendance_private;
revoke all on schema attendance_private from public, anon, authenticated;
create table attendance_private.teachers(email text primary key, role text not null check(role in ('admin','teacher')), active boolean not null default true);
create table attendance_private.courses(id uuid primary key default gen_random_uuid(), name text not null, code text not null, group_name text not null, owner text not null references attendance_private.teachers(email));
create table attendance_private.members(course_id uuid references attendance_private.courses(id), email text references attendance_private.teachers(email), primary key(course_id,email));
create table attendance_private.students(id uuid primary key default gen_random_uuid(), course_id uuid not null references attendance_private.courses(id), identifier text not null, first_name text not null, last_name text not null, unique(course_id,identifier));
create table attendance_private.meetings(id uuid primary key default gen_random_uuid(), course_id uuid not null references attendance_private.courses(id), title text not null, date date not null, closed boolean not null default false, opens timestamptz, closes timestamptz, check(opens is null or closes is null or opens<closes));
create table attendance_private.slips(id uuid primary key default gen_random_uuid(), meeting_id uuid not null references attendance_private.meetings(id), hash text not null unique, number integer not null, revoked boolean not null default false, unique(meeting_id,number));
create table attendance_private.attendance(id uuid primary key default gen_random_uuid(), meeting_id uuid not null references attendance_private.meetings(id), student_id uuid not null references attendance_private.students(id), slip_id uuid unique references attendance_private.slips(id), created timestamptz not null default now(), updated timestamptz not null default now(), unique(meeting_id,student_id));
create table attendance_private.audit(id bigint generated always as identity primary key, at timestamptz not null default now(), actor text not null, course_id uuid, meeting_id uuid, action text not null, details jsonb not null default '{}');
create table attendance_private.rates(key text primary key, minute timestamptz not null, hits integer not null);
create index on attendance_private.students(course_id);
create index on attendance_private.meetings(course_id);
create index on attendance_private.slips(meeting_id);
create index on attendance_private.audit(course_id,id desc);
insert into attendance_private.teachers values('assaf.romm@mail.huji.ac.il','admin',true);
create function attendance_private.immutable_audit() returns trigger language plpgsql set search_path='' as $$begin raise exception 'Audit is immutable';end$$;
create trigger immutable_audit before update or delete on attendance_private.audit for each row execute function attendance_private.immutable_audit();
create function attendance_private.required(v text, label text, max_length integer default 160) returns text language plpgsql set search_path='' as $$begin if v is null or length(btrim(v))=0 or length(v)>max_length then raise exception 'ערך לא תקין: %',label;end if;return btrim(v);end$$;
create function attendance_private.permission(e text,c uuid) returns void language plpgsql set search_path='' as $$begin if not exists(select 1 from attendance_private.members where course_id=c and email=e) then raise exception 'אין הרשאה לקורס זה';end if;end$$;
create function attendance_private.log(e text,a text,c uuid default null,m uuid default null,d jsonb default '{}') returns void language sql set search_path='' as $$insert into attendance_private.audit(actor,action,course_id,meeting_id,details) values(e,a,c,m,d)$$;
create function attendance_private.import_roster(c uuid, rows jsonb) returns integer language plpgsql set search_path='' as $$
declare s jsonb; ident text; n integer;
begin
 if jsonb_typeof(rows) is distinct from 'array' then raise exception 'יש לצרף רשימת משתתפים';end if;
 n:=jsonb_array_length(rows);if n<1 or n>2000 then raise exception 'יש לצרף 1 עד 2000 משתתפים';end if;
 if (select count(distinct btrim(value->>'identifier')) from jsonb_array_elements(rows))<>n then raise exception 'מזהים חסרים או כפולים';end if;
 for s in select value from jsonb_array_elements(rows) loop
 ident:=attendance_private.required(s->>'identifier','מזהה',40);
 insert into attendance_private.students(course_id,identifier,first_name,last_name) values(c,ident,attendance_private.required(s->>'first_name','שם פרטי'),attendance_private.required(s->>'last_name','שם משפחה')) on conflict(course_id,identifier) do update set first_name=excluded.first_name,last_name=excluded.last_name;
 end loop;return n;
end$$;
-- The only exposed entry point. Tables and helper functions remain inaccessible.
create function public.attendance_api(path text, method text default 'GET', body jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare
 p text[]:=string_to_array(trim(both '/' from path),'/'); e text; teacher attendance_private.teachers;
 c attendance_private.courses; m attendance_private.meetings; s attendance_private.slips; st attendance_private.students; a attendance_private.attendance;
 target uuid; cid uuid; mid uuid; student uuid; mail text; reason text; token text; hash text; n integer; start_number integer; hits integer; x jsonb; result jsonb; issued jsonb:='[]'; is_open boolean; corrected boolean;
begin
 -- Verified Google identity and email are read from Auth-managed tables, never user_metadata.
 select lower(u.email) into e from auth.users u join auth.identities i on i.user_id=u.id
 where u.id=auth.uid() and i.provider='google' and i.identity_data->>'email_verified'='true'
 and lower(i.identity_data->>'email')=lower(u.email) and u.raw_app_meta_data->>'provider'='google'
 and split_part(lower(u.email),'@',2)='mail.huji.ac.il' limit 1;
 select * into teacher from attendance_private.teachers where email=e and active;
 if p[1]<>'slip' and teacher.email is null then return jsonb_build_object('error','החשבון אינו מורשה. יש לפנות למנהל המערכת.');end if;
 -- Persistent per-user/per-slip throttling, no raw bearer secret in the rate table.
 token:=case when p[1]='slip' then p[2] else e end;
 hash:=encode(extensions.digest(coalesce(token,''),'sha256'),'hex');
 delete from attendance_private.rates where minute<now()-interval '1 day';
 insert into attendance_private.rates values(hash,date_trunc('minute',now()),1) on conflict(key) do update set minute=excluded.minute,hits=case when attendance_private.rates.minute=excluded.minute then attendance_private.rates.hits+1 else 1 end returning attendance_private.rates.hits into hits;
 if hits>(case when p[1]='slip' then 60 else 600 end) then return jsonb_build_object('error','יותר מדי בקשות. נסו שוב בעוד דקה.');end if;
 begin
 if path='/me' then return to_jsonb(teacher);end if;
 if p[1]='courses' and array_length(p,1)=1 and method='GET' then
 select coalesce(jsonb_agg(to_jsonb(q)),'[]') into result from(select c.*,(select count(*) from attendance_private.students where course_id=c.id) student_count from attendance_private.courses c join attendance_private.members mm on mm.course_id=c.id where mm.email=e order by c.name) q;return result;
 end if;
 if path='/courses/with-roster' and method='POST' then
 insert into attendance_private.courses(name,code,group_name,owner) values(attendance_private.required(body->>'name','שם קורס',120)||' — '||attendance_private.required(body->>'year','שנה',20)||', סמסטר '||attendance_private.required(body->>'semester','סמסטר',20),attendance_private.required(body->>'code','מספר קורס',30),attendance_private.required(body->>'group_name','קבוצה',60),e) returning * into c;
 insert into attendance_private.members values(c.id,e);n:=attendance_private.import_roster(c.id,body->'students');
 perform attendance_private.log(e,'course.created',c.id,null,jsonb_build_object('name',c.name));perform attendance_private.log(e,'roster.imported',c.id,null,jsonb_build_object('count',n));return to_jsonb(c)||jsonb_build_object('student_count',n);
 end if;
 if p[1]='teachers' then
 if teacher.role<>'admin' then raise exception 'נדרשת הרשאת מנהל';end if;
 if method='GET' then select coalesce(jsonb_agg(to_jsonb(q)),'[]') into result from(select t.*,(select count(*) from attendance_private.members where email=t.email) course_count from attendance_private.teachers t order by role,email) q;return result;end if;
 mail:=lower(attendance_private.required(body->>'email','מייל',254));if mail !~ '^[^\s@]+@mail\.huji\.ac\.il$' then raise exception 'יש להשתמש בכתובת האוניברסיטאית';end if;
 if p[2]='revoke' then
 if exists(select 1 from attendance_private.teachers where email=mail and role='admin') then raise exception 'לא ניתן להשבית מנהל';end if;
 update attendance_private.teachers set active=false where email=mail;perform attendance_private.log(e,'teacher.revoked',null,null,jsonb_build_object('email',mail));
 else insert into attendance_private.teachers values(mail,'teacher',true) on conflict(email) do update set active=true;perform attendance_private.log(e,'teacher.authorized',null,null,jsonb_build_object('email',mail));end if;return '{"ok":true}';
 end if;
 if p[1]='courses' then
 cid:=p[2]::uuid;perform attendance_private.permission(e,cid);select * into c from attendance_private.courses where id=cid;
 if array_length(p,1)=2 and method='GET' then
 perform attendance_private.log(e,'course.viewed',cid);
 return jsonb_build_object('course',to_jsonb(c),'students',(select coalesce(jsonb_agg(to_jsonb(q)),'[]') from(select * from attendance_private.students where course_id=cid order by last_name,first_name) q),'meetings',(select coalesce(jsonb_agg(to_jsonb(q)),'[]') from(select mt.*,(select count(*) from attendance_private.attendance where meeting_id=mt.id) attendance_count,(select count(*) from attendance_private.slips where meeting_id=mt.id) slip_count from attendance_private.meetings mt where course_id=cid order by date desc) q),'members',(select coalesce(jsonb_agg(jsonb_build_object('email',email)),'[]') from attendance_private.members where course_id=cid));
 elsif p[3]='students' and method='POST' then n:=attendance_private.import_roster(cid,body->'students');perform attendance_private.log(e,'roster.imported',cid,null,jsonb_build_object('count',n));return jsonb_build_object('count',n);
 elsif p[3]='audit' and method='GET' then select coalesce(jsonb_agg(to_jsonb(q)),'[]') into result from(select * from attendance_private.audit where course_id=cid order by id desc limit 500) q;return result;
 elsif p[3]='members' and method='POST' then
 if c.owner<>e then raise exception 'רק בעל הקורס יכול לשנות הרשאות';end if;
 mail:=lower(attendance_private.required(body->>'email','מייל',254));if mail !~ '^[^\s@]+@mail\.huji\.ac\.il$' then raise exception 'כתובת אוניברסיטאית לא תקינה';end if;
 if p[4]='revoke' then if mail=c.owner then raise exception 'לא ניתן להסיר את בעל הקורס';end if;delete from attendance_private.members where course_id=cid and email=mail;perform attendance_private.log(e,'course.member_revoked',cid,null,jsonb_build_object('email',mail));
 else if exists(select 1 from attendance_private.teachers where email=mail and not active) then raise exception 'חשבון זה הושבת';end if;insert into attendance_private.teachers values(mail,'teacher',true) on conflict do nothing;insert into attendance_private.members values(cid,mail) on conflict do nothing;perform attendance_private.log(e,'course.member_added',cid,null,jsonb_build_object('email',mail));end if;return '{"ok":true}';
 elsif p[3]='meetings' and method='POST' then
 insert into attendance_private.meetings(course_id,title,date,opens,closes) values(cid,attendance_private.required(body->>'title','שם מפגש'),(body->>'date')::date,nullif(body->>'opens','')::timestamptz,nullif(body->>'closes','')::timestamptz) returning * into m;perform attendance_private.log(e,'meeting.created',cid,m.id);return to_jsonb(m);
 end if;
 end if;
 if p[1]='attendance' and method='PATCH' then
 select * into a from attendance_private.attendance where id=p[2]::uuid for update;if not found then raise exception 'הרישום לא נמצא';end if;
 select * into m from attendance_private.meetings where id=a.meeting_id;cid:=m.course_id;mid:=m.id;perform attendance_private.permission(e,cid);
 reason:=attendance_private.required(body->>'reason','סיבת תיקון',500);student:=(body->>'studentId')::uuid;
 if not exists(select 1 from attendance_private.students where id=student and course_id=cid) then raise exception 'הסטודנט לא נמצא';end if;
 update attendance_private.attendance set student_id=student,updated=now() where id=a.id;perform attendance_private.log(e,'attendance.teacher_corrected',cid,mid,jsonb_build_object('before',a.student_id,'after',student,'reason',reason));return '{"ok":true}';
 end if;
 if p[1]='meetings' then
 mid:=p[2]::uuid;select * into m from attendance_private.meetings where id=mid for update;if not found then raise exception 'המפגש לא נמצא';end if;cid:=m.course_id;perform attendance_private.permission(e,cid);
 if array_length(p,1)=2 and method='GET' then
 return jsonb_build_object('meeting',to_jsonb(m),'attendance',(select coalesce(jsonb_agg(to_jsonb(q)),'[]') from(select a.*,st.first_name,st.last_name,st.identifier,sl.number slip_number from attendance_private.attendance a join attendance_private.students st on st.id=a.student_id left join attendance_private.slips sl on sl.id=a.slip_id where a.meeting_id=mid order by st.last_name) q),'slips',(select coalesce(jsonb_agg(to_jsonb(q)),'[]') from(select sl.number,sl.revoked,exists(select 1 from attendance_private.attendance where slip_id=sl.id) used from attendance_private.slips sl where meeting_id=mid order by number) q));
 elsif array_length(p,1)=2 and method='PATCH' then
 update attendance_private.meetings set closed=coalesce((body->>'closed')::boolean,false),opens=nullif(body->>'opens','')::timestamptz,closes=nullif(body->>'closes','')::timestamptz where id=mid;perform attendance_private.log(e,'meeting.settings_changed',cid,mid,jsonb_build_object('closed',body->'closed','opens',body->'opens','closes',body->'closes'));return '{"ok":true}';
 elsif p[3]='slips' and method='POST' and array_length(p,1)=3 then
 n:=(body->>'count')::integer;if n is null or n<1 or n>300 then raise exception 'יש לבחור 1 עד 300 פתקים';end if;
 if (select count(*) from attendance_private.slips where meeting_id=mid and not revoked)+n>300 then raise exception 'מותר להחזיק עד 300 פתקים פעילים';end if;
 select coalesce(max(number),0) into start_number from attendance_private.slips where meeting_id=mid;
 for i in 1..n loop token:=translate(rtrim(encode(extensions.gen_random_bytes(32),'base64'),'='),'+/','-_');insert into attendance_private.slips(meeting_id,hash,number) values(mid,encode(extensions.digest(token,'sha256'),'hex'),start_number+i);issued:=issued||jsonb_build_array(jsonb_build_object('token',token,'number',start_number+i));end loop;
 perform attendance_private.log(e,'slips.issued',cid,mid,jsonb_build_object('count',n));return jsonb_build_object('meeting',to_jsonb(m),'slips',issued);
 elsif p[3]='slips' and p[4]='revoke' and method='POST' then
 reason:=attendance_private.required(body->>'reason','סיבת ביטול',500);if jsonb_typeof(body->'numbers') is distinct from 'array' or jsonb_array_length(body->'numbers') not between 1 and 300 then raise exception 'יש לבחור פתקים';end if;
 for x in select value from jsonb_array_elements(body->'numbers') loop
 select * into s from attendance_private.slips where meeting_id=mid and number=(x#>>'{}')::integer;if not found then raise exception 'פתק לא נמצא';end if;
 if exists(select 1 from attendance_private.attendance where slip_id=s.id) then raise exception 'לא ניתן לבטל פתק שכבר נרשם';end if;update attendance_private.slips set revoked=true where id=s.id;
 end loop;perform attendance_private.log(e,'slips.revoked',cid,mid,jsonb_build_object('numbers',body->'numbers','reason',reason));return jsonb_build_object('count',jsonb_array_length(body->'numbers'));
 elsif p[3]='manual' and method='POST' then
 student:=(body->>'studentId')::uuid;reason:=attendance_private.required(body->>'reason','סיבת רישום',500);if not exists(select 1 from attendance_private.students where id=student and course_id=cid) then raise exception 'הסטודנט לא נמצא';end if;
 insert into attendance_private.attendance(meeting_id,student_id) values(mid,student);perform attendance_private.log(e,'attendance.manual',cid,mid,jsonb_build_object('student',student,'reason',reason));return '{"ok":true}';
 end if;
 end if;
 if p[1]='slip' then
 if length(p[2])<>43 then raise exception 'הפתק אינו תקין';end if;
 select * into s from attendance_private.slips where hash=encode(extensions.digest(p[2],'sha256'),'hex');if not found then raise exception 'הפתק אינו תקין';end if;
 mid:=s.meeting_id;select * into m from attendance_private.meetings where id=mid for update;cid:=m.course_id;
 -- Refresh after acquiring the meeting lock: a concurrent revocation may have won.
 select * into s from attendance_private.slips where id=s.id;
 if s.revoked then raise exception 'הפתק בוטל';end if;
 is_open:=not m.closed and (m.opens is null or now()>=m.opens) and (m.closes is null or now()<=m.closes);
 select * into a from attendance_private.attendance where slip_id=s.id;
 if method='GET' and array_length(p,1)=2 then
 select * into c from attendance_private.courses where id=cid;
 select * into st from attendance_private.students where id=a.student_id;
 return jsonb_build_object('course',jsonb_build_object('name',c.name,'code',c.code,'group_name',c.group_name),'meeting',jsonb_build_object('title',m.title,'date',m.date,'id',m.id),'courseId',cid,'number',s.number,'isOpen',is_open,'previous',case when a.id is null then null else jsonb_build_object('studentId',st.id,'identifier',st.identifier,'name',st.first_name||' '||st.last_name,'updated',a.updated) end,'students',case when is_open then (select coalesce(jsonb_agg(to_jsonb(q)),'[]') from(select id,first_name,last_name,right(identifier,4) suffix from attendance_private.students where course_id=cid order by last_name,first_name) q) else '[]'::jsonb end);
 elsif method='POST' and p[3]='claim' then
 if not is_open then raise exception 'הרישום למפגש סגור';end if;
 student:=(body->>'studentId')::uuid;select * into st from attendance_private.students where id=student and course_id=cid;if not found then raise exception 'יש לבחור משתתף מרשימת הקורס';end if;
 if exists(select 1 from attendance_private.attendance where meeting_id=mid and student_id=student and id is distinct from a.id) then raise exception 'הסטודנט כבר רשום כנוכח. הפתק לא נוצל';end if;
 corrected:=a.id is not null;if corrected then update attendance_private.attendance set student_id=student,updated=now() where id=a.id;else insert into attendance_private.attendance(meeting_id,student_id,slip_id) values(mid,student,s.id);end if;
 perform attendance_private.log('student',case when corrected then 'attendance.corrected' else 'attendance.registered' end,cid,mid,jsonb_build_object('slip',s.number,'before',a.student_id,'after',student));return jsonb_build_object('student',jsonb_build_object('name',st.first_name||' '||st.last_name,'identifier',st.identifier),'corrected',corrected);
 end if;
 end if;
 raise exception 'הפעולה לא נמצאה';
 exception when others then
 -- This inner subtransaction rolls back the failed action but retains its audit entry.
 perform attendance_private.log(coalesce(e,'student'),case when p[1]='slip' then 'attendance.rejected' else 'request.rejected' end,cid,mid,jsonb_build_object('reason',case when sqlstate='P0001' then sqlerrm when sqlstate='23505' then 'הרישום כבר קיים' else 'נתונים לא תקינים' end));
 return jsonb_build_object('error',case when sqlstate='P0001' then sqlerrm when sqlstate='23505' then 'הרישום כבר קיים' else 'נתונים לא תקינים' end);
 end;
end$$;
revoke all on all tables in schema attendance_private from public,anon,authenticated;
revoke all on all sequences in schema attendance_private from public,anon,authenticated;
revoke execute on all functions in schema attendance_private from public,anon,authenticated;
revoke execute on function public.attendance_api(text,text,jsonb) from public;
grant execute on function public.attendance_api(text,text,jsonb) to anon,authenticated;
-- RLS is defense in depth. No policies intentionally: access is via the checked RPC only.
alter table attendance_private.teachers enable row level security;
alter table attendance_private.courses enable row level security;
alter table attendance_private.members enable row level security;
alter table attendance_private.students enable row level security;
alter table attendance_private.meetings enable row level security;
alter table attendance_private.slips enable row level security;
alter table attendance_private.attendance enable row level security;
alter table attendance_private.audit enable row level security;
alter table attendance_private.rates enable row level security;
commit;
