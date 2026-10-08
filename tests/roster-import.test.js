import test from 'node:test';
import assert from 'node:assert/strict';
import Papa from 'papaparse';
import { detectRosterColumns } from '../src/roster-import.js';

test('Hebrew Moodle CSV headers and UTF-8 BOM preserve names and leading-zero IDs',()=>{
  const csv='\uFEFF"שם פרטי","שם משפחה","מספר זיהוי","דוא""ל",קבוצות,תפקידים\r\n"בדיקה","ישראלי","001234567","test@example.invalid","1","סטודנט"';
  const result=Papa.parse(csv,{skipEmptyLines:'greedy',dynamicTyping:false});
  assert.deepEqual(result.errors,[]);
  const mapping=detectRosterColumns(result.data[0]);
  assert.deepEqual(mapping,{first_name:'0',last_name:'1',identifier:'2'});
  assert.equal(result.data[1][Number(mapping.identifier)],'001234567');
  assert.equal(result.data[1][Number(mapping.first_name)],'בדיקה');
});
test('English, mixed, reordered and RTL-marked headers remain supported',()=>{
  assert.deepEqual(detectRosterColumns(['Email address','ID number','Surname','First name']),{first_name:'3',last_name:'2',identifier:'1'});
  assert.deepEqual(detectRosterColumns(['Username','שם משפחה','First_name','\u200Fמספר  זיהוי\u200E']),{first_name:'2',last_name:'1',identifier:'3'});
  for(const id of ['ת״ז','ת.ז.','תעודת זהות','מספר סטודנט','Student ID'])assert.equal(detectRosterColumns(['שם פרטי','Last name',id]).identifier,'2');
  assert.equal(detectRosterColumns(['First name','Last name','Username']).identifier,'2');
  assert.equal(detectRosterColumns(['First name','Last name','Email address']).identifier,'-1');
});
