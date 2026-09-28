# Sapphire Prompter cloud

Cloudflare Worker behind the app's **Sign in with Google**:

- **Cloud library:** one script library per Google account (D1). Signed-in devices sync every few seconds; newest edit wins; deletes carry over.
- **Claude connector:** a remote MCP server at `/mcp`. Add it once as a custom connector in your own Claude (Settings → Connectors). The connector's login is the same Google sign-in, so your Claude only reaches your library. Tools: `list_scripts`, `read_script`, `create_script`, `update_script`, `replace_in_script`.

Free on Cloudflare's free plan at this size.

## One-time setup

```bash
cd server
npm install
npx wrangler login                          # browser: approve access to the Cloudflare account
npx wrangler d1 create prompter             # copy the database_id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV   # copy the id into wrangler.jsonc
npm run db:remote                           # create the tables
npx wrangler deploy                         # prints the URL, e.g. https://lim-prompter.<you>.workers.dev
```

**Google sign-in key** (Google Cloud Console → APIs & Services):
1. OAuth consent screen: External, app name "Sapphire Prompter", your email as support + developer contact. Scopes: just the defaults (email, profile, openid). Publish the app (or add test users).
2. Credentials → Create credentials → OAuth client ID → **Web application**.
   - Authorized redirect URI: `https://lim-prompter.<you>.workers.dev/google/callback`
3. Copy the client ID and secret into the Worker:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Then put the Worker URL in `app/js/config.js` (`LIVE`) and push. The app shows **Sign in with Google** on Home.

**Claude:** Settings → Connectors → Add custom connector → URL `https://lim-prompter.<you>.workers.dev/mcp`. It opens the approval page, then Google.

## Local development

```bash
cp .dev.vars.example .dev.vars   # DEV_LOGIN=1 enables a fake login on localhost only
npm run db:local
npm run dev                      # http://localhost:8787
```

App against it: `http://localhost:5173/?cloud=http://localhost:8787` (the override only works on localhost).
Dev sign-in without Google: `http://localhost:8787/google/start?return=http://localhost:5173/&dev=you@example.com`.
