-- Permit any verified Google email; active teacher and course checks stay intact.
-- No account is authorized by this migration and no roster data is touched.
begin;
do $migration$
declare definition text;
begin
 definition:=pg_get_functiondef('public.attendance_api(text,text,jsonb)'::regprocedure);
 if position('and split_part(lower(u.email),''@'',2)=''mail.huji.ac.il'' limit 1;' in definition)=0 then
   raise exception 'Unexpected API definition: stop and inspect before updating';
 end if;
 definition:=replace(definition,'and split_part(lower(u.email),''@'',2)=''mail.huji.ac.il'' limit 1;','limit 1;');
 definition:=replace(definition,$old$'^[^\s@]+@mail\.huji\.ac\.il$'$old$,$new$'^[^\s@]+@[^\s@]+\.[^\s@]+$'$new$);
 definition:=replace(definition,'יש להשתמש בכתובת האוניברסיטאית','כתובת מייל לא תקינה');
 definition:=replace(definition,'כתובת אוניברסיטאית לא תקינה','כתובת מייל לא תקינה');
 execute definition;
end $migration$;
commit;
