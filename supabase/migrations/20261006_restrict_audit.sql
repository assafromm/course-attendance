-- Audit recording remains unchanged. Reading the log is administrator-only.
begin;
do $migration$
declare definition text;
begin
 definition:=pg_get_functiondef('public.attendance_api(text,text,jsonb)'::regprocedure);
 if position($old$elsif p[3]='audit' and method='GET' then select$old$ in definition)=0 then
   raise exception 'Unexpected audit route: stop and inspect before updating';
 end if;
 definition:=replace(definition,
   $old$elsif p[3]='audit' and method='GET' then select$old$,
   $new$elsif p[3]='audit' and method='GET' then
   if teacher.role<>'admin' then raise exception 'יומן הפעילות זמין למנהל המערכת בלבד';end if;
   select$new$);
 execute definition;
end $migration$;
commit;
