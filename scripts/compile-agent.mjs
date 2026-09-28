// Compile the stored Voice Agent (design 6-7): stage s0 of server/lib/states.js becomes the request body of
// POST /v1/agents (first time) or PUT /v1/agents/{id} (update). The later stages are swapped in during the call
// with session.update (tools + system prompt + listening setting), so only s0 is stored.
//
//   node scripts/compile-agent.mjs [--dry] [--env <path>]...
//
// Writes agents/every-won-heard.json (the body, no keys; committed so people can read the agent) and sets
// VOICE_AGENT_ID=<id> in ./.env and in every --env file. The key comes from ./.env (ASSEMBLYAI_API_KEY).
// Which agent: VOICE_AGENT_ID if set, else an agent with the same name on the account, else a new one.
// Stops on 401/403/429 without retrying. Creating or updating an agent is free (sessions are what cost money).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../server/env.js';
import { createAssemblyAI } from '../server/lib/assemblyai.js';
import { storedAgentBody } from '../server/lib/states.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const envFiles = [path.join(root, '.env')];
for (let i = 0; i < args.length; i++) if (args[i] === '--env' && args[i + 1]) envFiles.push(path.resolve(args[++i]));

const body = storedAgentBody();
const outFile = path.join(root, 'agents', 'every-won-heard.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(body, null, 2)}\n`);
console.log(`wrote ${path.relative(root, outFile)} (${body.tools.length} tools: ${body.tools.map((t) => t.name).join(', ')})`);
if (dry) process.exit(0);

loadEnv(new URL('../.env', import.meta.url));
const aai = createAssemblyAI({ logger: { warn() {}, error() {}, log() {} } });
if (!aai.enabled) { console.error('ASSEMBLYAI_API_KEY is not set in .env'); process.exit(1); }

function stopOn(err) {
  if ([401, 403, 429].includes(err.status)) {
    console.error(`STOP: ${err.status} from the agents API, not retrying. ${err.message}`);
    process.exit(2);
  }
  throw err;
}

let agent = null;
let id = (process.env.VOICE_AGENT_ID || '').trim() || null;
try {
  if (!id) {
    const list = await aai.listAgents();
    const rows = Array.isArray(list) ? list : list.agents || list.data || [];
    id = rows.find((a) => a.name === body.name)?.id || null;
    if (id) console.log(`found an agent named "${body.name}": ${id}`);
  }
  if (id) {
    try {
      agent = await aai.updateAgent(id, body);
      console.log(`updated ${agent.id}`);
    } catch (err) {
      if (err.status !== 404) throw err;
      console.log(`agent ${id} not found, creating a new one`);
    }
  }
  if (!agent) {
    agent = await aai.createAgent(body);
    console.log(`created ${agent.id}`);
  }
} catch (err) {
  stopOn(err);
}

// what the service kept (unknown fields are dropped silently, so check the listening setting came through)
const kept = agent.input || {};
console.log(`voice ${agent.voice?.voice_id || agent.output?.voice || '?'} · tools ${(agent.tools || []).map((t) => t.name).join(', ')} · input ${Object.keys(kept).filter((k) => kept[k] != null).join(', ')} · updated ${agent.updated_at || '?'}`);

function setEnv(file, key, value) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=[^\r\n]*`, 'm');
  text = re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n# Stored Voice Agent (scripts/compile-agent.mjs)\n${line}\n`;
  fs.writeFileSync(file, text);
}
for (const f of [...new Set(envFiles)]) {
  setEnv(f, 'VOICE_AGENT_ID', agent.id);
  console.log(`VOICE_AGENT_ID set in ${f}`);
}
