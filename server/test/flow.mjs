// End-to-end check against a running dev server (npm run dev, DEV_LOGIN=1):
//   node test/flow.mjs [http://127.0.0.1:8787]
// 1. App: dev sign-in → session token → sync scripts up and down.
// 2. Claude: register client → authorize (approval page + PKCE) → token → MCP tools.
// 3. Isolation: a second person can't see the first person's scripts.
import { createHash, randomBytes } from 'node:crypto';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const APP = 'http://localhost:5173/';
let fails = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) fails++;
};
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function appSignIn(email) {
  const r = await fetch(`${BASE}/google/start?return=${encodeURIComponent(APP)}&dev=${encodeURIComponent(email)}`, { redirect: 'manual' });
  const loc = r.headers.get('location') || '';
  const code = /#\/signin\?c=([\w-]+)/.exec(loc)?.[1];
  const s = await fetch(`${BASE}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' }, body: JSON.stringify({ code }) });
  const body = await s.json();
  return { loc, code, token: body.token, email: body.email, cors: s.headers.get('access-control-allow-origin') };
}
const api = (token, path, body) =>
  fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function claudeConnect(email) {
  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await fetch(`${BASE}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) }).then((r) => r.json());
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'scripts', resource: `${BASE}/mcp` });
  const page = await fetch(`${BASE}/authorize?${q}`);
  const html = await page.text();
  const nonce = /name="n" value="([^"]+)"/.exec(html)?.[1];
  // A post from another site must fail; one from the page itself goes through.
  const forged = await fetch(`${BASE}/authorize`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: new URLSearchParams({ n: nonce, dev: email }), redirect: 'manual' });
  const approve = await fetch(`${BASE}/authorize`, { method: 'POST', headers: { origin: BASE }, body: new URLSearchParams({ n: nonce, dev: email }), redirect: 'manual' });
  const back = new URL(approve.headers.get('location'));
  const tok = await fetch(`${BASE}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) }).then((r) => r.json());
  return { reg, html, forgedStatus: forged.status, back, token: tok.access_token, tok };
}
let rpcId = 0;
const mcp = (token, method, params) =>
  fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) }).then(async (r) => ({ status: r.status, body: r.status === 202 ? null : await r.json() }));
const tool = (token, name, args) => mcp(token, 'tools/call', { name, arguments: args }).then((r) => r.body.result);

// ---------------------------------------------------------------- 1. app
const a = await appSignIn('feranmi@example.com');
ok(a.loc.startsWith(APP + '#/signin?c='), 'dev sign-in redirects back to the app with a one-time code');
ok(!!a.token, 'code trades for a session token');
ok(a.cors === 'http://localhost:5173', 'CORS allows the app origin');
const reuse = await fetch(`${BASE}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: a.code }) });
ok(reuse.status === 400, 'the one-time code cannot be reused');
const bad = await fetch(`${BASE}/google/start?return=${encodeURIComponent('https://evil.example/')}&dev=x@y.z`, { redirect: 'manual' });
ok(bad.status === 400, 'sign-in refuses to return to another site');

const t0 = Date.now();
let s = await api(a.token, '/api/sync', { since: 0, scripts: [{ id: 'ep98', title: 'Episode 98', text: 'Hello and welcome.\nWe do not support fraud.', updated: t0 }] });
ok(s.status === 200 && s.body.rev === 1 && s.body.scripts.length === 1, 'sync uploads a script');
const rev1 = s.body.rev;
s = await api(a.token, '/api/sync', { since: rev1, scripts: [{ id: 'ep98', title: 'Episode 98', text: 'OLD', updated: t0 - 1000 }] });
ok(s.body.rev === rev1 && s.body.scripts.length === 0, 'an older edit does not overwrite a newer one');
ok((await api('nope', '/api/me')).status === 401, 'bad token is rejected');

// ---------------------------------------------------------------- 2. Claude
const c = await claudeConnect('feranmi@example.com');
ok(!!c.reg.client_id, 'Claude-style client registers');
ok(c.html.includes('Connect <b>Claude</b>'), 'approval page names the app');
ok(c.forgedStatus === 403, 'approval posted from another site is refused');
ok(c.back.searchParams.get('state') === 'xyz' && !!c.back.searchParams.get('code'), 'approval returns to Claude with a code');
ok(!!c.token, 'code + PKCE trades for an access token');
const noauth = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
ok(noauth.status === 401 && /resource_metadata|Bearer/.test(noauth.headers.get('www-authenticate') || ''), 'MCP without a token gets a Bearer challenge');

const init = await mcp(c.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
ok(init.body.result?.protocolVersion === '2025-06-18' && init.body.result.capabilities.tools, 'initialize');
ok((await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.token }, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' })).status === 202, 'notification → 202');
const tl = await mcp(c.token, 'tools/list', {});
ok(tl.body.result.tools.map((t) => t.name).join() === 'list_scripts,read_script,create_script,update_script,replace_in_script', 'tools/list');
let r = await tool(c.token, 'list_scripts', {});
ok(r.content[0].text.includes('Episode 98'), "Claude sees the app's script");
r = await tool(c.token, 'read_script', { title: 'episode 98' });
ok(r.content[0].text.includes('  2| We do not support fraud.'), 'read_script by title, numbered lines');
r = await tool(c.token, 'replace_in_script', { id: 'ep98', find: 'Hello and welcome.', replace: 'Welcome back to OYBS.' });
ok(!r.isError, 'replace_in_script');
r = await tool(c.token, 'replace_in_script', { id: 'ep98', find: 'not there', replace: 'x' });
ok(r.isError, 'replace_in_script reports a missing passage');
r = await tool(c.token, 'create_script', { title: 'Episode 99', text: 'Line one.' });
ok(r.content[0].text.startsWith('Created "Episode 99"'), 'create_script');

s = await api(a.token, '/api/sync', { since: rev1, scripts: [] });
const ep98 = s.body.scripts.find((x) => x.id === 'ep98');
ok(ep98?.text.startsWith('Welcome back to OYBS.') && s.body.scripts.some((x) => x.title === 'Episode 99'), "Claude's edits reach the app on its next sync");

// ---------------------------------------------------------------- 3. isolation
const b = await appSignIn('someone-else@example.com');
s = await api(b.token, '/api/sync', { since: 0, scripts: [{ id: 'ep98', title: 'Hijack', text: 'mine now', updated: Date.now() + 1e9 }] });
ok(s.body.scripts.length === 1 && s.body.scripts[0].title === 'Hijack', "another person only sees their own library");
r = await tool(c.token, 'read_script', { id: 'ep98' });
ok(r.content[0].text.includes('Welcome back to OYBS.'), "their script with the same id didn't touch Feranmi's");

console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
