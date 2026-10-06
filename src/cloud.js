import { authClient } from './auth.js';

export const cloudEnabled = import.meta.env.VITE_CLOUD === 'true';
const supabase = {
  url: import.meta.env.VITE_SUPABASE_URL,
  publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
};

export async function cloudRequest(path, body, method) {
  if (!supabase.url || !supabase.publishableKey) throw new Error('הגדרות הענן חסרות');
  if (path === '/config') return {
    supabase, frontend: `${location.origin}${location.pathname}`.replace(/\/$/, ''),
    developmentLogin: false
  };
  if (path === '/auth/logout') return { ok: true };
  const login = path === '/auth/supabase';
  const payload = { ...(body || {}) };
  // datetime-local inputs carry no offset. Convert using the lecturer's clock.
  for (const key of ['opens', 'closes']) {
    if (payload[key]) payload[key] = new Date(payload[key]).toISOString();
  }
  const client = await authClient(supabase);
  const { data, error } = await client.rpc('attendance_api', {
    path: login ? '/me' : path,
    method: login ? 'GET' : method || (body ? 'POST' : 'GET'),
    body: login ? {} : payload
  });
  if (error) throw new Error('לא ניתן להתחבר למערכת. נסו שוב בעוד רגע.');
  if (data?.error) throw new Error(data.error);
  if (path.includes('/audit') && Array.isArray(data)) {
    return data.map(row => ({ ...row, details: JSON.stringify(row.details) }));
  }
  return login ? { token: 'cloud', user: data } : data;
}
