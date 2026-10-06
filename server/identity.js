import { Problem } from './store.js';

// Only the authenticated Auth-server response is trusted, never browser claims
// or editable user_metadata. Attendance roles remain in the attendance database.
export function googleIdentityEmail(user) {
  const email = typeof user?.email === 'string' ? user.email.trim().toLowerCase() : '';
  const identity = user?.identities?.find(i => i.provider === 'google' && i.identity_data?.email?.toLowerCase() === email);
  if (!user?.id || user?.app_metadata?.provider !== 'google' || !identity || identity.identity_data.email_verified !== true)
    throw new Problem('יש להיכנס באמצעות חשבון Google מאומת', 403);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Problem('כתובת מייל לא תקינה', 403);
  return email;
}

export async function verifySupabaseGoogle(accessToken, config, fetcher = fetch) {
  if (!config.url || !config.key) throw new Problem('ההתחברות דרך Supabase טרם הוגדרה', 503);
  if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 8192) throw new Problem('ההתחברות אינה תקינה', 401);
  let response;
  try {
    response = await fetcher(`${config.url.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: config.key, Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000)
    });
  } catch { throw new Problem('שירות ההתחברות אינו זמין כרגע', 503); }
  if (!response.ok) throw new Problem('ההתחברות פגה או אינה תקינה. יש להיכנס שוב.', 401);
  let user;
  try { user = await response.json(); } catch { throw new Problem('תגובה לא תקינה משירות ההתחברות', 503); }
  return googleIdentityEmail(user);
}
