/**
 * In-game chat drawer — talks to the agent in `server/chatAgent.ts`, which has
 * this repository as its working directory and can therefore change, build and
 * commit the game you are looking at.
 *
 * Self-contained on purpose: it injects its own button, drawer and styles, and
 * touches nothing in main.ts. The button sits at top-right, clear of the
 * top-left HUD cluster and above the toast stack (which starts at top:70px).
 *
 * Reconnection matters here: the agent can restart this very server, so the
 * SSE stream is expected to drop. We reconnect from the last sequence number
 * we saw, and the transcript is server-side, so nothing is lost.
 */

const SID_KEY = 'gu-chat-sid';

function sessionId(): string {
  let sid = localStorage.getItem(SID_KEY);
  if (!sid) {
    sid = `s_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    localStorage.setItem(SID_KEY, sid);
  }
  return sid;
}

interface ChatEvent {
  seq: number;
  type: 'user' | 'text' | 'tool' | 'done' | 'error' | 'notice';
  text?: string;
  ts: number;
}

const STYLES = `
#guChatBtn {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 10px);
  right: calc(env(safe-area-inset-right, 0px) + 12px);
  z-index: 140;                     /* above toasts (121), below modal overlays */
  display: flex; align-items: center; gap: 7px;
  padding: 9px 13px;
  font: 600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: .3px;
  color: #f2e3b0;
  background: #5e6470;              /* same carved-stone grey as the HUD slabs */
  border: 1px solid #2a2e36;
  border-radius: 4px;
  box-shadow: inset 1px 1px 0 #7b828f, inset -1px -1px 0 #464b55, 0 3px 6px rgba(0,0,0,.45);
  cursor: pointer;
  transition: transform .08s ease, filter .12s ease;
}
#guChatBtn:hover { filter: brightness(1.12); }
#guChatBtn:active { transform: translateY(1px); }
#guChatBtn .dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #7fd18a; box-shadow: 0 0 5px #7fd18a;
}
#guChatBtn.busy .dot { background: #e7c24a; box-shadow: 0 0 5px #e7c24a; animation: guPulse 1s ease-in-out infinite; }
#guChatBtn.off .dot { background: #b05050; box-shadow: none; }
@keyframes guPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

#guChatPanel {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: min(420px, 92vw);
  z-index: 141;
  display: flex; flex-direction: column;
  background: #23262d;
  border-left: 1px solid #3a3f49;
  box-shadow: -6px 0 20px rgba(0,0,0,.5);
  transform: translateX(103%);
  transition: transform .22s ease;
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #dfe3ea;
}
#guChatPanel.open { transform: translateX(0); }
#guChatHead {
  display: flex; align-items: center; gap: 8px;
  padding: calc(env(safe-area-inset-top, 0px) + 11px) 12px 11px;
  background: #2b2f37; border-bottom: 1px solid #3a3f49;
}
#guChatHead .title { font-weight: 600; color: #f2e3b0; flex: 1; }
#guChatHead button {
  background: #3a3f49; color: #cfd5df; border: 1px solid #4a505b;
  border-radius: 3px; padding: 4px 9px; font-size: 12px; cursor: pointer;
}
#guChatHead button:hover { background: #464c58; }
#guChatLog { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 9px; }
.gu-msg { padding: 8px 10px; border-radius: 5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.gu-msg.user { background: #33506b; color: #eaf2fb; align-self: flex-end; max-width: 88%; }
.gu-msg.text { background: #2e333c; }
.gu-msg.tool {
  background: #262a31; color: #93a4b8; font: 11.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  border-left: 2px solid #4a5568; padding: 5px 8px;
}
.gu-msg.error { background: #4a2626; color: #f2c2c2; }
.gu-msg.notice { background: transparent; color: #8b93a0; font-style: italic; text-align: center; padding: 3px; }
#guChatForm { display: flex; gap: 7px; padding: 10px; border-top: 1px solid #3a3f49; background: #2b2f37; }
#guChatInput {
  flex: 1; resize: none; min-height: 38px; max-height: 130px;
  background: #1c1f25; color: #e6eaf0; border: 1px solid #444a55; border-radius: 4px;
  padding: 9px 10px; font: 13px/1.4 system-ui, sans-serif;
}
#guChatInput:focus { outline: none; border-color: #6b7788; }
#guChatSend {
  background: #5e6470; color: #f2e3b0; border: 1px solid #2a2e36; border-radius: 4px;
  padding: 0 15px; font-weight: 600; cursor: pointer;
}
#guChatSend:disabled { opacity: .45; cursor: default; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

export function mountChatPanel(): void {
  if (document.getElementById('guChatBtn')) return;
  const sid = sessionId();
  // Same convention as the game's WS URL in main.ts: BASE_URL ends in '/', and
  // nginx strips the mount prefix before the Express app sees the path.
  const api = (p: string) => `${import.meta.env.BASE_URL.replace(/\/$/, '')}${p}`;

  document.head.append(el('style', { textContent: STYLES }));

  const dot = el('span', { className: 'dot' });
  const btn = el('button', { id: 'guChatBtn', title: 'Chat with the agent that can change this game' }, [dot, 'Chat']);

  const log = el('div', { id: 'guChatLog' });
  const input = el('textarea', {
    id: 'guChatInput',
    placeholder: 'Ask for a change to this game…',
    rows: 1,
  });
  const send = el('button', { id: 'guChatSend', type: 'submit', textContent: 'Send' });
  const form = el('form', { id: 'guChatForm' }, [input, send]);
  const closeBtn = el('button', { type: 'button', textContent: 'Close' });
  const resetBtn = el('button', { type: 'button', textContent: 'New' });
  const head = el('div', { id: 'guChatHead' }, [
    el('span', { className: 'title', textContent: 'Game agent' }),
    resetBtn,
    closeBtn,
  ]);
  const panel = el('div', { id: 'guChatPanel' }, [head, log, form]);
  document.body.append(btn, panel);

  let lastSeq = 0;
  let running = false;
  let streamingNode: HTMLDivElement | null = null;

  const atBottom = () => log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
  const scroll = () => { log.scrollTop = log.scrollHeight; };

  function setRunning(v: boolean): void {
    running = v;
    btn.classList.toggle('busy', v);
    send.disabled = v;
    send.textContent = v ? '…' : 'Send';
  }

  function render(ev: ChatEvent): void {
    if (ev.seq <= lastSeq) return;
    lastSeq = ev.seq;
    const stick = atBottom();

    if (ev.type === 'done') { setRunning(false); streamingNode = null; return; }
    if (ev.type === 'user') { setRunning(true); streamingNode = null; }

    if (ev.type === 'text') {
      // Consecutive text deltas belong to one assistant bubble.
      if (streamingNode) {
        streamingNode.textContent += ev.text ?? '';
        if (stick) scroll();
        return;
      }
      streamingNode = el('div', { className: 'gu-msg text', textContent: ev.text ?? '' });
      log.append(streamingNode);
    } else {
      streamingNode = null;
      log.append(el('div', { className: `gu-msg ${ev.type}`, textContent: ev.text ?? '' }));
    }
    if (stick) scroll();
  }

  // ── SSE, with reconnect. The agent can restart this server, so a dropped
  // stream is a normal event, not an error: say so and pick up from lastSeq.
  let es: EventSource | null = null;
  let noticedDrop = false;
  function connect(): void {
    es?.close();
    es = new EventSource(api(`/api/chat/events?sid=${encodeURIComponent(sid)}&after=${lastSeq}`));
    es.onopen = () => {
      btn.classList.remove('off');
      if (noticedDrop) {
        noticedDrop = false;
        log.append(el('div', { className: 'gu-msg notice', textContent: 'Reconnected.' }));
        scroll();
      }
    };
    es.onmessage = (e) => { try { render(JSON.parse(e.data) as ChatEvent); } catch { /* keepalive */ } };
    es.onerror = () => {
      btn.classList.add('off');
      if (!noticedDrop) {
        noticedDrop = true;
        log.append(el('div', {
          className: 'gu-msg notice',
          textContent: 'Connection lost — the server may be restarting. Reconnecting…',
        }));
        scroll();
      }
      es?.close();
      setTimeout(connect, 2000);
    };
  }

  async function loadHistory(): Promise<void> {
    try {
      const r = await fetch(api(`/api/chat/history?sid=${encodeURIComponent(sid)}`));
      const data = await r.json() as { events: ChatEvent[]; running: boolean };
      for (const ev of data.events) render(ev);
      setRunning(data.running);
    } catch { /* the SSE replay will fill it in */ }
  }

  btn.addEventListener('click', () => {
    const opening = !panel.classList.contains('open');
    panel.classList.toggle('open', opening);
    if (opening) { input.focus(); scroll(); }
  });
  closeBtn.addEventListener('click', () => panel.classList.remove('open'));
  resetBtn.addEventListener('click', async () => {
    if (!confirm('Start a new conversation? The current one is discarded.')) return;
    await fetch(api('/api/chat/reset'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid }),
    });
    log.replaceChildren();
    lastSeq = 0;
    streamingNode = null;
    connect();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || running) return;
    input.value = '';
    setRunning(true);
    const res = await fetch(api('/api/chat/send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid, text }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setRunning(false);
      log.append(el('div', { className: 'gu-msg error', textContent: 'Could not reach the agent.' }));
      scroll();
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  void loadHistory().then(connect);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountChatPanel);
} else {
  mountChatPanel();
}
