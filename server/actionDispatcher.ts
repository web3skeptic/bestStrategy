// Shared action dispatcher used by both the WebSocket transport (gameManager.ts)
// and the REST headless transport (headlessApi.ts).
//
// The dispatcher takes a GameState, the acting player's slot, an action name
// from the unified vocabulary, and a flat params object. It validates the
// action, mutates the state, and returns a structured result. It is the single
// place that enforces game rules at the transport boundary — transports become
// thin adapters.
//
// Note on selection-side-effect: several core mutators in src/game.ts read
// `state.selectedUnitId` (e.g. moveUnit, attackUnit). The dispatcher always
// fully owns selection lifecycle — it selects the right unit before mutating
// and deselects after — so callers never need to send a separate select
// message. The UI-only "select" WS messages still exist for the legacy FE
// (they just toggle highlight state) but are not part of this dispatcher's
// contract.

import { GameState, Unit, UnitType, TechId, HexCoord } from '../src/types';
import {
  selectUnit, deselectAll,
  moveUnit, attackUnit,
  canStartFounding, startFounding,
  attackStructure, getStructureAt,
  canDestroyUnit, destroyUnit,
  spawnUnit, endTurn,
  researchTech,
  buildTeleportPair,
  resignGame,
  getEffectiveRange, getEffectiveSpeed, getZocHexes,
  getPlayerVisible, isForestUnitRevealed,
  UNIT_STATS, HEALER_HEAL_AMOUNT, DAMAGE_BOOST_AMOUNT, RANGE_BOOST_AMOUNT,
  UNIT_CLASS,
  chooseFaction, isAwaitingFactionReveal,
  getOwnedStructures,
  startFarm, canStartFarm, getValidFarmHexes, startTempleUpgrade,
  canBuildRoad, buildRoad, getValidRoadHexes,
} from '../src/game';
import {
  TECH_NODES, UNIT_COSTS,
  mapRadiusForPlayers, neutralSiteCountForPlayers,
  HILL_DEFENSE_BONUS, HILL_VISION_BONUS, HILL_RANGE_BONUS,
  SUPPORT_RANGE,
} from '../src/types';
import {
  SITE_ESTABLISH_COST, STRUCTURES, FACTION_UNITS, STARTING_ENERGY,
  AGRAR_FARM_COST, AGRAR_FARM_INCOME, MAX_ACTIVE_FARMS, AGRAR_TERRITORY_RADIUS, CULTIVATION_RADIUS, FARM_MIN_SPACING,
  TEMPLE_UPGRADE_COST, TEMPLE_LEVEL_INCOME, TEMPLE_II_PRODUCTION_BONUS,
  COMMAND_TIERS, PRODUCTION_BASE_SLOTS, PRODUCTION_MAX_SLOTS, UNIT_TRAINING_ROUNDS,
  ROAD_COST_PER_HEX, ROAD_MOVEMENT_BONUS, ROAD_PILLAGE_REBUILD_COST,
} from '../src/factions';
import { hexKey, getReachableHexes, hexDistance } from '../src/hex';

// ── Unified action vocabulary ──

export type UnifiedActionName =
  | 'move'
  | 'attack'
  | 'attack-structure'
  | 'recruit'
  | 'found'
  | 'destroy'
  | 'research'
  | 'build-teleport'
  | 'build-farm'
  | 'upgrade-temple'
  | 'build-road'
  | 'end-turn'
  | 'resign'
  | 'choose-faction';

export interface UnifiedAction {
  action: UnifiedActionName;
  params: Record<string, unknown>;
}

// ── Per-unit legal action descriptor ──

export type LegalAction =
  | { type: 'move'; to: HexCoord }
  | { type: 'attack'; targetId: string }
  | { type: 'attack-structure'; targetPos: HexCoord }
  | { type: 'found'; siteId: string; targetState: 'temple' }
  | { type: 'build-road'; targetPos: HexCoord }
  | { type: 'build-farm'; targetPos: HexCoord };

export type LegalMovesPerPlayer = Record<string /* unitId */, LegalAction[]>;

// ── Result shape returned by executeAction ──

export interface ExecuteSuccess {
  ok: true;
  action: UnifiedActionName;
  log: string[];
  // Whether this action mutated game-visible state (vs UI-only). All current
  // unified actions are state-mutating, but we keep the flag for future
  // selection-only actions.
  broadcastToBoth: boolean;
}

export interface ExecuteFailure {
  ok: false;
  action: UnifiedActionName | string;
  error: string;
  legalMoves: LegalMovesPerPlayer;
}

export type ExecuteResult = ExecuteSuccess | ExecuteFailure;

// ── Legal-moves helpers ──

export function computeUnitActions(state: GameState, unit: Unit): LegalAction[] {
  const actions: LegalAction[] = [];

  // During the post-Round-1 faction-reveal pause, nothing is legal except
  // choose-faction/resign (neither of which is a per-unit action).
  if (isAwaitingFactionReveal(state)) return actions;

  // Move actions — only available when the unit has not yet moved or attacked.
  if (!unit.hasMoved && !unit.hasAttacked) {
    const occupied = state.units.filter(u => u.hp > 0 && u.id !== unit.id).map(u => u.pos);
    const wallPositions: HexCoord[] = [...state.walls].map(k => {
      const [q, r] = k.split(',').map(Number);
      return { q: q!, r: r! };
    });
    const reachable = getReachableHexes(
      unit.pos,
      getEffectiveSpeed(state, unit),
      state.mapRadius,
      [...occupied, ...wallPositions],
      state.hills,
      getZocHexes(state, unit.playerId),
    );
    for (const h of reachable) actions.push({ type: 'move', to: h });
  }

  // Attack actions — available unless already attacked, or cantShootAfterMove+hasMoved.
  const canAttack = !unit.hasAttacked && !(unit.stats.cantShootAfterMove && unit.hasMoved);
  if (canAttack) {
    const effectiveRange = getEffectiveRange(state, unit);
    const visible = getPlayerVisible(state, unit.playerId);
    const targets = state.units
      .filter(e => e.hp > 0 && e.playerId !== unit.playerId)
      .filter(e => hexDistance(unit.pos, e.pos) <= effectiveRange)
      .filter(e => visible.has(hexKey(e.pos)))
      .filter(e => isForestUnitRevealed(state, e.pos, unit.playerId));
    for (const e of targets) actions.push({ type: 'attack', targetId: e.id });

    for (const capital of state.capitals) {
      if (capital.playerId !== unit.playerId && hexDistance(unit.pos, capital.pos) <= effectiveRange) {
        actions.push({ type: 'attack-structure', targetPos: capital.pos });
      }
    }
    // v12 — only Agrar may attack a Temple; Temple-faction players conquer
    // rival Temples by presence instead (the "found" action), never combat.
    const canAttackTemples = state.players.find(p => p.id === unit.playerId)?.faction === 'agrar';
    if (canAttackTemples) {
      for (const site of state.strategicSites) {
        if ((site.state === 'temple' || site.state === 'upgradingTemple') && site.ownerId !== unit.playerId
          && hexDistance(unit.pos, site.pos) <= effectiveRange) {
          actions.push({ type: 'attack-structure', targetPos: site.pos });
        }
      }
    }
    for (const farm of state.farms) {
      if (farm.state === 'farm' && farm.ownerId !== unit.playerId
        && hexDistance(unit.pos, farm.pos) <= effectiveRange) {
        actions.push({ type: 'attack-structure', targetPos: farm.pos });
      }
    }
  }

  // Founding action (§7, Temple-only).
  const foundingCheck = canStartFounding(state, unit);
  if (foundingCheck) actions.push({ type: 'found', siteId: foundingCheck.site.id, targetState: foundingCheck.targetState });

  // Build Road / Build Farm actions (§23-25 / §6-9, Agrar-only) — every
  // legal target hex, same pattern for both (the client/UI presents the
  // full set via getValidRoadHexes/getValidFarmHexes for actual placement).
  if (unit.type === 'founder') {
    const player = state.players.find(p => p.id === unit.playerId);
    if (player?.faction === 'agrar') {
      for (const hex of getValidRoadHexes(state, unit)) {
        if (canBuildRoad(state, unit, hex)) actions.push({ type: 'build-road', targetPos: hex });
      }
      for (const hex of getValidFarmHexes(state, unit)) {
        if (canStartFarm(state, unit, hex)) actions.push({ type: 'build-farm', targetPos: hex });
      }
    }
  }

  // NOTE: 'destroy' (disband) is deliberately NOT enumerated here — the AI / RL
  // move generation must never consider disbanding its own units.

  return actions;
}

export function computePlayerLegalMoves(state: GameState, playerId: number): LegalMovesPerPlayer {
  const legal: LegalMovesPerPlayer = {};
  for (const unit of state.units.filter(u => u.hp > 0 && u.playerId === playerId)) {
    legal[unit.id] = computeUnitActions(state, unit);
  }
  return legal;
}

// ── Hex utilities (re-exported convenience) ──

export function computeUnitMoveHexes(state: GameState, unit: Unit): HexCoord[] {
  if (unit.hasMoved || unit.hasAttacked) return [];
  const occupied = state.units.filter(u => u.hp > 0 && u.id !== unit.id).map(u => u.pos);
  const wallPositions: HexCoord[] = [...state.walls].map(k => {
    const [q, r] = k.split(',').map(Number);
    return { q: q!, r: r! };
  });
  return getReachableHexes(unit.pos, getEffectiveSpeed(state, unit), state.mapRadius, [...occupied, ...wallPositions], state.hills, getZocHexes(state, unit.playerId));
}

export function computeUnitAttackTargets(state: GameState, unit: Unit): Unit[] {
  const canAttack = !unit.hasAttacked && !(unit.stats.cantShootAfterMove && unit.hasMoved);
  if (!canAttack) return [];
  const effectiveRange = getEffectiveRange(state, unit);
  const visible = getPlayerVisible(state, unit.playerId);
  return state.units
    .filter(e => e.hp > 0 && e.playerId !== unit.playerId)
    .filter(e => hexDistance(unit.pos, e.pos) <= effectiveRange)
    .filter(e => visible.has(hexKey(e.pos)))
    .filter(e => isForestUnitRevealed(state, e.pos, unit.playerId));
}

// ── Rules payload (used by REST /rules and WS request_rules) ──

export function buildRulesPayload(): Record<string, unknown> {
  const unitTypes: Record<string, unknown> = {};
  for (const [type, stats] of Object.entries(UNIT_STATS)) {
    const techUnlock = TECH_NODES.find(n => n.unitUnlock === type);
    unitTypes[type] = {
      cost: UNIT_COSTS[type as UnitType],
      hp: stats.maxHp,
      atk: stats.attack,
      def: stats.defense,
      spd: stats.speed,
      rng: stats.range,
      vision: stats.vision,
      splash: stats.splash,
      splashFactor: stats.splashFactor,
      canBeRevenged: stats.canBeRevenged,
      cantShootAfterMove: stats.cantShootAfterMove,
      unitClass: UNIT_CLASS[type as UnitType],
      unlockTech: techUnlock?.id ?? null,
      defaultUnlocked: !techUnlock,
    };
  }

  const techTree = TECH_NODES.map(n => ({
    id: n.id,
    name: n.name,
    description: n.description,
    cost: n.cost,
    researchTime: n.researchTime,
    prereqs: n.prereqs,
    branch: n.branch ?? null,
    unitUnlock: n.unitUnlock ?? null,
    faction: n.faction ?? null,
  }));

  // §37/§38 — once a player's faction is revealed, recruiting uses THESE
  // numbers (via getUnitCost/getUnlockedUnits/applyFactionToStats), not the
  // generic `units` block above — the generic block is only the pre-reveal
  // baseline / display fallback. Keyed by the same universal `slot` (UnitType)
  // so a faction's flavor of a slot is directly comparable to `units[slot]`.
  const factionRosters: Record<string, unknown> = {};
  for (const [faction, roster] of Object.entries(FACTION_UNITS)) {
    factionRosters[faction] = roster
      .map(u => ({
        slot: u.slot,
        name: u.displayName,
        cost: u.cost,
        hp: u.hp,
        atk: u.attack,
        def: u.defense,
        spd: u.speed,
        rng: u.range,
        vision: u.vision,
        unitClass: u.unitClass,
        earlyUnlock: u.earlyUnlock,
      }));
  }

  return {
    units: unitTypes,
    factions: factionRosters,
    techTree: {
      note: 'Tech-tree pacing pass — research is a real, single-slot, multi-round civilization investment: each player has exactly ONE active research slot at a time (see the "research" action). Starting a tech charges its full `cost` in aura immediately, same as Farm/Temple founding, but its effect (unlock/stat bonus/population cap raise) only applies once `researchTime` rounds have elapsed — banking Energy does not let a player bypass this, the slot itself is the limiter. Command II additionally requires Command I completed AND at least 2 other completed technologies (not expressible via `prereqs`), and the Heavy Knight/Champion Rite final unlocks each require BOTH their faction\'s tier-1 tech AND Command I.',
      nodes: techTree,
    },
    strategicSites: {
      note: 'Temple-only expansion (phase 10 correction — Agrar never founds/conquers a site, see economy.agrarFarms instead). v12: there is no more Acolyte — ANY Temple-faction unit can found a neutral/ruined site into Temple I, or CONQUER an active enemy Temple directly (inheriting its current level), over a one-round process — see the "found" action, the templeLevels block below, and the openingFlow/structures blocks.',
      establishCost: SITE_ESTABLISH_COST,
      states: ['neutral', 'foundingTemple', 'temple', 'upgradingTemple', 'ruins'],
      foundingRules: [
        'Any Temple-faction unit standing on a neutral site, Ruins, OR an active enemy-owned Temple, with an unused attack action (may have moved onto the site that same turn), no enemy unit on the site, >= establishCost aura, may start founding/conquest via the "found" action. Agrar can never found/conquer a site at all. Cultivation blocking (see economy.agrarFarms.cultivation) only applies to a neutral/ruined target, never to conquering an already-active Temple.',
        'Starting it charges establishCost immediately — no waiting until completion to pay.',
        'Resolves automatically at the start of the acting player\'s NEXT round: succeeds only if their unit is still alive and on the site, no enemy unit is on the site, and no enemy unit is adjacent to it. Otherwise it fails with no refund.',
        'Founding a neutral site or reconsecrating Ruins keeps `state` at \'foundingTemple\' throughout (0 income/production) and always produces Temple I on success — see templeLevels. CONQUERING an active enemy Temple is different: `state` stays \'temple\' the whole time (the current owner keeps full income/production/recruiting right up until the moment it completes), and success INHERITS the site\'s current templeLevel as-is (a Temple II stays Temple II under the new owner) — no reset, no "ownership snowball" cooldown.',
      ],
      templeLevels: {
        note: 'v11/v12 Temple conquest/upgrade system — a freshly founded (or reconsecrated) Temple is always level 1 (Temple I); it may then be upgraded to level 2 (Temple II) via the "upgrade-temple" action, or directly CONQUERED by a rival Temple player at whatever level it currently holds (see foundingRules). HP/DEF are identical at both levels (see structures.temple) — only income/production differ (see economy.templeUpgrade).',
        temple1: { income: TEMPLE_LEVEL_INCOME[1], production: 0 },
        temple2: { income: TEMPLE_LEVEL_INCOME[2], production: TEMPLE_II_PRODUCTION_BONUS, note: 'income is the TOTAL for the site, not +2 on top of Temple I\'s +1.' },
        upgradeRules: [
          `Only the owner of a Temple I site, with no upgrade already in progress and >= ${TEMPLE_UPGRADE_COST} aura, may start an upgrade — see the "upgrade-temple" action.`,
          'Starting an upgrade charges the cost immediately and moves the site to \'upgradingTemple\'. Unlike founding there is no unit/board presence to maintain — the site keeps functioning at its Temple I level (income/production/recruiting) throughout.',
          'The upgrade resolves automatically at the start of the owning player\'s NEXT round, becoming Temple II — it cannot fail once started EXCEPT by the Temple itself being destroyed first (see structures.temple), which sends it straight to Ruins and forfeits the upgrade cost with no refund.',
          'Destroying a Temple (I, II, or mid-upgrade) — v12: ONLY an Agrar unit can do this via attack-structure, Temple-faction players never destroy a rival Temple by combat — ALWAYS reduces it to Ruins with templeLevel cleared. Reconsecrating those Ruins (by any Temple player) always restarts at Temple I; only a DIRECT conquest of a still-active enemy Temple (see foundingRules) preserves its level.',
        ],
      },
    },
    structures: {
      note: 'Shared combat model for Capital/Temple/Farm — see the "attack-structure" action. Structures never revenge (no counter-damage) and are never captured by melee follow-through or by standing on them. There is no "City" — Agrar\'s only structures are its Capital and its Farms (phase 10 correction).',
      capital: { hp: STRUCTURES.capital.hp, defense: STRUCTURES.capital.defense, note: 'One per player, permanent, cannot become Ruins or change owner. Reaching 0 HP ends the match immediately.' },
      temple: { hp: STRUCTURES.temple.hp, defense: STRUCTURES.temple.defense, note: 'Temple-faction founding result. v12: only Agrar may reduce it to Ruins via attack-structure — a rival Temple player instead conquers it directly while still active (see strategicSites.foundingRules), never by combat.' },
      farm: { hp: STRUCTURES.farm.hp, defense: STRUCTURES.farm.defense, note: 'Agrar-only physical income building, built directly on open land (not tied to a site). Destroyed outright at 0 HP — no Ruins state, just gone; may be rebuilt elsewhere.' },
    },
    economy: {
      note: 'Phase 10 correction — "Agrar controls area, Temple controls points": Agrar\'s economy is its Farm network, Temple\'s is its owned sites. Flat base income plus one faction-specific expansion mechanic each. Both cap at the same maximum (see command.productionSlots for the matching production curve).',
      baseIncomePerRound: 'BASE_INCOME_PER_ROUND, granted every round regardless of structures owned.',
      agrarFarms: {
        note: 'Agrar\'s ONLY economic expansion. Built directly by the Builder on open land — Agrar never captures/founds a site. A Farm founds over one round like a strategic site (see the "build-farm" action), not instantly.',
        cost: AGRAR_FARM_COST,
        incomePerFarm: AGRAR_FARM_INCOME,
        maxActiveFarms: MAX_ACTIVE_FARMS,
        placement: `A new Farm must be a direct hex NEIGHBOR of the Builder's current position (the Builder's own movement matters) AND land INSIDE existing Agrar Territory (see territory.agrarTerritory below) — the network only grows as a connected bunker, it can never leapfrog across the map, and completing a new Farm immediately expands the territory for the next one. It must be empty/passable terrain, not a sacred site/Capital/structure/unit, and never within ${FARM_MIN_SPACING} hexes of another Farm (founding or active). Directly adjacent to the Capital is fine — see the "build-farm" action.`,
        constructionInterruption: 'A Farm still under construction fails outright (removed, no refund) if by the time it resolves the Builder has been killed, is no longer adjacent to (or standing on) the construction hex, or an enemy now occupies the hex.',
      },
      templeUpgrade: {
        note: 'Concentrated, non-spatial investment on the Temple site itself (v11) — a single 6⚡/1-round upgrade step from Temple I to Temple II, replacing the old two-level Devotion purchase ladder. See strategicSites.templeLevels for the full state machine.',
        cost: TEMPLE_UPGRADE_COST,
        incomeAtLevel1: TEMPLE_LEVEL_INCOME[1],
        incomeAtLevel2: TEMPLE_LEVEL_INCOME[2],
        productionBonusAtLevel2: TEMPLE_II_PRODUCTION_BONUS,
      },
      investmentPersistence: 'Investment is NEVER preserved through a Ruins state, for ANY player, including the site\'s original owner recapturing their own former Ruins — reconsecrating Ruins always restarts at Temple I, requiring the full 6+6=12⚡ again to reach Temple II. v12: this ONLY applies to the Ruins path (Agrar-destroyed) — directly CONQUERING a still-active enemy Temple (see strategicSites.foundingRules) bypasses it entirely and inherits the current level as-is. Farms have the same "no salvage" property when destroyed — a destroyed Farm is just gone (see structures.farm).',
    },
    territory: {
      note: 'Economy/pacing balance pass — split into two distinct, smaller-purpose radii (was one unified concept). NEITHER grants a combat bonus of any kind — Agrar\'s edge is structural (higher HP/DEF baselines, Roads, ZOC, Farms, area denial), not an invisible defensive aura. Both are derived fresh from live Capital/Farm positions every time, never stored on GameState.',
      agrarTerritory: {
        note: 'Infrastructure reach ONLY. The union of every hex within radius of the Capital, PLUS every hex within radius of each ACTIVE Farm — see getAgrarTerritory. Used ONLY to gate Farm/Road placement (economy.agrarFarms.placement, roads.placement) — a new one must land inside existing territory, so completing one immediately expands where the next can go. Grants no defense bonus and plays no part in area denial (see agrarCultivation for that).',
        radius: AGRAR_TERRITORY_RADIUS,
      },
      agrarCultivation: {
        note: 'Shrine-denial reach ONLY, deliberately smaller and farm-only — the Capital projects none of this. Every ACTIVE Farm\'s own hex + its 6 neighbours — see getAgrarCultivation. A neutral/ruined strategic site inside an ENEMY Agrar player\'s cultivation cannot be founded/rebuilt by Temple, but it never disables an already-ACTIVE Temple (see strategicSites) — Agrar must destroy it militarily first, and even then the resulting Ruins are only blocked from reconstruction if they fall inside this radius.',
        radius: CULTIVATION_RADIUS,
      },
    },
    command: {
      note: 'Population cap and recruiting throughput (phase 6, extended phase 10). Territory never raises the population cap — only Command I/II tech does. Production throughput DOES scale with territory, but along each faction\'s own axis — see productionSlots.',
      populationCap: { tiers: COMMAND_TIERS, note: 'Starts at COMMAND_TIERS.start; the "command_1"/"command_2" techs (linear, II requires I) raise it to commandI then commandII.' },
      populationCost: 'Each unit spends its faction def\'s commandCost against the cap (see the `factions` block above) — NOT a flat 1 per unit. Heavier units (cavalry/heavy) cost more of the cap than light ones.',
      productionSlots: {
        note: 'Recruiting draws from a limited pool of production slots, not an unlimited allowance. A recruit pays its cost immediately and enters a training queue, occupying one of the recruiting player\'s slots for UNIT_TRAINING_ROUNDS rounds. The unit does NOT exist on the battlefield yet — it deploys at the start of the recruiting player\'s NEXT round (at the structure that trained it), which also frees the slot. If that structure\'s tile is occupied at that moment, the completed unit stays queued (pending deployment) rather than being lost — nothing is destroyed or refunded. Both factions start at PRODUCTION_BASE_SLOTS and cap at PRODUCTION_MAX_SLOTS, reached via different territory: Agrar centralizes all training at its Capital and scales slots with active Farm count (2 Farms -> +1, 4 Farms -> +1 more); Temple distributes production — but only a FULLY-developed (Temple II, v11) owned Temple site grants +1 slot (a Temple I grants none) — any founded Temple (I or II, including mid-upgrade) IS a valid recruiting/deployment location though, not just the Capital — this matches Agrar needing 2 Farms (same total Energy as one Temple II) for its own +1 slot.',
        baseSlots: PRODUCTION_BASE_SLOTS,
        maxSlots: PRODUCTION_MAX_SLOTS,
        trainingRounds: UNIT_TRAINING_ROUNDS,
      },
    },
    roads: {
      note: 'Agrar-only physical road tiles (phase 7, §23-25; movement bonus restricted to Agrar phase 11 §26; adjacency + network-connectivity placement added afterward). Only a Builder (a "founder"-type unit belonging to an Agrar player) can build one — consumes its whole activation, same as founding, and resolves immediately (no multi-round construction, unlike Farms). Temple has no equivalent way to build one.',
      placement: 'A new Road hex must be a direct NEIGHBOUR of the Builder (same as Farm placement — see economy.agrarFarms.placement) AND itself be directly adjacent to the Capital, an active Farm, or an existing Road belonging to that same player — the network only ever extends link by link out from something real, it can never appear disconnected in the middle of nowhere. See getValidRoadHexes.',
      costPerHex: ROAD_COST_PER_HEX,
      movementBonus: { amount: ROAD_MOVEMENT_BONUS, note: 'Applies to Agrar units ONLY (only Agrar can build a Road in the first place). A Temple unit moving over an Agrar Road receives no bonus — it treats the tile as normal terrain.' },
      pillage: {
        note: 'Any unit that ends its move on a road it does NOT own destroys it on arrival — no separate action needed, it just happens as a side effect of "move". A pillaged hex is cheaper to rebuild than to build fresh.',
        rebuildCost: ROAD_PILLAGE_REBUILD_COST,
      },
    },
    zoneOfControl: {
      note: 'Phase 8, §26. Warrior/pike/cavalry/heavy-class units (see units[].unitClass) project a zone of control onto their 6 adjacent hexes — archer/siege/support/Builder don\'t. Shared rule, not faction-specific.',
      effect: 'Entering an enemy ZOC hex ends that unit\'s movement for the turn — the hex itself is reachable, but nothing beyond it is that move. A unit that STARTS its turn already in an enemy ZOC hex is not frozen by its own position; the restriction only triggers on newly entering one.',
      visibility: 'Only VISIBLE enemy ZOC-projectors count — a fogged or forest-hidden enemy (not revealed per the usual fog/forest rules) doesn\'t project a ZOC the opponent can react to.',
      scope: 'Movement only — attack range and targeting are unaffected; ZOC is not a combat mechanic.',
    },
    terrain: {
      hill: {
        defenseBonusOnHill: HILL_DEFENSE_BONUS,
        visionBonusOnHill: HILL_VISION_BONUS,
        rangeBonusOnHill: HILL_RANGE_BONUS,
        note: 'Range bonus applies to ranged units only (range > 1). Moving onto/off a hill costs full movement budget.',
      },
      forest: {
        note: 'Reduces vision to 1 when standing inside. Units inside are hidden unless an adjacent enemy unit or owned structure is within 1 hex.',
      },
      wall: { note: 'Impassable.' },
    },
    support: {
      supportRange: SUPPORT_RANGE,
      healerHealAmount: HEALER_HEAL_AMOUNT,
      damageBoostAmount: DAMAGE_BOOST_AMOUNT,
      rangeBoostAmount: RANGE_BOOST_AMOUNT,
      note: 'Support units affect all allies within SUPPORT_RANGE hexes. Healer heals at start of owning player turn.',
    },
    teleports: {
      note: 'Removed (phase 11 §32). There is no "teleports" tech anymore, so canBuildTeleportPair always returns false — fully dormant, not exposed in UI, not constructible.',
    },
    combat: {
      deterministic: true,
      formula: 'modifiedAttack = attackerATK * typeMultiplier; baseDamage = max(0.25*modifiedAttack, modifiedAttack - defenderDEF); damage = round(baseDamage * healthMultiplier * encirclementMultiplier), floored to 1 for a landed hit. No RNG.',
      healthMultiplier: '0.5 + 0.5 * (attackerCurrentHP / attackerMaxHP) — a wounded attacker never drops below 50% effectiveness.',
      typeMultiplier: 'Soft-counter matrix keyed by unit class (see units[].unitClass), max 1.35x, defaults to 1.0 for unlisted pairs. Never a hard immunity.',
      unitClasses: {
        pike:    { beats: { cavalry: 1.35, heavy: 1.35 } },
        cavalry: { beats: { archer: 1.25, siege: 1.25, support: 1.25 } },
        archer:  { beats: { pike: 1.25 } },
        siege:   { beats: { heavy: 1.30 } },
        heavy:   { beats: { warrior: 1.20, archer: 1.20 } },
      },
      firstStrike: 'Damage scales with the attacker\'s current HP fraction, so attacking first (at full HP) beats being countered from reduced HP.',
      revengeAttack: 'Sequential: the attacker strikes first. If the target survives AND the attacker is within the target\'s effective attack range, the target fights back from its REMAINING HP. A dead defender never fights back; an out-of-range defender (e.g. melee vs a distant catapult) cannot.',
      meleeStep: 'Melee units (range=1) step onto killed target\'s tile.',
      encirclement: 'Up to 1.5x damage multiplier based on surrounding enemy units. Map edges/empty space do NOT count as blocking — only actual enemy pressure does.',
      splash: 'Computed from the un-encircled base hit (encirclementMultiplier=1, typeMultiplier=1) before splashFactor is applied, so splash damage is never amplified by the primary target\'s encirclement.',
    },
    turnStructure: {
      startOfTurn: [
        'Receive aura income: BASE_INCOME_PER_ROUND + AGRAR_FARM_INCOME per active owned Farm + TEMPLE_LEVEL_INCOME[templeLevel] per owned Temple site — see economy above.',
        'Resolve any site founding, Farm construction, AND Temple upgrade this player has due (§6, §9, v11) — succeeds/completes before income is granted, so a structure completing this turn already counts.',
        'Healers restore HP to nearby allies (within support range)',
      ],
      availableActions: [
        'move — move a unit to a reachable hex',
        'attack — attack an enemy unit within range (blocked during the pre-game faction-reveal pause)',
        'attack-structure — { unitId, targetPos } attack an enemy Capital/Temple/Farm within range (same restriction). Structures never revenge.',
        'recruit — { unitType, templeId (target structure id) } pay the unit\'s cost and queue it for training (blocked during the pre-game faction-reveal pause) — for Agrar this is the Capital ONLY (centralized production); for Temple it\'s the Capital plus each owned Temple site (distributed production) — see command.productionSlots. The unit does NOT appear immediately; it deploys at the start of the recruiting player\'s next round.',
        'found — { unitId } start founding/conquest at the neutral, ruined, or active enemy Temple site the unit is standing on (same restriction, Temple only, ANY unit type — see strategicSites above).',
        'build-farm — { unitId, pos } the Builder starts building a Farm at a valid adjacent hex (same restriction) — Agrar only, see economy.agrarFarms above. Completes next round like founding.',
        'upgrade-temple — { templeId (owned Temple I id) } start the 6⚡/1-round upgrade to Temple II on that site (same restriction) — Temple faction only, see strategicSites.templeLevels above.',
        'build-road — { unitId, pos } the Builder builds a road at a valid adjacent hex (same restriction) — Agrar faction only, see roads above. Resolves immediately (unlike build-farm).',
        'research — research a tech (same restriction). A tech node with a `faction` set (see techTree) may only be researched by a player of that faction.',
        'end-turn — end the current player\'s turn (blocked only during the pre-game faction-reveal pause)',
        'resign — concede the game, opponent wins (always available)',
        'choose-faction — { faction: "agrar" | "temple" }. Legal immediately at match start, before any other action, for either player independently — see openingFlow below.',
      ],
      constraints: [
        'A unit can move then attack, or just attack, or just move — but not attack then move.',
        'Attacking (unit or structure) also sets hasMoved=true.',
        'A structure may have MULTIPLE recruit orders queued against it over time — there is no per-structure spawn gate. What actually caps recruiting is aura, the population cap (commandCost-weighted, see command block — queued-but-undeployed orders count against it too), and the player\'s overall production-slot pool (see command.productionSlots).',
        'Founding is a separate action from move/attack — it consumes the founder\'s WHOLE activation (both move and attack) the instant it starts.',
      ],
    },
    openingFlow: {
      note: 'Phase 11 correction — there is no more Founding Round, no starting units, and no move-only scouting phase. Faction choice happens immediately, secretly and simultaneously, before any gameplay: each player independently submits choose-faction any time after match start; once BOTH have chosen, they reveal simultaneously and Round 1 begins with each player owning only their Capital, STARTING_ENERGY aura, PRODUCTION_BASE_SLOTS production slots, and ZERO units. The player\'s first units are part of the opening strategy, recruited like any other unit (see the `recruit` action and command.productionSlots). v12: the Builder (slot "founder") is Agrar-only — Temple has no equivalent early recruit any more (the Acolyte was removed; any ordinary Temple unit can found/conquer a site — see strategicSites).',
      factions: ['agrar', 'temple'],
    },
    winConditions: [
      'Destroy the enemy Capital (hp <= 0) → immediate win. This is the ONLY normal victory condition — there is no more "own every site" check and no elimination-by-attrition fallback; a Capital is permanent until destroyed.',
    ],
    startingConditions: {
      startingAura: STARTING_ENERGY,
      startingUnits: 'Zero. Every unit is recruited — see openingFlow above and the top-level `factions` block for per-faction costs/stats/unlock timing.',
      siteLayout: 'One permanent Capital per player + neutralSiteCountForPlayers(N) shared neutral strategic sites (2p → 2 Capitals + 2 neutral sites), placed randomly each game with a minimum separation and maximized spread.',
      mapScalesWithPlayers: true,
      mapRadiusFormula: 'mapRadiusForPlayers(N) = 6 + max(0, N-2) for N>2; 1v1 (the only supported online match size) is a fixed radius 7',
      mapRadiusExamples: { '2p': mapRadiusForPlayers(2), '3p': mapRadiusForPlayers(3), '4p': mapRadiusForPlayers(4) },
      neutralSiteCountFormula: 'neutralSiteCountForPlayers(N) = N',
      note: 'Online rooms are 1v1 only. N-player (3-6) game creation still works in this engine/headless API for tooling but is not an online-lobby-facing feature.',
    },
  };
}

// ── Main dispatcher ──

function fail(state: GameState, playerSlot: number, actionName: UnifiedActionName | string, error: string): ExecuteFailure {
  return {
    ok: false,
    action: actionName,
    error,
    legalMoves: computePlayerLegalMoves(state, playerSlot),
  };
}

/**
 * Execute a unified action against the game state. The state is mutated in
 * place on success. The caller is responsible for persistence (DB save),
 * broadcast (WS push to opponents/spectators), and replay logging.
 *
 * Rules enforced here (transport-independent):
 *   - The game must not be in gameOver phase (except for resign, which is a
 *     no-op in that case anyway).
 *   - It must be the acting player's turn (except for resign, which can fire
 *     at any time on the acting player's own slot).
 *   - All per-action invariants delegated to src/game.ts mutators.
 */
export function executeAction(
  state: GameState,
  playerSlot: number,
  action: UnifiedActionName,
  params: Record<string, unknown>,
): ExecuteResult {
  // Game-over guard. Resign on a finished game is also rejected for clarity.
  if (state.phase === 'gameOver') {
    return fail(state, playerSlot, action, 'Game is already over');
  }

  // Turn guard — resign is allowed even on the opponent's turn (concede
  // early); choose-faction is allowed regardless of turn order (both players
  // commit independently right at match start, before Round 1 begins).
  if (action !== 'resign' && action !== 'choose-faction' && state.currentPlayerIndex !== playerSlot) {
    return fail(
      state,
      playerSlot,
      action,
      `Not player ${playerSlot}'s turn (current turn: player ${state.currentPlayerIndex})`,
    );
  }

  const log: string[] = [];

  try {
    switch (action) {
      case 'move': {
        const { unitId, to } = params as { unitId?: string; to?: HexCoord };
        if (!unitId || !to) return fail(state, playerSlot, action, 'Missing unitId or to');

        selectUnit(state, unitId);
        if (state.selectedUnitId !== unitId) {
          return fail(state, playerSlot, action, `Cannot select unit ${unitId} (not owned by player ${playerSlot} or not found)`);
        }
        const result = moveUnit(state, to);
        if (!result.moved) {
          deselectAll(state);
          return fail(state, playerSlot, action, `Invalid move for unit ${unitId} to (${to.q},${to.r})`);
        }
        log.push(`Unit ${unitId} moved to (${to.q},${to.r})`);
        deselectAll(state);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'attack': {
        const { unitId, targetId } = params as { unitId?: string; targetId?: string };
        if (!unitId || !targetId) return fail(state, playerSlot, action, 'Missing unitId or targetId');

        const target = state.units.find(u => u.id === targetId && u.hp > 0);
        if (!target) return fail(state, playerSlot, action, `Target ${targetId} not found or already dead`);

        selectUnit(state, unitId);
        if (state.selectedUnitId !== unitId) {
          return fail(state, playerSlot, action, `Cannot select unit ${unitId}`);
        }

        const combat = attackUnit(state, target.pos);
        if (!combat) {
          deselectAll(state);
          return fail(state, playerSlot, action, `Invalid attack from ${unitId} to ${targetId}`);
        }
        log.push(`Unit ${unitId} attacked ${targetId}: ${combat.damageDealt} dmg dealt, ${combat.damageReceived} dmg received`);
        if (combat.targetKilled) log.push(`${targetId} was killed`);
        if (combat.attackerKilled) log.push(`${unitId} was killed (revenge)`);
        for (const splash of combat.splashHits) {
          log.push(`Splash: ${splash.unitId} took ${splash.damage} dmg${splash.killed ? ' (killed)' : ''}`);
        }
        deselectAll(state);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'attack-structure': {
        const { unitId, targetPos } = params as { unitId?: string; targetPos?: HexCoord };
        if (!unitId || !targetPos) return fail(state, playerSlot, action, 'Missing unitId or targetPos');

        const ref = getStructureAt(state, targetPos);
        if (!ref) return fail(state, playerSlot, action, `No attackable structure at (${targetPos.q},${targetPos.r})`);

        selectUnit(state, unitId);
        if (state.selectedUnitId !== unitId) {
          return fail(state, playerSlot, action, `Cannot select unit ${unitId}`);
        }

        const combat = attackStructure(state, targetPos);
        if (!combat) {
          deselectAll(state);
          return fail(state, playerSlot, action, `Invalid structure attack from ${unitId} to (${targetPos.q},${targetPos.r})`);
        }
        const kind = ref.kind === 'capital' ? 'Capital' : ref.kind === 'farm' ? 'Farm' : 'structure';
        log.push(`Unit ${unitId} attacked ${kind} at (${targetPos.q},${targetPos.r}): ${combat.damageDealt} dmg dealt`);
        if (combat.destroyed) log.push(ref.kind === 'capital' ? 'Capital destroyed!' : ref.kind === 'farm' ? 'Farm destroyed' : 'Structure destroyed — reduced to Ruins');
        if (combat.gameOver) log.push(`Game over — player ${playerSlot} wins`);
        deselectAll(state);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'found': {
        const { unitId } = params as { unitId?: string };
        if (!unitId) return fail(state, playerSlot, action, 'Missing unitId');

        const unit = state.units.find(u => u.id === unitId && u.hp > 0);
        if (!unit) return fail(state, playerSlot, action, `Unit ${unitId} not found or dead`);
        if (unit.playerId !== playerSlot) return fail(state, playerSlot, action, `Unit ${unitId} is not owned by player ${playerSlot}`);

        const ok = startFounding(state, unitId);
        if (!ok) {
          return fail(state, playerSlot, action, `Unit ${unitId} cannot start founding/conquest here (not Temple faction, invalid site state, enemy present, cultivation-blocked, already used this turn's action, or insufficient aura)`);
        }
        log.push(`Unit ${unitId} began founding at (${unit.pos.q},${unit.pos.r})`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'destroy': {
        // Disband an owned unit. unitId is required (no selection fallback) so
        // the acting player disbands exactly the unit they meant.
        const { unitId } = params as { unitId?: string };
        if (!unitId) return fail(state, playerSlot, action, 'Missing unitId');

        const unit = state.units.find(u => u.id === unitId && u.hp > 0);
        if (!unit) return fail(state, playerSlot, action, `Unit ${unitId} not found or dead`);
        if (unit.playerId !== playerSlot) return fail(state, playerSlot, action, `Unit ${unitId} is not owned by player ${playerSlot}`);

        if (!destroyUnit(state, unitId)) {
          return fail(state, playerSlot, action, `Cannot destroy unit ${unitId}`);
        }
        log.push(`Unit ${unitId} was disbanded`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'research': {
        const { techId } = params as { techId?: TechId };
        if (!techId) return fail(state, playerSlot, action, 'Missing techId');
        const ok = researchTech(state, techId);
        if (!ok) return fail(state, playerSlot, action, `Cannot research ${techId} (already researched, missing prereqs, branch conflict, or insufficient aura)`);
        log.push(`Player ${playerSlot} researched ${techId}`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'recruit': {
        // templeId is a legacy wire-param name — it's actually any owned
        // recruit-eligible structure id (Capital, or a completed Temple for
        // the Temple faction — Farms are never recruit-eligible, §17).
        const { unitType, templeId: structureId } = params as { unitType?: UnitType; templeId?: string };
        if (!unitType || !structureId) return fail(state, playerSlot, action, 'Missing unitType or templeId');
        const ok = spawnUnit(state, structureId, unitType);
        if (!ok) return fail(state, playerSlot, action, `Cannot recruit ${unitType} at structure ${structureId} (not owned, can't afford, pop cap, tile occupied, or unit locked)`);
        log.push(`Player ${playerSlot} recruited ${unitType} at structure ${structureId}`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'build-teleport': {
        const { templeId: anchorId, pos, targetPos } = params as { templeId?: string; pos?: HexCoord; targetPos?: HexCoord };
        if (!anchorId || !pos || !targetPos) return fail(state, playerSlot, action, 'Missing templeId, pos, or targetPos for teleport build');
        const ok = buildTeleportPair(state, anchorId, pos, targetPos);
        if (!ok) return fail(state, playerSlot, action, `Cannot build teleport pair from structure ${anchorId}`);
        log.push(`Player ${playerSlot} built teleport pair near structure ${anchorId}`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'build-farm': {
        const { unitId, pos } = params as { unitId?: string; pos?: HexCoord };
        if (!unitId || !pos) return fail(state, playerSlot, action, 'Missing unitId or pos for farm build');
        const ok = startFarm(state, unitId, pos);
        if (!ok) return fail(state, playerSlot, action, `Unit ${unitId} cannot build a Farm at (${pos.q},${pos.r})`);
        log.push(`Player ${playerSlot} began building a Farm at (${pos.q},${pos.r})`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'upgrade-temple': {
        const { templeId: templeSiteId } = params as { templeId?: string };
        if (!templeSiteId) return fail(state, playerSlot, action, 'Missing templeId for Temple upgrade');
        const ok = startTempleUpgrade(state, templeSiteId);
        if (!ok) return fail(state, playerSlot, action, `Cannot start upgrading Temple ${templeSiteId} (not owned, not Temple I, already upgrading, or insufficient aura)`);
        log.push(`Player ${playerSlot} began upgrading Temple ${templeSiteId} to Temple II`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'build-road': {
        const { unitId, pos } = params as { unitId?: string; pos?: HexCoord };
        if (!unitId || !pos) return fail(state, playerSlot, action, 'Missing unitId or pos for road build');
        const ok = buildRoad(state, unitId, pos);
        if (!ok) return fail(state, playerSlot, action, `Unit ${unitId} cannot build a road at (${pos.q},${pos.r}) (not a Builder, not Agrar, not adjacent to the Builder, not adjacent to the Capital/a Farm/an existing Road, tile occupied, already acted, or insufficient aura)`);
        log.push(`Player ${playerSlot} built a road at (${pos.q},${pos.r}) with unit ${unitId}`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'end-turn': {
        const prevPlayer = state.currentPlayerIndex;
        endTurn(state);
        log.push(`Player ${prevPlayer} ended their turn. Now player ${state.currentPlayerIndex}'s turn.`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'resign': {
        const ok = resignGame(state, playerSlot);
        if (!ok) return fail(state, playerSlot, action, 'Cannot resign (game already over)');
        // In an N-player game a single resignation may not end the game (only one
        // of several opponents dropped out), so don't claim a winner unless one
        // was actually decided.
        log.push(
          state.winner
            ? `Player ${playerSlot} resigned. Player ${state.winner.id} (${state.winner.name}) wins.`
            : `Player ${playerSlot} resigned (game continues).`,
        );
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'choose-faction': {
        const { faction } = params as { faction?: string };
        if (faction !== 'agrar' && faction !== 'temple') {
          return fail(state, playerSlot, action, `Invalid faction: ${String(faction)} (expected "agrar" or "temple")`);
        }
        const ok = chooseFaction(state, playerSlot, faction);
        if (!ok) return fail(state, playerSlot, action, 'Cannot choose faction now (not awaiting reveal, or already locked a different faction)');
        // Log intentionally omits WHICH faction was chosen when the reveal
        // hasn't happened yet — the log itself is broadcast to both players via
        // lastAction, and must not leak the opponent's unrevealed pick.
        const revealed = state.players.every(p => p.faction !== null);
        log.push(revealed
          ? `Both players revealed their faction: ${state.players.map(p => `player ${p.id}=${p.faction}`).join(', ')}.`
          : `Player ${playerSlot} locked in a faction (hidden until the opponent also chooses).`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      default:
        return fail(state, playerSlot, action, `Unknown action: ${String(action)}`);
    }
  } catch (e: unknown) {
    return fail(state, playerSlot, action, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
