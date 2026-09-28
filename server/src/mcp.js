// The Claude connector: a remote MCP server (Streamable HTTP, JSON responses, stateless).
// Reached only with an OAuth token issued after the person signed in with Google; the
// token carries their user id (ctx.props.userId), so every tool works on their library.
import * as lib from './library.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Sapphire is a teleprompter app. These tools read and edit the user's teleprompter scripts, which sync to their phones within a few seconds, including a script that's live on the teleprompter.
Scripts are read aloud on camera: each line is a paragraph on the teleprompter, blank lines are pauses. Keep the speaker's voice; write for speaking, not reading. Before editing, read the script. Prefer replace_in_script for small changes so the rest stays exactly as it was.`;

const TOOLS = [
  {
    name: 'list_scripts',
    description: "List the user's teleprompter scripts (newest first) with id, title, word count and the opening line.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_script',
    description: 'Read one script in full. Give its id, or a title (or part of one) to find it. Lines are numbered for reference only; the numbers are not part of the script.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string', description: 'Title or part of it, if you do not have the id' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_script',
    description: 'Create a new script. It appears in the Scripts list on the user\'s devices.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string', description: 'Full script. One paragraph per line.' } }, required: ['title', 'text'], additionalProperties: false },
  },
  {
    name: 'update_script',
    description: 'Replace a script\'s full text and/or title. Use for rewrites; for small edits use replace_in_script.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, text: { type: 'string', description: 'The complete new script (no line numbers).' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'replace_in_script',
    description: 'Change one exact passage in a script. `find` must appear exactly once (include a few surrounding words if needed). Everything else stays untouched.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['id', 'find', 'replace'], additionalProperties: false },
  },
];

const words = (t) => (String(t).match(/\S+/g) || []).length;
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

async function findScript(db, userId, { id, title }) {
  if (id) return lib.get(db, userId, id);
  if (!title) return null;
  const all = await lib.list(db, userId);
  const t = title.toLowerCase();
  return all.find((s) => s.title.toLowerCase() === t) || all.find((s) => s.title.toLowerCase().includes(t)) || null;
}

async function callTool(db, userId, name, args = {}) {
  switch (name) {
    case 'list_scripts': {
      const all = await lib.list(db, userId);
      if (!all.length) return text('No scripts yet.');
      return text(all.map((s) => `- ${s.title || 'Untitled'} (id: ${s.id}, ${words(s.text)} words, edited ${new Date(s.updated).toISOString().slice(0, 16).replace('T', ' ')} UTC)\n  ${(s.text.split('\n').find((l) => l.trim()) || '').slice(0, 120)}`).join('\n'));
    }
    case 'read_script': {
      const s = await findScript(db, userId, args);
      if (!s) return fail('Script not found. Use list_scripts to see ids.');
      const lines = s.text.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`);
      return text(`Title: ${s.title}\nid: ${s.id}\nWords: ${words(s.text)}\n\n${lines.join('\n')}`);
    }
    case 'create_script': {
      if (typeof args.text !== 'string') return fail('text is required');
      const s = await lib.create(db, userId, { title: String(args.title || '').slice(0, lib.LIMITS.title), text: args.text.slice(0, lib.LIMITS.text) });
      return text(`Created "${s.title}" (id: ${s.id}). It will appear on the user's devices within a few seconds.`);
    }
    case 'update_script': {
      if (args.text == null && args.title == null) return fail('Give text and/or title.');
      const s = await lib.update(db, userId, String(args.id), { text: args.text != null ? String(args.text).slice(0, lib.LIMITS.text) : undefined, title: args.title != null ? String(args.title).slice(0, lib.LIMITS.title) : undefined });
      if (!s) return fail('Script not found. Use list_scripts to see ids.');
      return text(`Updated "${s.title}". Devices showing it will update within a few seconds.`);
    }
    case 'replace_in_script': {
      const cur = await lib.get(db, userId, String(args.id));
      if (!cur) return fail('Script not found. Use list_scripts to see ids.');
      const find = String(args.find ?? '');
      if (!find) return fail('find is empty');
      const n = cur.text.split(find).length - 1;
      if (n === 0) return fail('That passage was not found. Read the script and copy the exact words (without line numbers).');
      if (n > 1) return fail(`That passage appears ${n} times. Include more surrounding words so it matches once.`);
      await lib.update(db, userId, cur.id, { text: cur.text.replace(find, () => String(args.replace ?? '')) });
      return text(`Done. "${cur.title}" updated; devices showing it will update within a few seconds.`);
    }
    default:
      return null;
  }
}

async function rpc(msg, env, userId) {
  const { id, method, params = {} } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sapphire-prompter', title: 'Sapphire', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const result = await callTool(env.DB, userId, params.name, params.arguments || {});
      return result ? ok(result) : err(-32602, `Unknown tool: ${params.name}`);
    }
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

export const mcpHandler = {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
    const userId = ctx.props?.userId;
    if (!userId) return new Response('Unauthorized', { status: 401 });
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
    }
    const batch = Array.isArray(body) ? body : [body];
    const out = [];
    for (const m of batch) {
      if (m?.id === undefined || m?.id === null) continue; // notification: nothing to answer
      try {
        out.push(await rpc(m, env, userId));
      } catch (e) {
        console.error(e);
        out.push({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'Internal error' } });
      }
    }
    if (!out.length) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? out : out[0]);
  },
};
