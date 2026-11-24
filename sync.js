/* Optional account + cloud sync (Supabase). The app works fully offline without it.
   The whole app state is stored as one row per user; the most recently changed copy wins. */
'use strict';

// Fill these in from Supabase: Project Settings → API (URL and the "anon"/publishable key). Both are safe to publish.
const CLOUD = { url: 'https://aibglewvmrogcpezntyb.supabase.co', key: 'sb_publishable_aPIjlIuUjHHwyWAo5h2Mgg_bEaB6Laq' };

const Cloud = (() => {
  const AUTH_KEY = 'fastcal_auth', SYNC_KEY = 'fastcal_sync';
  const ready = () => !!(CLOUD.url && CLOUD.key);
  const readJSON = k => { try { return JSON.parse(localStorage.getItem(k)) || null; } catch { return null; } };
  let auth = readJSON(AUTH_KEY);            // {access_token, refresh_token, expires_at, user_id, email}
  let sync = readJSON(SYNC_KEY) || {};      // {user_id, lastSync (ms), lastRemote (ms)}
  let pushTimer = null, busy = false, status = '';
  const saveAuth = () => auth ? localStorage.setItem(AUTH_KEY, JSON.stringify(auth)) : localStorage.removeItem(AUTH_KEY);
  const home = () => location.origin + location.pathname.replace(/index\.html$/, '');
  const saveSync = () => localStorage.setItem(SYNC_KEY, JSON.stringify(sync));

  async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
    const r = await fetch(CLOUD.url.replace(/\/$/, '') + path, {
      method, cache: 'no-store',
      headers: { apikey: CLOUD.key, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, // publishable keys go only in apikey
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) { const e = new Error((j && (j.msg || j.message || j.error_description || j.error)) || `Request failed (${r.status})`); e.status = r.status; throw e; }
    return j;
  }
  function setSession(j) {
    auth = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, user_id: j.user.id, email: j.user.email };
    saveAuth();
  }
  async function token() {
    if (!auth) throw new Error('Not signed in');
    if (Date.now() > auth.expires_at - 60e3) {
      try { setSession(await api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: auth.refresh_token } })); }
      catch (e) { if (e.status === 400 || e.status === 401) { auth = null; saveAuth(); status = 'Signed out, please sign in again'; } throw e; }
    }
    return auth.access_token;
  }
  const hasLocalData = () => (S.fasts.length + S.foods.length + S.weights.length + (S.recipes || []).length + (S.ingredients || []).length) > 0;

  async function fetchRemote() {
    const rows = await api(`/rest/v1/fastcal_data?select=data,updated_at&user_id=eq.${auth.user_id}`, { token: await token() });
    return rows && rows[0] ? rows[0] : null;
  }
  async function push() {
    if (!ready() || !auth) return;
    clearTimeout(pushTimer); pushTimer = null;
    await api('/rest/v1/fastcal_data?on_conflict=user_id', { method: 'POST', token: await token(), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { user_id: auth.user_id, data: S, updated_at: new Date().toISOString() } });
    sync = { user_id: auth.user_id, lastSync: Date.now(), lastRemote: S.meta.updatedAt || 0 }; saveSync(); status = '';
  }
  function useRemote(data) {
    localStorage.setItem(STORE_KEY, JSON.stringify(data)); S = load();
    sync = { user_id: auth.user_id, lastSync: Date.now(), lastRemote: S.meta.updatedAt || 0 }; saveSync();
    applyTheme(); render();
  }

  // Pull on open; push if this device has the newer copy.
  async function syncNow({ quiet = true } = {}) {
    if (!ready() || !auth || busy || !navigator.onLine) return;
    busy = true;
    try {
      const row = await fetchRemote();
      const localT = S.meta.updatedAt || 0;
      if (!row) { await push(); }
      else {
        const remoteT = (row.data.meta && row.data.meta.updatedAt) || Date.parse(row.updated_at) || 0;
        if (sync.user_id !== auth.user_id && hasLocalData()) {
          // First sync of this phone with this account and both have data: let the person choose.
          const pick = await confirmDialog({ title: 'Which data should we keep?', body: 'Your account already has saved data, and this phone has data too. Pick the one to keep; the other is replaced.', ok: 'Use account data', extra: 'Use this phone\'s data', cancel: 'Decide later' });
          if (pick === true) useRemote(row.data); else if (pick === 'extra') await push(); else { busy = false; return; }
        } else if (sync.user_id !== auth.user_id || remoteT > localT) useRemote(row.data);
        else if (localT > remoteT) await push();
        else { sync.lastSync = Date.now(); saveSync(); }
      }
      status = ''; if (!quiet) toast('Synced');
    } catch (e) { status = 'Sync failed: ' + e.message; if (!quiet) toast(status); }
    busy = false;
    if (document.getElementById('acctCard')) render();
  }
  // Called after every local save: send the change a few seconds later.
  function changed() {
    if (!ready() || !auth || sync.user_id !== auth.user_id) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => push().catch(e => { status = 'Sync failed: ' + e.message; }), 2500);
  }

  async function signIn(email, password) {
    setSession(await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }));
    await syncNow({ quiet: false });
  }
  async function signUp(email, password) {
    const j = await api('/auth/v1/signup?redirect_to=' + encodeURIComponent(home()), { method: 'POST', body: { email, password } });
    if (j && j.access_token) { setSession(j); await syncNow({ quiet: false }); return true; }
    return false; // email confirmation is on: they confirm, then sign in
  }
  async function resetPassword(email) { await api('/auth/v1/recover?redirect_to=' + encodeURIComponent(home()), { method: 'POST', body: { email } }); }
  async function signOut() {
    if (pushTimer) { try { await push(); } catch {} }
    try { await api('/auth/v1/logout', { method: 'POST', token: auth.access_token }); } catch {}
    auth = null; saveAuth(); sync = {}; saveSync();
  }

  function cardHTML() {
    if (!ready()) return `<div class="card" id="acctCard"><h2>Account</h2><p class="small muted" style="margin:0">Cloud sync isn't set up for this copy of the app yet, so your data stays on this phone.</p></div>`;
    if (auth) {
      const when = sync.lastSync ? `${fmtTime(sync.lastSync)} ${dayLabelFor(sync.lastSync)}` : 'not yet';
      return `<div class="card" id="acctCard"><h2>Account</h2>
        <p class="small" style="margin:0 0 4px">Signed in as <b>${esc(auth.email)}</b></p>
        <p class="small muted" style="margin:0 0 12px">${status ? esc(status) : `Last synced ${when}. Changes sync automatically.`}</p>
        <div class="btn-grid"><button class="btn" id="acSync">Sync now</button><button class="btn" id="acOut">Sign out</button></div></div>`;
    }
    return `<div class="card" id="acctCard"><h2>Account <span class="small muted" style="font-weight:600">(optional)</span></h2>
      <p class="small muted" style="margin:0">Sign in to back up your data and use it on more than one device. Without an account, everything stays on this phone.</p>
      ${status ? `<p class="small" style="color:var(--danger)">${esc(status)}</p>` : ''}
      <label>Email</label><input type="email" id="acEmail" autocomplete="email" autocapitalize="off" value="${esc(sync.email || '')}">
      <label>Password</label><input type="password" id="acPass" autocomplete="current-password" placeholder="At least 6 characters">
      <div class="btn-grid" style="margin-top:12px"><button class="btn primary" id="acIn">Sign in</button><button class="btn" id="acUp">Create account</button></div>
      <div class="center"><button class="link small" id="acForgot">Forgot password?</button></div></div>`;
  }
  function bindCard() {
    const $ = id => document.getElementById(id);
    const creds = () => { const e = $('acEmail').value.trim(), p = $('acPass').value; if (!e || p.length < 6) { toast('Enter your email and a password of 6+ characters'); return null; } return [e, p]; };
    const run = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toast(e.message); } btn.disabled = false; render(); };
    if ($('acIn')) $('acIn').onclick = e => { const c = creds(); if (c) run(e.target, () => signIn(...c)); };
    if ($('acUp')) $('acUp').onclick = e => { const c = creds(); if (c) run(e.target, async () => { if (!(await signUp(...c))) { sync.email = c[0]; saveSync(); toast('Check your email to confirm, then sign in here'); } }); };
    if ($('acForgot')) $('acForgot').onclick = e => { const m = $('acEmail').value.trim(); if (!m) return toast('Enter your email first'); run(e.target, async () => { await resetPassword(m); toast('Password reset email sent'); }); };
    if ($('acSync')) $('acSync').onclick = e => run(e.target, () => syncNow({ quiet: false }));
    if ($('acOut')) $('acOut').onclick = async e => { if ((await confirmDialog({ title: 'Sign out?', body: 'Your data stays on this phone. It just stops syncing.', ok: 'Sign out' })) === true) run(e.target, signOut); };
  }
  // Links from Supabase emails land here with tokens in the URL hash.
  async function handleEmailLink() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (!h.get('type') && !h.get('error')) return;
    history.replaceState(null, '', home());
    if (h.get('error')) return toast(h.get('error_description') || 'That link has expired');
    if (h.get('type') === 'recovery' && h.get('access_token')) {
      openSheet(`<h2>Set a new password</h2><label>New password</label><input type="password" id="npw" autocomplete="new-password" placeholder="At least 6 characters"><button class="btn primary" id="npwGo" style="margin-top:14px">Save password</button>`);
      document.getElementById('npwGo').onclick = async () => {
        const pw = document.getElementById('npw').value; if (pw.length < 6) return toast('Use at least 6 characters');
        try { await api('/auth/v1/user', { method: 'PUT', token: h.get('access_token'), body: { password: pw } }); closeSheet(); toast('Password updated. Sign in with it in the app.'); }
        catch (e) { toast(e.message); }
      };
    } else toast('Email confirmed! Now sign in from Settings → Account.');
  }
  return { ready, handleEmailLink, signedIn: () => !!auth, syncNow, changed, signOut, cardHTML, bindCard };
})();
