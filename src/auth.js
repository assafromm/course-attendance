let currentClient;
export async function authClient(config) {
  if (!config) return null;
  if (!currentClient) {
    const { createClient } = await import('@supabase/supabase-js');
    currentClient = createClient(config.url, config.publishableKey, { auth: {
      flowType: 'pkce', detectSessionInUrl: true, persistSession: true,
      storage: sessionStorage, storageKey: 'course-attendance-google', autoRefreshToken: true
    } });
  }
  return currentClient;
}
export async function startGoogleLogin(config, frontend) {
  const client = await authClient(config);
  const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: {
    redirectTo: `${frontend.replace(/\/$/,'')}/`, queryParams: { prompt: 'select_account' }
  } });
  if (error) throw error;
}
export async function signOutGoogle(config) {
  if (!config) return;
  const client = await authClient(config);
  const { error } = await client.auth.signOut({ scope: 'local' });
  if (error) throw error;
}
