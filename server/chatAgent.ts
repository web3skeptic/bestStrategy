/**
 * In-game chat agent — lets a player talk to a Claude Code session whose `cwd`
 * IS this repository, so it can change the game, rebuild it, and commit.
 *
 * Deliberate constraints:
 *  • No `Agent` tool and no agentSpawner MCP server → this agent cannot spawn
 *    sub-agents. It is one conversation, one process.
 *  • Auth comes from the OAuth credentials file at $HOME/.claude/.credentials.json
 *    (the systemd unit sets HOME=/root), exactly like /opt/myai. There is no
 *    ANTHROPIC_API_KEY anywhere in this deploy.
 *  • Restarting our own service would kill the request mid-flight, so the agent
 *    is told to use scripts/restart-service.sh, which schedules the restart on a
 *    detached transient systemd timer.
 *
 * Transport: POST /api/chat/send starts a turn in the background and returns at
 * once; GET /api/chat/events streams the turn over SSE. Every event is also
 * appended to an on-disk transcript, so a client that reconnects after the
 * server restarts can replay from a cursor instead of losing the conversation.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const STORE_PATH = path.join(DATA_DIR, 'chat-sessions.json');

export interface ChatEvent {
  seq: number;
  type: 'user' | 'text' | 'tool' | 'done' | 'error' | 'notice';
  text?: string;
  ts: number;
}

interface ChatSession {
  sid: string;
  /** Claude session id to resume, so the conversation is continuous. */
  sessionToken: string | null;
  events: ChatEvent[];
  running: boolean;
}

type Store = Record<string, { sessionToken: string | null; events: ChatEvent[] }>;

const sessions = new Map<string, ChatSession>();
/** Open SSE responses, per session id. */
const listeners = new Map<string, Set<express.Response>>();

// ── Persistence ───────────────────────────────────────────────────────────
// Transcripts survive a restart (which the agent can trigger on itself), so
// they are flushed after every event rather than at process exit.

function loadStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Store;
  } catch {
    return {};
  }
}

let flushTimer: NodeJS.Timeout | null = null;
function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const out: Store = {};
    for (const [sid, s] of sessions) {
      // Cap the on-disk transcript; the tail is what a reconnecting client needs.
      out[sid] = { sessionToken: s.sessionToken, events: s.events.slice(-400) };
    }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STORE_PATH, JSON.stringify(out));
    } catch (err) {
      console.error('[chat] failed to persist sessions:', err);
    }
  }, 250);
}

function getSession(sid: string): ChatSession {
  let s = sessions.get(sid);
  if (s) return s;
  const persisted = loadStore()[sid];
  s = {
    sid,
    sessionToken: persisted?.sessionToken ?? null,
    events: persisted?.events ?? [],
    running: false,
  };
  sessions.set(sid, s);
  return s;
}

function emit(s: ChatSession, type: ChatEvent['type'], text?: string): void {
  const ev: ChatEvent = { seq: (s.events.at(-1)?.seq ?? 0) + 1, type, text, ts: Date.now() };
  s.events.push(ev);
  if (s.events.length > 800) s.events.splice(0, s.events.length - 800);
  scheduleFlush();
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of listeners.get(s.sid) ?? []) {
    try { res.write(payload); } catch { /* client gone; SSE close handler cleans up */ }
  }
}

// ── System prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the in-game engineering assistant for **Tactical Tribes** (repo/service name game-upgradable), a hex strategy game.

Your working directory IS the live deployment: ${REPO_ROOT}. It is a git repository and you may commit to it.

## The stack
- Frontend: TypeScript + Vite (\`src/\`, entry \`index.html\` → \`src/main.ts\`). Three.js renderer.
- Backend: Express + WebSocket (\`server/\`), run with tsx. SQLite at \`data/game.db\`.
- Served at https://interslavic.space/game-upgradable/ behind nginx, which STRIPS the
  \`/game-upgradable/\` prefix before proxying to the local port.
- The chat panel you are talking through is \`src/chatPanel.ts\` + \`server/chatAgent.ts\`.

## Build
Run \`npm run build\`. It is already wired to \`VITE_BASE=/game-upgradable/\`; do NOT run a bare
\`vite build\` or override VITE_BASE, or every asset 404s and the page goes blank.
Frontend changes are only visible after a build. Server changes need a restart.

## Restarting
NEVER run \`systemctl restart game-upgradable.service\` directly — you are running INSIDE that
service and would kill your own request mid-answer. Run \`scripts/restart-service.sh\` instead;
it schedules the restart on a detached timer a few seconds later. Tell the user the server is
restarting, and finish your message before it lands.

## Commits
Commit your changes when you finish a piece of work. The repo's local git config already sets
the author to Max <web3skeptic@tuta.com> — use it as-is.
Commit messages must NEVER mention Claude, Anthropic, an AI, an assistant, or that they were
generated. No \`Co-Authored-By\` trailer, no "Generated with" line. Write them as an ordinary
human changelog entry, e.g. "Chat: widen the drawer on mobile".

## Style
- You cannot spawn sub-agents. Do the work yourself.
- Keep replies short — they render in a narrow drawer. Say what you changed, not how you felt.
- Verify before claiming: if you built, say the build passed; if it failed, paste the error.
- Be careful: this is a live site. Don't delete game features you weren't asked to touch, and
  don't touch /opt/best-strategy (a separate, unrelated deployment).`;

// ── Model & effort selection ──────────────────────────────────────────────
// Chosen per-turn from the chat panel's settings gear; anything not in these
// whitelists falls back to the defaults.

const MODEL_IDS: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
  fable: 'claude-fable-5-1',
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_EFFORT: Effort = 'medium';

// ── Turn execution ────────────────────────────────────────────────────────

function toolSummary(name: string, input: Record<string, unknown>): string {
  const rel = (p: unknown) => String(p ?? '').replace(REPO_ROOT + '/', '');
  switch (name) {
    case 'Bash': return `$ ${String(input.command ?? '').split('\n')[0].slice(0, 160)}`;
    case 'Read': return `read ${rel(input.file_path)}`;
    case 'Edit': return `edit ${rel(input.file_path)}`;
    case 'Write': return `write ${rel(input.file_path)}`;
    case 'Glob': return `glob ${String(input.pattern ?? '')}`;
    case 'Grep': return `grep ${String(input.pattern ?? '')}`;
    default: return name;
  }
}

async function runTurn(s: ChatSession, text: string, model: string, effort: Effort): Promise<void> {
  s.running = true;
  emit(s, 'user', text);
  try {
    const options: Parameters<typeof query>[0]['options'] = {
      model: MODEL_IDS[model],
      effort,
      cwd: REPO_ROOT,
      // No 'Agent' tool: this session must not be able to spawn sub-agents.
      tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
      // No MCP servers at all — in particular no agentSpawner.
      mcpServers: {},
      settingSources: [],
      permissionMode: 'bypassPermissions',
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_PROMPT },
      env: { ...process.env },
    };
    if (process.env.CLAUDE_CODE_PATH) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
    }
    // Fable's safety classifiers can refuse; run those turns on opus instead
    // of erroring (also covers accounts without Fable access).
    if (model === 'fable') options.fallbackModel = 'claude-opus-5';
    if (s.sessionToken) options.resume = s.sessionToken;

    let buffer = '';
    const flushText = () => {
      if (buffer) { emit(s, 'text', buffer); buffer = ''; }
    };

    for await (const message of query({ prompt: text, options })) {
      if (message.type === 'system' && (message as any).subtype === 'init') {
        s.sessionToken = (message as any).session_id ?? s.sessionToken;
        scheduleFlush();
      } else if (message.type === 'stream_event') {
        const ev = (message as any).event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          buffer += ev.delta.text;
          // Flush on sentence-ish boundaries so the drawer updates as it goes.
          if (buffer.length > 60 || /[.!?\n]\s*$/.test(buffer)) flushText();
        }
      } else if (message.type === 'assistant') {
        for (const block of (message as any).message.content ?? []) {
          if (block.type === 'tool_use') {
            flushText();
            emit(s, 'tool', toolSummary(block.name, block.input ?? {}));
          }
        }
      } else if (message.type === 'result') {
        flushText();
        const r = message as any;
        if (r.session_id) s.sessionToken = r.session_id;
        if (r.subtype !== 'success' && r.is_error) {
          emit(s, 'error', String(r.result ?? r.subtype ?? 'turn failed'));
        } else if (r.result && !s.events.some((e) => e.type === 'text' && e.text === r.result)) {
          // Fall back to the final result text if no deltas arrived.
          if (!s.events.slice(-6).some((e) => e.type === 'text')) emit(s, 'text', String(r.result));
        }
      }
    }
    flushText();
  } catch (err) {
    emit(s, 'error', err instanceof Error ? err.message : String(err));
  } finally {
    s.running = false;
    emit(s, 'done');
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

export const chatRouter = express.Router();

// This agent can edit and commit to the live deployment, so it's gated behind
// a shared passphrase (checked as ?pass= on GET, body.pass on POST) rather
// than being open to anyone who finds the URL.
const CHAT_PASSWORD: string = process.env.CHAT_PASSWORD || (() => { throw new Error('CHAT_PASSWORD environment variable is required'); })();
chatRouter.use((req, res, next) => {
  const pass = req.method === 'GET' ? req.query.pass : req.body?.pass;
  if (pass !== CHAT_PASSWORD) { res.status(401).json({ error: 'wrong passphrase' }); return; }
  next();
});

chatRouter.get('/history', (req, res) => {
  const sid = String(req.query.sid ?? '');
  if (!sid) { res.status(400).json({ error: 'sid required' }); return; }
  const s = getSession(sid);
  res.json({ events: s.events, running: s.running });
});

chatRouter.get('/events', (req, res) => {
  const sid = String(req.query.sid ?? '');
  if (!sid) { res.status(400).end(); return; }
  const s = getSession(sid);
  const after = Number(req.query.after ?? 0);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`retry: 2000\n\n`);

  for (const ev of s.events) {
    if (ev.seq > after) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  let set = listeners.get(sid);
  if (!set) { set = new Set(); listeners.set(sid, set); }
  set.add(res);

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20000);
  req.on('close', () => {
    clearInterval(ping);
    set!.delete(res);
    if (!set!.size) listeners.delete(sid);
  });
});

chatRouter.post('/send', (req, res) => {
  const sid = String(req.body?.sid ?? '');
  const text = String(req.body?.text ?? '').trim();
  if (!sid || !text) { res.status(400).json({ error: 'sid and text required' }); return; }
  const s = getSession(sid);
  if (s.running) { res.status(409).json({ error: 'a turn is already running' }); return; }
  const model = MODEL_IDS[String(req.body?.model ?? '')] ? String(req.body.model) : DEFAULT_MODEL;
  const effort = (EFFORTS as readonly string[]).includes(String(req.body?.effort ?? ''))
    ? (String(req.body.effort) as Effort)
    : DEFAULT_EFFORT;
  // Fire and forget: the SSE stream carries the output.
  void runTurn(s, text, model, effort);
  res.json({ ok: true });
});

chatRouter.post('/reset', (req, res) => {
  const sid = String(req.body?.sid ?? '');
  if (!sid) { res.status(400).json({ error: 'sid required' }); return; }
  const s = getSession(sid);
  s.sessionToken = null;
  s.events = [];
  scheduleFlush();
  emit(s, 'notice', 'New conversation started.');
  res.json({ ok: true });
});
