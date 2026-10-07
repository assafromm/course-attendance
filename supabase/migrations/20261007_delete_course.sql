-- Adds an owner-only, explicitly confirmed deletion route. Deletes no existing data on migration.
begin;
do $migration$
declare definition text;
begin
 definition:=pg_get_functiondef('public.attendance_api(text,text,jsonb)'::regprocedure);
 if position($old$if array_length(p,1)=2 and method='GET' then$old$ in definition)=0 then
   raise exception 'Unexpected course route: stop and inspect before updating';
 end if;
 definition:=replace(definition,
 $old$if array_length(p,1)=2 and method='GET' then$old$,
 $new$if p[3]='delete' and array_length(p,1)=3 and method='POST' then
 select * into c from attendance_private.courses where id=cid for update;
 if c.owner is distinct from e then raise exception 'רק בעל הקורס יכול למחוק אותו';end if;
 if body->>'confirmName' is distinct from c.name then raise exception 'יש להקליד את שם הקורס במדויק לאישור המחיקה';end if;
 perform 1 from attendance_private.meetings where course_id=cid order by id for update;
 delete from attendance_private.attendance where meeting_id in(select id from attendance_private.meetings where course_id=cid);
 delete from attendance_private.slips where meeting_id in(select id from attendance_private.meetings where course_id=cid);
 delete from attendance_private.meetings where course_id=cid;
 delete from attendance_private.students where course_id=cid;
 delete from attendance_private.members where course_id=cid;
 delete from attendance_private.courses where id=cid;
 perform attendance_private.log(e,'course.deleted',cid,null,jsonb_build_object('name',c.name));
 return '{"ok":true}';
 elsif array_length(p,1)=2 and method='GET' then$new$);
 execute definition;
end $migration$;
commit;
