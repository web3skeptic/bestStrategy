// Integration test for the Founding Round + secret simultaneous faction
// reveal (phase 2 of the "Asymmetric Tribes v0.2" redesign). Spins up a real
// server instance (isolated temp DB, ephemeral port) and drives two real
// WebSocket clients through: founding round restrictions -> both end turn 1
// -> the reveal pause -> secret choose-faction -> simultaneous reveal ->
// post-reveal stat conversion. Asserts the server NEVER leaks an unrevealed
// faction pick to the opponent's client.
//
// Run with: npx tsx scripts/verify-founding-round.ts

import { randomBytes } from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';
import WebSocket from 'ws';

const tmpDb = path.join(os.tmpdir(), `gu-test-${randomBytes(6).toString('hex')}.db`);
process.env.DB_PATH = tmpDb;
process.env.PORT = '0';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

interface Client {
  send: (m: object) => void;
  // Strict FIFO per message type: only ever returns a message that arrived
  // AFTER this call (or was queued from earlier and not yet consumed) —
  // never re-matches an already-consumed message. Rejects after timeoutMs so
  // a protocol regression fails loudly instead of hanging the test forever.
  next: (type: string, timeoutMs?: number) => Promise<any>;
  // Wait for whichever of several message types arrives first. Registers a
  // SINGLE handler across all requested type queues and deregisters it from
  // every queue the instant it fires — unlike `Promise.race([next(a), next(b)])`,
  // which leaves the losing call's waiter permanently registered and can
  // resolve a LATER unrelated call to the same type with stale data.
  nextEither: (types: string[], timeoutMs?: number) => Promise<any>;
  close: () => void;
}

function connect(url: string): Client {
  const ws = new WebSocket(url);
  const queues = new Map<string, any[]>();
  const waiters = new Map<string, ((m: any) => void)[]>();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const ws_ = waiters.get(msg.type);
    if (ws_ && ws_.length) { ws_.shift()!(msg); return; }
    if (!queues.has(msg.type)) queues.set(msg.type, []);
    queues.get(msg.type)!.push(msg);
  });
  const nextEither = (types: string[], timeoutMs = 5000): Promise<any> => new Promise((resolve, reject) => {
    for (const t of types) {
      const q = queues.get(t);
      if (q && q.length) { resolve(q.shift()); return; }
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout (${timeoutMs}ms) waiting for any of [${types.join(', ')}]`)); }, timeoutMs);
    const handler = (m: any) => { clearTimeout(timer); cleanup(); resolve(m); };
    const cleanup = () => {
      for (const t of types) {
        const arr = waiters.get(t);
        if (!arr) continue;
        const i = arr.indexOf(handler);
        if (i !== -1) arr.splice(i, 1);
      }
    };
    for (const t of types) {
      if (!waiters.has(t)) waiters.set(t, []);
      waiters.get(t)!.push(handler);
    }
  });
  const next = (type: string, timeoutMs = 5000): Promise<any> => nextEither([type], timeoutMs);
  const send = (m: object) => ws.send(JSON.stringify(m));
  const open = new Promise<void>((resolve) => ws.once('open', () => resolve()));
  (send as any).__open = open;
  return { send, next, nextEither, close: () => ws.close() };
}

async function main(): Promise<void> {
  // Import server.ts AFTER setting env vars — it starts listening as an
  // import side-effect on an isolated temp DB + OS-assigned port.
  const http = await import('http');
  const originalListen = http.Server.prototype.listen;
  let boundPort: number | null = null;
  (http.Server.prototype as any).listen = function (this: any, ...args: any[]) {
    const result = originalListen.apply(this, args as any);
    this.once('listening', () => { boundPort = (this.address() as any).port; });
    return result;
  };
  await import('../server/server.ts');
  http.Server.prototype.listen = originalListen;

  for (let i = 0; i < 100 && boundPort === null; i++) await new Promise(r => setTimeout(r, 20));
  if (boundPort === null) throw new Error('server did not start listening');
  const url = `ws://127.0.0.1:${boundPort}`;
  console.log(`\n(test server listening on ${url}, db=${tmpDb})\n`);

  const A = connect(url);
  const B = connect(url);
  const wsA = (A.send as any).__open as Promise<void>;
  const wsB = (B.send as any).__open as Promise<void>;
  await Promise.all([wsA, wsB]);

  A.send({ type: 'login', username: `A_${randomBytes(3).toString('hex')}` });
  B.send({ type: 'login', username: `B_${randomBytes(3).toString('hex')}` });
  await Promise.all([A.next('logged_in'), B.next('logged_in')]);

  A.send({ type: 'create_room', expectedPlayers: 6 }); // deliberately request >2 — server must clamp to 2
  const created = await A.next('room_created');
  check('server clamps room size to 2 regardless of requested expectedPlayers', created.expectedPlayers === 2, `got ${created.expectedPlayers}`);

  B.send({ type: 'join_room', roomId: created.roomId });
  const gsA = await A.next('game_start');
  const gsB = await B.next('game_start');

  check('game starts at turnNumber 1 (Founding Round)', gsA.state.turnNumber === 1);
  check('both players start with faction=null', gsA.state.players.every((p: any) => p.faction === null));
  const startUnitsA = gsA.state.units.filter((u: any) => u.playerId === gsA.playerSlot);
  check('each player starts with exactly 3 units (Warrior+Archer+Founder)', startUnitsA.length === 3, `got ${startUnitsA.length}`);
  check('starting loadout is warrior+archer+founder', ['warrior', 'archer', 'founder'].every(t => startUnitsA.some((u: any) => u.type === t)));

  const slotA = gsA.playerSlot as number;
  const slotB = gsB.playerSlot as number;
  const clientBySlot: Record<number, Client> = { [slotA]: A, [slotB]: B };

  // ── Founding Round restriction: recruit must be rejected ──
  const firstActingSlot = gsA.state.currentPlayerIndex;
  const firstActing = clientBySlot[firstActingSlot]!;
  const myCapital = gsA.state.capitals.find((c: any) => c.playerId === firstActingSlot);
  firstActing.send({ type: 'action', action: 'recruit', params: { unitType: 'warrior', templeId: myCapital.id } });
  const recruitErr = await firstActing.next('action_error');
  check('recruit is rejected during the Founding Round', !!recruitErr.message);

  // ── End turn 1 for both players ──
  firstActing.send({ type: 'action', action: 'end-turn', params: {} });
  await Promise.all([A.next('state_update'), B.next('state_update')]);
  const secondActing = firstActing === A ? B : A;
  secondActing.send({ type: 'action', action: 'end-turn', params: {} });
  const [su1A, su1B] = await Promise.all([A.next('state_update'), B.next('state_update')]);

  check('turnNumber becomes 2 once both end turn 1', su1A.state.turnNumber === 2, `got ${su1A.state.turnNumber}`);
  check('both clients agree on turnNumber', su1A.state.turnNumber === su1B.state.turnNumber);

  // ── Awaiting-reveal pause: move must be rejected for everyone ──
  const someUnit = su1A.state.units.find((u: any) => u.playerId === slotA);
  A.send({ type: 'action', action: 'move', params: { unitId: someUnit.id, to: { q: someUnit.pos.q + 1, r: someUnit.pos.r } } });
  const moveErr = await A.next('action_error');
  check('move is rejected during the faction-reveal pause', !!moveErr.message);

  // ── A chooses a faction. B must NOT see it yet. ──
  A.send({ type: 'action', action: 'choose-faction', params: { faction: 'agrar' } });
  const [suA, suB] = await Promise.all([A.next('state_update'), B.next('state_update')]);
  const aSelfFaction = suA.state.players.find((p: any) => p.id === slotA).faction;
  const aSeenByB = suB.state.players.find((p: any) => p.id === slotA).faction;
  const bSeenByA = suA.state.players.find((p: any) => p.id === slotB).faction;
  check('A sees their own locked-in faction immediately', aSelfFaction === 'agrar', `got ${aSelfFaction}`);
  check('B does NOT see A\'s unrevealed faction over the wire', aSeenByB === null, `got ${aSeenByB}`);
  check('A does NOT see B\'s (still unset) faction as anything but null', bSeenByA === null);

  // Duplicate submission of the SAME faction is a no-op success (idempotent) —
  // still produces a state_update broadcast (not an error).
  A.send({ type: 'action', action: 'choose-faction', params: { faction: 'agrar' } });
  const dupMsg = await A.nextEither(['state_update', 'action_error']);
  check('resubmitting the SAME faction is idempotent (not an error)', dupMsg.type === 'state_update', `got ${dupMsg.type}`);
  // The idempotent resubmit is still a successful action -> broadcastToBoth,
  // so B also receives (and must drain) a copy before the next real step.
  if (dupMsg.type === 'state_update') await B.next('state_update');

  // A different faction after already locking is rejected.
  A.send({ type: 'action', action: 'choose-faction', params: { faction: 'temple' } });
  const changeErr = await A.next('action_error');
  check('changing to a DIFFERENT faction after locking is rejected', !!changeErr.message);

  // ── B chooses — reveal must happen simultaneously for both ──
  B.send({ type: 'action', action: 'choose-faction', params: { faction: 'temple' } });
  const [ruA, ruB] = await Promise.all([A.next('state_update'), B.next('state_update')]);
  const aFactionFinalA = ruA.state.players.find((p: any) => p.id === slotA).faction;
  const aFactionFinalB = ruB.state.players.find((p: any) => p.id === slotA).faction;
  const bFactionFinalA = ruA.state.players.find((p: any) => p.id === slotB).faction;
  check('after both choose, A\'s client sees A=agrar', aFactionFinalA === 'agrar');
  check('after both choose, B\'s client ALSO sees A=agrar (revealed)', aFactionFinalB === 'agrar');
  check('after both choose, A\'s client sees B=temple (revealed)', bFactionFinalA === 'temple');

  // ── Conversion: warrior/archer stats now match the faction tables ──
  const agrarWarrior = ruA.state.units.find((u: any) => u.playerId === slotA && u.type === 'warrior');
  const templeWarrior = ruA.state.units.find((u: any) => u.playerId === slotB && u.type === 'warrior');
  check('Agrar warrior converted to Agrar stats (atk=9, spd=1)', agrarWarrior.stats.attack === 9 && agrarWarrior.stats.speed === 1, JSON.stringify(agrarWarrior.stats));
  check('Temple warrior converted to Temple stats (atk=10, spd=2)', templeWarrior.stats.attack === 10 && templeWarrior.stats.speed === 2, JSON.stringify(templeWarrior.stats));

  // ── Match resumes: end-turn / move now legal again ──
  const nowActingSlot = ruA.state.currentPlayerIndex;
  const nowActing = clientBySlot[nowActingSlot]!;
  nowActing.send({ type: 'action', action: 'end-turn', params: {} });
  const resumed = await Promise.race([
    Promise.all([A.next('state_update'), B.next('state_update')]).then(() => 'ok'),
    new Promise(r => setTimeout(() => r('timeout'), 3000)),
  ]);
  check('play resumes normally after reveal (end-turn succeeds)', resumed === 'ok');

  A.close(); B.close();
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(() => {
  try { fs.unlinkSync(tmpDb); } catch { /* best effort */ }
  try { fs.unlinkSync(`${tmpDb}-wal`); } catch { /* best effort */ }
  try { fs.unlinkSync(`${tmpDb}-shm`); } catch { /* best effort */ }
});
