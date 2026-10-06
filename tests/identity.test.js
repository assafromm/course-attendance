import test from 'node:test';
import assert from 'node:assert/strict';
import { googleIdentityEmail, verifySupabaseGoogle } from '../server/identity.js';
const user=()=>({id:'verified-user',email:'Lecturer@mail.huji.ac.il',app_metadata:{provider:'google'},identities:[{provider:'google',identity_data:{email:'Lecturer@mail.huji.ac.il',email_verified:true}}]});
test('Supabase identity is Google-verified and email-domain restricted',()=>{
  assert.equal(googleIdentityEmail(user(),['mail.huji.ac.il']),'lecturer@mail.huji.ac.il');
  assert.throws(()=>googleIdentityEmail(user(),['example.org']),/אוניברסיטאי/);
  const unverified=user();unverified.identities[0].identity_data.email_verified=false;
  assert.throws(()=>googleIdentityEmail(unverified,['mail.huji.ac.il']),/מאומת/);
  const mismatch=user();mismatch.identities[0].identity_data.email='other@mail.huji.ac.il';
  assert.throws(()=>googleIdentityEmail(mismatch,['mail.huji.ac.il']),/מאומת/);
  const emailLogin=user();emailLogin.app_metadata.provider='email';
  emailLogin.user_metadata={provider:'google',role:'admin',email_verified:true};
  assert.throws(()=>googleIdentityEmail(emailLogin,['mail.huji.ac.il']),/מאומת/);
});
test('Supabase tokens are checked by the configured Auth server, not decoded locally',async()=>{
  const config={url:'https://auth.example.org',key:'publishable-test',domains:['mail.huji.ac.il']};
  let call;
  const email=await verifySupabaseGoogle('a'.repeat(40),config,async(url,options)=>{call={url,options};return {ok:true,json:async()=>user()};});
  assert.equal(email,'lecturer@mail.huji.ac.il');assert.equal(call.url,'https://auth.example.org/auth/v1/user');assert.equal(call.options.headers.Authorization,`Bearer ${'a'.repeat(40)}`);
  await assert.rejects(()=>verifySupabaseGoogle('a'.repeat(40),config,async()=>({ok:false})),/פגה/);
  await assert.rejects(()=>verifySupabaseGoogle('a'.repeat(40),config,async()=>{throw new Error('offline');}),/זמין/);
  await assert.rejects(()=>verifySupabaseGoogle('a'.repeat(40),{}),/טרם הוגדרה/);
});
