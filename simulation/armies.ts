// Army composition enumeration.
// Aura budget = sum of unit costs only (research cost excluded).
// A composition is "maximal" when no additional warrior (cheapest unit, cost=1) fits.
// Units are added in non-decreasing index order to avoid duplicate compositions.

import { UNIT_DEFS, UnitDef } from './defs.ts';

export interface ArmyComposition {
  label: string;
  units: UnitDef[];
  totalAura: number;
  unitCounts: Record<string, number>;
  researchRequired: string[];  // which techs must be unlocked (informational)
}

function makeLabel(units: UnitDef[]): string {
  const counts: Record<string, number> = {};
  for (const u of units) counts[u.type] = (counts[u.type] || 0) + 1;
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${count}×${type}`)
    .join(' + ');
}

export function enumerateArmies(auraCap: number): ArmyComposition[] {
  const unitTypes = Object.values(UNIT_DEFS);
  const results: ArmyComposition[] = [];

  function dfs(
    remaining: number,
    startIdx: number,
    units: UnitDef[],
    auraUsed: number,
  ) {
    // Maximal: can't add one more warrior (cost=1) without exceeding budget
    if (remaining === 0 && units.length > 0) {
      save(units, auraUsed);
      return;
    }

    let anyFits = false;
    for (let i = startIdx; i < unitTypes.length; i++) {
      if (unitTypes[i].cost <= remaining) { anyFits = true; break; }
    }
    if (!anyFits && units.length > 0) {
      // No unit with idx >= startIdx fits, but maybe a lower-cost type (e.g. warrior)
      // would fit — we can't add it due to ordering, so this branch is terminal.
      // Only save if remaining < min possible unit cost (1), i.e. truly maximal.
      if (remaining < 1) save(units, auraUsed);
      return;
    }

    for (let i = startIdx; i < unitTypes.length; i++) {
      const u = unitTypes[i];
      if (u.cost > remaining) continue;
      units.push(u);
      dfs(remaining - u.cost, i, units, auraUsed + u.cost);
      units.pop();
    }
  }

  function save(units: UnitDef[], auraUsed: number) {
    const counts: Record<string, number> = {};
    for (const u of units) counts[u.type] = (counts[u.type] || 0) + 1;
    const research = units
      .filter(u => u.requiresResearch)
      .map(u => u.type)
      .filter((t, i, a) => a.indexOf(t) === i);
    results.push({
      label: makeLabel(units),
      units: [...units],
      totalAura: auraUsed,
      unitCounts: counts,
      researchRequired: research,
    });
  }

  dfs(auraCap, 0, [], 0);
  return results;
}
