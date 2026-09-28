// Everything that isn't the MCP endpoint: Google sign-in (for the app and for the Claude
// connector's OAuth), the app's sync API, and the connector's approval page.
import { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import * as lib from './library.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const TTL = 1800; // seconds a login may take

// ------------------------------------------------------------------ helpers
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const rand = (bytes = 32) => {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const kvPut = (env, key, value) => env.OAUTH_KV.put('lp:' + key, JSON.stringify(value), { expirationTtl: TTL });
async function kvTake(env, key) {
  const v = await env.OAUTH_KV.get('lp:' + key, 'json');
  if (v) await env.OAUTH_KV.delete('lp:' + key);
  return v;
}
const appOrigins = (env) => String(env.APP_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const isDev = (env, url) => env.DEV_LOGIN === '1' && ['localhost', '127.0.0.1'].includes(url.hostname);

function cors(env, request) {
  const origin = request.headers.get('origin');
  if (!origin || !appOrigins(env).includes(origin)) return {};
  return { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '86400', vary: 'origin' };
}

function page(title, body, status = 200, headers = {}) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1628;color:#eaf3ff;font:16px/1.5 system-ui,-apple-system,sans-serif}
.card{max-width:420px;margin:24px;padding:28px;border-radius:20px;background:#13223a;border:1px solid #283f63}
h1{font-size:22px;margin:0 0 8px}p{color:#9fb2cf;margin:8px 0}b{color:#c5a94a}
button{margin-top:18px;width:100%;height:50px;border:0;border-radius:12px;background:#5b9bf0;color:#0b1628;font-weight:700;font-size:16px}
small{display:block;margin-top:14px;color:#7d90ad}</style></head><body><div class="card">${body}</div></body></html>`,
    // form-action also governs where a form's redirect may go, so Google must be listed.
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com", ...headers } }
  );
}

// ------------------------------------------------------------------ Google
function googleRedirect(env, url, state) {
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return Response.redirect(`${GOOGLE_AUTH}?${q}`, 302);
}

// Code → verified Google profile. The ID token comes straight from Google's token
// endpoint over TLS (authenticated with our client secret), so its claims can be trusted
// after checking audience, issuer and expiry.
async function googleProfile(env, url, code) {
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${url.origin}/google/callback`, grant_type: 'authorization_code' }),
  });
  if (!res.ok) throw new Error('Google sign-in failed');
  const { id_token } = await res.json();
  const part = id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const claims = JSON.parse(decodeURIComponent(escape(atob(part))));
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new Error('Wrong audience');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error('Wrong issuer');
  if (claims.exp * 1000 < Date.now()) throw new Error('Expired');
  if (!claims.email_verified) throw new Error('Google email not verified');
  return { id: 'g-' + claims.sub, email: claims.email, name: claims.name || '' };
}

// After Google (or dev) login: finish whichever flow started it.
async function finishLogin(env, url, flow, profile) {
  await lib.upsertUser(env.DB, profile);
  if (flow.kind === 'app') {
    // One-time handoff code (60 s) in the URL fragment; the app trades it for a token.
    const code = rand(24);
    await env.OAUTH_KV.put('lp:handoff:' + code, JSON.stringify({ userId: profile.id }), { expirationTtl: 60 });
    return Response.redirect(`${flow.return}#/signin?c=${code}`, 302);
  }
  if (flow.kind === 'mcp') {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: flow.oauth,
      userId: profile.id,
      metadata: { email: profile.email },
      scope: flow.oauth.scope,
      props: { userId: profile.id, email: profile.email },
    });
    return Response.redirect(redirectTo, 302);
  }
  return page('Sign-in', '<h1>Something went wrong</h1><p>Unknown sign-in. Please try again.</p>', 400);
}

// ------------------------------------------------------------------ app API auth
async function sessionUser(env, request) {
  const m = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  const hash = await sha256(m[1]);
  const row = await env.DB.prepare('SELECT user_id, last_used FROM sessions WHERE token_hash = ?1').bind(hash).first();
  if (!row) return null;
  if (Date.now() - row.last_used > 3600_000) await env.DB.prepare('UPDATE sessions SET last_used = ?1 WHERE token_hash = ?2').bind(Date.now(), hash).run();
  return row.user_id;
}

// ------------------------------------------------------------------ routes
export const appHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // ---------------- app API (CORS, bearer token)
      if (path.startsWith('/api/')) {
        const h = cors(env, request);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

        if (path === '/api/session' && request.method === 'POST') {
          const { code } = await request.json().catch(() => ({}));
          const hand = code && (await kvTake(env, 'handoff:' + code));
          if (!hand) return json({ error: 'Sign-in expired. Please try again.' }, 400, h);
          const token = rand(32);
          await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created, last_used) VALUES (?1, ?2, ?3, ?3)').bind(await sha256(token), hand.userId, Date.now()).run();
          const u = await lib.getUser(env.DB, hand.userId);
          return json({ token, email: u.email, name: u.name }, 200, h);
        }

        const userId = await sessionUser(env, request);
        if (!userId) return json({ error: 'Signed out' }, 401, h);

        if (path === '/api/me') {
          const u = await lib.getUser(env.DB, userId);
          return json({ email: u.email, name: u.name }, 200, h);
        }
        if (path === '/api/sync' && request.method === 'POST') {
          if (Number(request.headers.get('content-length') || 0) > 5_000_000) return json({ error: 'Too big' }, 413, h);
          const body = await request.json();
          return json(await lib.sync(env.DB, userId, body), 200, h);
        }
        if (path === '/api/logout' && request.method === 'POST') {
          const token = /^Bearer (.+)$/.exec(request.headers.get('authorization'))[1];
          await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256(token)).run();
          return json({ ok: true }, 200, h);
        }
        return json({ error: 'Not found' }, 404, h);
      }

      // ---------------- app sign-in: /google/start?return=<app url>
      if (path === '/google/start') {
        const ret = url.searchParams.get('return') || '';
        let origin = '';
        try {
          origin = new URL(ret).origin;
        } catch {}
        if (!appOrigins(env).includes(origin)) return page('Sign-in', '<h1>Not allowed</h1><p>Sign-in can only return to the Sapphire app.</p>', 400);
        const flow = { kind: 'app', return: ret.split('#')[0] };
        const dev = url.searchParams.get('dev');
        if (dev && isDev(env, url)) return finishLogin(env, url, flow, { id: 'dev-' + dev.replace(/[^\w.@-]/g, ''), email: dev, name: 'Dev ' + dev });
        const state = rand(24);
        await kvPut(env, 'state:' + state, flow);
        return googleRedirect(env, url, state);
      }

      // ---------------- Google comes back here for both flows
      if (path === '/google/callback') {
        const flow = await kvTake(env, 'state:' + (url.searchParams.get('state') || ''));
        if (!flow) return page('Sign-in', '<h1>Google sign-in timed out</h1><p>Step 2 of 2. Go back and start the sign-in again.</p>', 400);
        const code = url.searchParams.get('code');
        if (!code) return page('Sign-in', '<h1>Sign-in cancelled</h1><p>You can close this and try again.</p>', 400);
        return finishLogin(env, url, flow, await googleProfile(env, url, code));
      }

      // ---------------- Claude connector: OAuth approval page
      if (path === '/authorize' && request.method === 'GET') {
        let oauth;
        try {
          oauth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        } catch (e) {
          if (!(e instanceof AuthorizationError)) throw e;
          // Only redirect once the client and its redirect URI were validated.
          if (!e.redirectUri) return page('Connect', `<h1>Can't connect</h1><p>${esc(e.description)}</p>`, 400);
          const back = new URL(e.redirectUri);
          back.searchParams.set('error', e.code);
          back.searchParams.set('error_description', e.description);
          if (e.state) back.searchParams.set('state', e.state);
          if (e.issuer) back.searchParams.set('iss', e.issuer);
          return Response.redirect(back.href, 302);
        }
        const client = await env.OAUTH_PROVIDER.lookupClient(oauth.clientId);
        if (!client) return page('Connect', '<h1>Unknown app</h1>', 400);
        const nonce = rand(24);
        await kvPut(env, 'approve:' + nonce, { oauth });
        const who = client.clientName || 'An app';
        let host = '';
        try {
          host = new URL(oauth.redirectUri).host;
        } catch {}
        const devBox = isDev(env, url) ? '<p><input name="dev" placeholder="dev email (local only)"></p>' : '';
        return page(
          'Connect to Sapphire',
          `<h1>Connect <b>${esc(who)}</b> to Sapphire?</h1>
           <p>It will be able to <b>read, create and edit your scripts</b>. Scripts it changes show up on your teleprompter.</p>
           <p>Next you'll sign in with Google, so it only ever reaches <b>your</b> library.</p>
           <form method="post" action="/authorize"><input type="hidden" name="n" value="${nonce}">${devBox}<button>Continue with Google</button></form>
           <small>Returns to ${esc(host)}</small>`,
          200
        );
      }
      if (path === '/authorize' && request.method === 'POST') {
        // The approval must be clicked on this page, not posted from another site: browsers
        // stamp form posts with the page's origin, which another site can't fake.
        const from = request.headers.get('origin') || (request.headers.get('referer') ? new URL(request.headers.get('referer')).origin : '');
        if (from !== url.origin) return page('Connect', "<h1>Can't approve from here</h1><p>Go back to Claude and click Connect again.</p>", 403);
        const form = await request.formData();
        const nonce = String(form.get('n') || '');
        // Not single-use: a second tap (slow page, impatient thumb) must carry on to Google,
        // not fail. It still expires, and only posts from this page count (checked above).
        const saved = nonce ? await env.OAUTH_KV.get('lp:approve:' + nonce, 'json') : null;
        if (!saved) return page('Connect', '<h1>This approval page expired</h1><p>Step 1 of 2. Go back to Claude and click Connect again.</p>', 400);
        const flow = { kind: 'mcp', oauth: saved.oauth };
        const dev = String(form.get('dev') || '');
        if (dev && isDev(env, url)) return finishLogin(env, url, flow, { id: 'dev-' + dev.replace(/[^\w.@-]/g, ''), email: dev, name: 'Dev ' + dev });
        const state = rand(24);
        await kvPut(env, 'state:' + state, flow);
        return googleRedirect(env, url, state);
      }

      if (path === '/') return page('Sapphire', '<h1>Sapphire cloud</h1><p>Script library and Claude connector for Sapphire.</p>');
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error(err);
      if (path.startsWith('/api/')) return json({ error: 'Server error' }, 500, cors(env, request));
      return page('Error', `<h1>Something went wrong</h1><p>${esc(err.message)}</p>`, 500);
    }
  },
};
