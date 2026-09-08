// Minimal MCP client for Shopify's storefront server: JSON-RPC 2.0 over
// streamable HTTP, which for this stateless, unauthenticated server is a plain
// POST per call.
import { config } from '../config.js';

let nextId = 1;
let toolCache = null;

async function rpc(method, params) {
  const res = await fetch(config.mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`MCP ${method} HTTP ${res.status}: ${raw.slice(0, 200)}`);
  // Streamable HTTP allows an SSE-framed response; Shopify answers plain JSON
  // today, but parse both so a store on a newer server version still works.
  const jsonText = raw.trimStart().startsWith('{')
    ? raw
    : raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
  const msg = JSON.parse(jsonText);
  if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
  return msg.result;
}

// Tool names and schemas are DISCOVERED, not hardcoded — stores differ (some
// expose five tools, some only policies) and Shopify has renamed tools before.
export async function listTools() {
  if (!toolCache) toolCache = (await rpc('tools/list')).tools || [];
  return toolCache;
}

export async function callTool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  const text = (result.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (result.isError) throw new Error(text.slice(0, 300) || 'tool returned an error');
  return text;
}
