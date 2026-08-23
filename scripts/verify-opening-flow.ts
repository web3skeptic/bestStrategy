// Integration test for the phase 11 opening flow: immediate secret
// simultaneous faction reveal (no Founding Round), zero starting units, and
// deferred (training-queue) recruitment. Spins up a real server instance
// (isolated temp DB, ephemeral port) and drives two real WebSocket clients
// through: match start -> zero units/faction=null for both -> pre-reveal
// action rejection -> secret choose-faction -> simultaneous reveal -> a
// recruit that does NOT appear on the battlefield immediately -> the unit
// deploying at the start of the recruiting player's next round.
//
// Run with: npx tsx scripts/verify-opening-flow.ts

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
  next: (type: string, timeoutMs?: number) => Promise<any>;
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

  // ── §3, §45 — no Founding Round: match starts at turnNumber 1 already
  // awaiting the (immediate) faction reveal, zero units for anyone. ──
  check('game starts at turnNumber 1', gsA.state.turnNumber === 1);
  check('both players start with faction=null', gsA.state.players.every((p: any) => p.faction === null));
  check('player A starts with ZERO units', gsA.state.units.filter((u: any) => u.playerId === gsA.playerSlot).length === 0);
  check('player B starts with ZERO units', gsB.state.units.filter((u: any) => u.playerId === gsB.playerSlot).length === 0);
  check('each player has exactly one Capital', gsA.state.capitals.length === 2);
  check('starting aura matches STARTING_ENERGY (3, economy/pacing balance pass)', gsA.state.players.every((p: any) => p.aura === 3), JSON.stringify(gsA.state.players.map((p: any) => p.aura)));

  const slotA = gsA.playerSlot as number;
  const slotB = gsB.playerSlot as number;
  const clientBySlot: Record<number, Client> = { [slotA]: A, [slotB]: B };

  // ── Pre-reveal restriction: recruit must be rejected, end-turn is a no-op ──
  const firstActingSlot = gsA.state.currentPlayerIndex;
  const firstActing = clientBySlot[firstActingSlot]!;
  const myCapital = gsA.state.capitals.find((c: any) => c.playerId === firstActingSlot);
  firstActing.send({ type: 'action', action: 'recruit', params: { unitType: 'warrior', templeId: myCapital.id } });
  const recruitErr = await firstActing.next('action_error');
  check('recruit is rejected before the faction reveal', !!recruitErr.message);

  firstActing.send({ type: 'action', action: 'end-turn', params: {} });
  const [noopA, noopB] = await Promise.all([A.next('state_update'), B.next('state_update')]);
  check('end-turn is a no-op before the reveal (turnNumber unchanged)', noopA.state.turnNumber === 1 && noopB.state.turnNumber === 1);

  // ── A chooses a faction. B must NOT see it yet. ──
  A.send({ type: 'action', action: 'choose-faction', params: { faction: 'agrar' } });
  const [suA, suB] = await Promise.all([A.next('state_update'), B.next('state_update')]);
  const aSelfFaction = suA.state.players.find((p: any) => p.id === slotA).faction;
  const aSeenByB = suB.state.players.find((p: any) => p.id === slotA).faction;
  const bSeenByA = suA.state.players.find((p: any) => p.id === slotB).faction;
  check('A sees their own locked-in faction immediately', aSelfFaction === 'agrar', `got ${aSelfFaction}`);
  check('B does NOT see A\'s unrevealed faction over the wire', aSeenByB === null, `got ${aSeenByB}`);
  check('A does NOT see B\'s (still unset) faction as anything but null', bSeenByA === null);

  // Duplicate submission of the SAME faction is a no-op success (idempotent).
  A.send({ type: 'action', action: 'choose-faction', params: { faction: 'agrar' } });
  const dupMsg = await A.nextEither(['state_update', 'action_error']);
  check('resubmitting the SAME faction is idempotent (not an error)', dupMsg.type === 'state_update', `got ${dupMsg.type}`);
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
  check('Round 1 begins right after reveal — still turnNumber 1', ruA.state.turnNumber === 1, `got ${ruA.state.turnNumber}`);
  check('still zero units for both players right after reveal', ruA.state.units.length === 0);

  // ── §5 — recruit queues, does NOT create a unit immediately ──
  const nowActingSlot = ruA.state.currentPlayerIndex;
  const nowActing = clientBySlot[nowActingSlot]!;
  const nowActingFaction = ruA.state.players.find((p: any) => p.id === nowActingSlot).faction;
  const actingCapital = ruA.state.capitals.find((c: any) => c.playerId === nowActingSlot);
  nowActing.send({ type: 'action', action: 'recruit', params: { unitType: 'founder', templeId: actingCapital.id } });
  const [postRecruitA, postRecruitB] = await Promise.all([A.next('state_update'), B.next('state_update')]);
  check('the recruited unit does NOT exist on the battlefield immediately', postRecruitA.state.units.filter((u: any) => u.playerId === nowActingSlot).length === 0);
  check('the recruiting player was charged the Builder/Acolyte cost (2⚡, from 3⚡ starting)', postRecruitA.state.players.find((p: any) => p.id === nowActingSlot).aura === 1, `got ${postRecruitA.state.players.find((p: any) => p.id === nowActingSlot).aura}`);

  // ── End this player's turn, then the opponent's — the order should deploy
  // at the start of the RECRUITING player's next round (their turn comes
  // back around after the opponent's). ──
  nowActing.send({ type: 'action', action: 'end-turn', params: {} });
  await Promise.all([A.next('state_update'), B.next('state_update')]);
  const otherActing = nowActing === A ? B : A;
  otherActing.send({ type: 'action', action: 'end-turn', params: {} });
  const [deployA, deployB] = await Promise.all([A.next('state_update'), B.next('state_update')]);
  const deployedUnit = deployA.state.units.find((u: any) => u.playerId === nowActingSlot);
  check('the Builder/Acolyte deploys at the start of the recruiting player\'s next round', !!deployedUnit, `units now: ${JSON.stringify(deployA.state.units.map((u: any) => ({ p: u.playerId, t: u.type })))}`);
  check('the deployed unit is the correct type (founder)', deployedUnit?.type === 'founder');
  check('both clients agree on the deployed unit', deployB.state.units.some((u: any) => u.id === deployedUnit?.id));
  check('the deployed unit can act immediately (hasMoved/hasAttacked false)', deployedUnit && !deployedUnit.hasMoved && !deployedUnit.hasAttacked);

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
