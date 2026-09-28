/**
 * MarketPilot Voice Agent - API server (Node 22+, no framework).
 *
 *   GET  /api/health                         key/LLM/MCP status for the UI badges
 *   GET  /api/assemblyai/token               short-lived AssemblyAI streaming token (API key never leaves the server)
 *   POST /api/session                        {lang, engine} -> {sessionId, greeting}; engine 'voice-agent' adds
 *                                            {agentId, state, session_update} (session_update = the first session.update)
 *   GET  /api/voice-agent/token              short-lived Voice Agent API token (one session, capped at VA_MAX_SESSION_SECONDS)
 *   POST /api/session/:id/heard              {item_id, text, at, via, role?} a final transcript.user (the grounding input)
 *   POST /api/session/:id/tool               {call_id, name, arguments, last_item_id} -> {result, is_error, state, session_update, ...}
 *   POST /api/session/:id/utterance          {text} -> agent reply + profile + plan
 *   POST /api/session/:id/voice-turn         raw WAV body (Korean turn mode) -> transcript + agent reply
 *   POST /api/session/:id/analyze            raw WAV body (whole call) -> AssemblyAI speaker/sentiment/key-phrase brief
 *   POST /api/session/:id/checkout           {customerName, customerPhone?} -> MarketPilot card checkout link
 *   GET  /api/session/:id                    session snapshot (profile, plan, history, brief, ledger)
 *   GET  /api/session/:id/ledger             money ledger rows (value, source, phrase, heard/read back/confirmed times)
 *   POST /api/session/:id/aai-session        {aai_session_id} from the Voice Agent session.ready
 *   GET  /api/session/:id/receipt            ledger checked against AssemblyAI's record of the call + LLM Gateway summary
 *   GET  /api/products                       catalog (live MCP or mock, with source)
 *   GET  /api/places?keyword=                Naver Place search through MCP
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';
import { createAssemblyAI } from './lib/assemblyai.js';
import { createMcpClient } from './lib/mcp.js';
import { createLlm } from './lib/llm.js';
import { createAgent } from './lib/agent.js';
import { buildBrief, reconcile, reconcileTurns } from './lib/brief.js';
import { createGateway, templateCallSummary } from './lib/gateway.js';
import { buildPlan, checkoutItems } from './lib/planner.js';
import { mergeProfile } from './lib/extract.js';
import { createToolRunner, initVoiceAgent, recordHeard } from './lib/tools.js';
import { firstSessionUpdate } from './lib/states.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 40 * 1024 * 1024;
const KO_MAX_SESSION_SECONDS = Math.min(1800, Math.max(60, Number(process.env.KO_MAX_SESSION_SECONDS) || 300));
const VA_MAX_SESSION_SECONDS = Math.min(1800, Math.max(60, Number(process.env.VA_MAX_SESSION_SECONDS) || 240));

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

/**
 * Build the HTTP server with injectable dependencies (tests pass fakes).
 */
export function createApp({ assemblyai, mcp, llm, agent, gateway, tools, receiptPoll = { intervalMs: 5000, tries: 6 }, voiceAgentId = process.env.VOICE_AGENT_ID || null, vaConnect = process.env.VA_CONNECT || 'stored', demoMode = process.env.DEMO_MODE === '1', publicBaseUrl = process.env.PUBLIC_BASE_URL || '', staticDir = null, logger = console } = {}) {
  const aai = assemblyai || createAssemblyAI({ logger });
  const mcpClient = mcp || createMcpClient({ logger });
  const llmClient = llm === undefined ? createLlm({ logger }) : llm;
  const gw = gateway === undefined ? createGateway({ logger }) : gateway;
  const getCatalog = () => mcpClient.listProducts();
  const ag = agent || createAgent({ llm: llmClient, getCatalog, searchPlaces: (kw) => mcpClient.searchPlaces(kw), logger });
  const runner = tools || createToolRunner({ getCatalog, createCheckout: (x) => mcpClient.createCheckout(x), demoMode, logger });
  // a stored agent is bound by agent_id; VA_CONNECT=inline (or no VOICE_AGENT_ID) sends the whole s0 config instead
  const agentIdForCalls = vaConnect === 'inline' ? null : voiceAgentId;
  const originOf = (req) => publicBaseUrl || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost'}`;

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const m = req.method;

    if (m === 'GET' && url.pathname === '/api/health') {
      const [cat, mcpStatus] = await Promise.all([getCatalog(), mcpClient.status()]);
      return json(res, 200, {
        ok: true,
        assemblyai: { configured: aai.enabled, streaming: { en: 'stream', ko: 'stream' }, models: { en: 'universal-3-5-pro', ko: 'universal-3-6-pro' }, note: aai.enabled ? null : 'ASSEMBLYAI_API_KEY missing: voice is disabled, type-to-chat still works' },
        llm: llmClient ? { configured: true, model: llmClient.model, state: llmClient.state } : { configured: false, mode: 'rules', note: 'LLM_API_KEY missing: rule-based consultant' },
        summary: gw ? { via: 'llm-gateway', model: gw.model, enabled: !gw.state.disabled } : { via: 'template', enabled: false },
        mcp: { url: mcpClient.url, reachable: mcpStatus.ok, serverInfo: mcpStatus.serverInfo || null, catalogSource: cat.source, products: cat.products.length, capturedAt: cat.capturedAt || null, error: mcpStatus.ok ? null : mcpStatus.error },
      });
    }

    if (m === 'GET' && url.pathname === '/api/assemblyai/token') {
      if (!aai.enabled) return json(res, 503, { error: 'no_key', message: 'ASSEMBLYAI_API_KEY is not configured on the server' });
      try {
        // Korean streaming sessions are capped (a consultation takes about 4 minutes)
        const t = await aai.streamingToken({ expiresInSeconds: 60, maxSessionDurationSeconds: KO_MAX_SESSION_SECONDS });
        return json(res, 200, t);
      } catch (err) {
        logger.error?.(`[token] ${err.message}`);
        return json(res, err.status === 401 ? 401 : 502, { error: err.code || 'token_failed', message: err.message });
      }
    }

    if (m === 'GET' && url.pathname === '/api/voice-agent/token') {
      if (!aai.enabled) return json(res, 503, { error: 'no_key', message: 'ASSEMBLYAI_API_KEY is not configured on the server' });
      try {
        // one token opens one Voice Agent session; the session length cap is what one page can spend
        const t = await aai.agentToken({ expiresInSeconds: 60, maxSessionDurationSeconds: VA_MAX_SESSION_SECONDS });
        return json(res, 200, { ...t, agent_id: agentIdForCalls });
      } catch (err) {
        logger.error?.(`[va-token] ${err.message}`);
        return json(res, [401, 403, 429].includes(err.status) ? err.status : 502, { error: err.code || 'token_failed', message: err.message });
      }
    }

    if (m === 'GET' && url.pathname === '/api/products') {
      const cat = await getCatalog();
      return json(res, 200, { source: cat.source, capturedAt: cat.capturedAt || null, count: cat.products.length, products: cat.products.map((p) => ({ productId: p.productId, productName: p.productName, category: p.category, unitPrice: p.unitPrice, minOrderUnit: p.minOrderUnit, maxOrderUnit: p.maxOrderUnit, aiOrderable: p.aiOrderable })) });
    }

    if (m === 'GET' && url.pathname === '/api/places') {
      const keyword = url.searchParams.get('keyword') || '';
      if (!keyword.trim()) return json(res, 400, { error: 'keyword required' });
      return json(res, 200, await mcpClient.searchPlaces(keyword));
    }

    if (m === 'POST' && url.pathname === '/api/session') {
      const body = await readJson(req);
      const engine = ['realtime', 'voice-agent'].includes(body.engine) ? body.engine : 'text';
      const lang = engine === 'voice-agent' || body.lang === 'en' ? 'en' : 'ko'; // the Voice Agent API speaks English
      const s = ag.createSession({ lang, engine });
      if (engine === 'voice-agent') {
        const va = initVoiceAgent(s);
        // send session_update as the first {type:'session.update', session}; later ones come from /tool
        return json(res, 200, { sessionId: s.id, lang, engine, greeting: s.history[0].text, step: s.step, listen: s.listen, agentId: agentIdForCalls, connect: agentIdForCalls ? 'stored' : 'inline', state: va.state, session_update: firstSessionUpdate({ agentId: agentIdForCalls }) });
      }
      return json(res, 200, { sessionId: s.id, lang, engine, greeting: s.history[0].text, step: s.step, listen: s.listen });
    }

    if (parts[0] === 'api' && parts[1] === 'session' && parts[2]) {
      const session = ag.getSession(parts[2]);
      if (!session) return json(res, 404, { error: 'no_session' });
      const action = parts[3] || null;

      if (m === 'GET' && !action) {
        return json(res, 200, { id: session.id, lang: session.lang, engine: session.engine, stage: session.stage, step: session.step, profile: session.profile, plan: session.plan, history: session.history, brief: session.brief || null, checkout: session.checkout || null, ledger: session.ledger.snapshot(), aaiSessionId: session.aaiSessionId, va: session.va ? { state: session.va.state, calls: session.va.calls.length } : null });
      }

      if (m === 'GET' && action === 'ledger') {
        return json(res, 200, { rows: session.ledger.snapshot() });
      }

      if (m === 'GET' && action === 'receipt') {
        // Voice Agent calls: AssemblyAI's session record (Sessions API timeline; it exists only after the call ends,
        // so poll up to 6 x 5 s). Korean calls: the Universal-3.6 Pro final turns we received.
        if (session.receipt && !url.searchParams.has('refresh')) return json(res, 200, session.receipt);
        const rows = session.ledger.snapshot();
        let rec;
        if (session.aaiSessionId) {
          if (!aai.enabled) return json(res, 503, { error: 'no_key' });
          try {
            const { timeline, polls } = await aai.waitForTimeline(session.aaiSessionId, receiptPoll);
            if (!timeline) return json(res, 202, { pending: true, polls, message: 'The session record is not ready yet.' });
            rec = { ...reconcile(rows, timeline), polls };
          } catch (err) {
            logger.error?.(`[receipt] ${err.message}`);
            return json(res, err.status === 404 ? 404 : 502, { error: err.code || 'receipt_failed', message: err.message });
          }
        } else {
          rec = reconcileTurns(rows, session.grounding.heard);
        }
        // one summary per call (a refresh re-checks the record but does not call the model again)
        if (!session.summary) session.summary = gw ? await gw.summarizeCall(session) : templateCallSummary(session);
        session.receipt = { ...rec, summary: session.summary };
        return json(res, 200, session.receipt);
      }

      if (m === 'POST' && action === 'aai-session') {
        // the Voice Agent session id from session.ready, so the receipt can fetch AssemblyAI's record of the call
        const body = await readJson(req);
        const id = String(body.aai_session_id || '').trim();
        if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) return json(res, 400, { error: 'aai_session_id required' });
        session.aaiSessionId = id;
        return json(res, 200, { ok: true });
      }

      if (m === 'POST' && action === 'heard') {
        // a final owner transcript from the Voice Agent session (transcript.user); role 'agent' for transcript.agent
        if (session.engine !== 'voice-agent') return json(res, 400, { error: 'not_voice_agent_session' });
        const body = await readJson(req);
        const r = recordHeard(session, { item_id: body.item_id ? String(body.item_id).slice(0, 120) : null, text: body.text, at: body.at ?? null, via: body.via ? String(body.via).slice(0, 20) : 'voice-agent', role: body.role === 'agent' ? 'agent' : 'owner' });
        return json(res, r.ok ? 200 : 400, r);
      }

      if (m === 'POST' && action === 'tool') {
        // tool.call relayed at reply.done. Send session_update (if state_changed) first, then tool.result with
        // result (a JSON string) as is
        if (session.engine !== 'voice-agent') return json(res, 400, { error: 'not_voice_agent_session' });
        const body = await readJson(req);
        const name = String(body.name || '').trim();
        if (!name) return json(res, 400, { error: 'name required' });
        const r = await runner.run(session, { call_id: body.call_id ? String(body.call_id).slice(0, 120) : null, name, arguments: body.arguments || {}, last_item_id: body.last_item_id ? String(body.last_item_id).slice(0, 120) : null }, { origin: originOf(req) });
        return json(res, 200, r);
      }

      if (m === 'POST' && action === 'utterance') {
        const body = await readJson(req);
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { error: 'text required' });
        const r = await ag.handleUtterance(session.id, text, { meta: body.meta || {} });
        return json(res, 200, r);
      }

      if (m === 'POST' && action === 'voice-turn') {
        if (!aai.enabled) return json(res, 503, { error: 'no_key' });
        const audio = await readBody(req);
        if (audio.length < 1000) return json(res, 400, { error: 'audio too short' });
        const lang = url.searchParams.get('lang') || session.lang;
        try {
          const t = await aai.transcribe(audio, { languageCode: lang === 'ko' ? 'ko' : 'en', keyterms: ['네이버 플레이스', '인스타그램', '영수증 리뷰', '마켓파일럿'], pollIntervalMs: 700 });
          const text = String(t.text || '').trim();
          if (!text) return json(res, 200, { transcript: '', reply: null, empty: true });
          const r = await ag.handleUtterance(session.id, text, { meta: { via: 'turn', assemblyaiId: t.id, languageCode: t.language_code } });
          return json(res, 200, { transcript: text, ...r });
        } catch (err) {
          logger.error?.(`[voice-turn] ${err.message}`);
          return json(res, 502, { error: 'transcribe_failed', message: err.message });
        }
      }

      if (m === 'POST' && action === 'analyze') {
        if (!aai.enabled) return json(res, 503, { error: 'no_key' });
        const audio = await readBody(req);
        if (audio.length < 1000) return json(res, 400, { error: 'audio too short' });
        const lang = session.lang;
        try {
          const t = await aai.transcribe(audio, { languageCode: lang === 'ko' ? 'ko' : 'en', features: { speakerLabels: true, sentiment: true, highlights: true, entities: true }, pollIntervalMs: 1000, maxWaitMs: 240_000 });
          const agentTexts = session.history.filter((h) => h.role === 'agent').map((h) => h.text);
          const brief = buildBrief(t, { lang, agentTexts });
          session.brief = brief;
          // the brief can add problems the live extraction missed
          if (brief.problem_keys.length) {
            session.profile = mergeProfile(session.profile, { problems: brief.problem_keys });
            if (session.plan) {
              const cat = await getCatalog();
              session.plan = buildPlan(session.profile, cat.products, { catalogSource: cat.source });
            }
          }
          return json(res, 200, { brief, transcript: { id: t.id, text: t.text, utterances: t.utterances || [], features_downgraded: Boolean(t.features_downgraded) }, profile: session.profile, plan: session.plan });
        } catch (err) {
          logger.error?.(`[analyze] ${err.message}`);
          return json(res, 502, { error: 'analyze_failed', message: err.message });
        }
      }

      if (m === 'POST' && action === 'plan') {
        const plan = await ag.makePlan(session);
        return json(res, 200, { plan, profile: session.profile, stage: session.stage });
      }

      if (m === 'POST' && action === 'checkout') {
        const body = await readJson(req);
        const customerName = String(body.customerName || '').trim();
        if (!customerName) return json(res, 400, { error: 'customerName required' });
        if (!session.plan) return json(res, 400, { error: 'no_plan' });
        const items = checkoutItems(session.plan);
        if (!items.length) return json(res, 400, { error: 'no_items' });
        try {
          const r = await mcpClient.createCheckout({ items, customerName, customerPhone: body.customerPhone, companyName: session.profile.store_name || undefined, note: `Voice consultation ${session.id}: ${session.profile.location || ''} ${session.profile.business_label || ''}`.trim() });
          session.checkout = r;
          return json(res, 200, r);
        } catch (err) {
          logger.error?.(`[checkout] ${err.message}`);
          return json(res, 502, { error: 'checkout_failed', message: err.message, mock: session.plan.catalog_source === 'mock' });
        }
      }
    }

    return json(res, 404, { error: 'not_found' });
  }

  async function serveStatic(req, res, url) {
    if (!staticDir) return json(res, 404, { error: 'not_found' });
    let p = path.normalize(path.join(staticDir, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!p.startsWith(staticDir)) return json(res, 403, { error: 'forbidden' });
    try {
      const st = await stat(p);
      if (st.isDirectory()) p = path.join(p, 'index.html');
    } catch {
      p = path.join(staticDir, 'index.html'); // SPA fallback
    }
    try {
      const data = await readFile(p);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      json(res, 404, { error: 'not_found' });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return await serveStatic(req, res, url);
    } catch (err) {
      logger.error?.(`[server] ${req.method} ${url.pathname}: ${err.stack || err}`);
      if (!res.headersSent) json(res, err.status || 500, { error: 'internal', message: err.message });
    }
  });
  return { server, agent: ag, mcp: mcpClient, assemblyai: aai, llm: llmClient, tools: runner };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  loadEnv();
  const port = Number(process.env.PORT || 8787);
  const dist = path.resolve(here, '..', 'dist');
  const staticDir = process.env.NODE_ENV === 'production' ? dist : null;
  const app = createApp({ staticDir });
  app.server.listen(port, () => {
    console.log(`[server] http://localhost:${port}  assemblyai=${app.assemblyai.enabled ? 'on' : 'OFF (no key)'}  llm=${app.llm ? app.llm.model : 'rules-only'}  mcp=${app.mcp.url}`);
    if (staticDir) console.log(`[server] serving ${staticDir}`);
  });
}
