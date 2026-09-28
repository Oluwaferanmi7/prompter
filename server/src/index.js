// Sapphire Prompter cloud: script library + Claude connector on Cloudflare Workers.
//   /mcp            Claude connector (MCP), OAuth-protected — see mcp.js
//   /authorize, /token, /register   OAuth for the connector (workers-oauth-provider)
//   /api/*          the app's sync API (Google sign-in session tokens) — see app.js
//   /google/*       Google sign-in for both
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { appHandler } from './app.js';
import { mcpHandler } from './mcp.js';

// The provider needs this server's public address up front (it's the token audience in
// the OAuth metadata). Build one per origin on first use: https://lim-prompter.<you>.workers.dev
// in production, http://127.0.0.1:8787 under wrangler dev. Cloudflare only routes this
// Worker's own hostnames here, so the origin can't be spoofed.
const providers = new Map();
function providerFor(origin) {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider({
      apiRoute: '/mcp',
      apiHandler: mcpHandler,
      defaultHandler: appHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register', // older MCP clients (dynamic registration)
      clientIdMetadataDocumentEnabled: true, // newer MCP clients (client ID metadata documents)
      scopesSupported: ['scripts'],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['scripts'],
        bearer_methods_supported: ['header'],
        resource_name: 'Sapphire Prompter scripts',
      },
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch(request, env, ctx) {
    const origin = new URL(request.url).origin.toLowerCase();
    return providerFor(origin).fetch(request, env, ctx);
  },
};
