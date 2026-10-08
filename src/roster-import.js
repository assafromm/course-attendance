// Moodle exports localize their headers; values (especially IDs) stay untouched.
export function detectRosterColumns(headers) {
  const normalized=headers.map(header=>String(header).normalize('NFKC')
    .replace(/[\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,'')
    .replace(/["'״׳._-]/g,'').replace(/\s+/g,'').toLowerCase());
  const find=pattern=>String(normalized.findIndex(header=>pattern.test(header)));
  const identifier=find(/^(מספרזיהוי|מספרמזהה|מזהה|תעודתזהות|מספרתעודתזהות|מספרזהות|תז|מספרסטודנט|idnumber|studentid|studentnumber)$/);
  return {
    first_name:find(/^(שםפרטי|firstname)$/),
    last_name:find(/^(שםמשפחה|lastname|surname)$/),
    identifier:identifier==='-1'?find(/^(שםמשתמש|username)$/):identifier,
  };
}
