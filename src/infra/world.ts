// Initial world from the scenario: deployments with the version history and the inventory (one live copy and one
// frozen copy). Used only by SimulatedInfra.initialWorld.
import type { WorldState } from "../contracts/index.ts";
import type { LoadedScenario } from "./scenarios/scenario-loader.ts";

export function initialWorldFrom(scenario: LoadedScenario): WorldState {
  const deployments: WorldState["deployments"] = {};
  for (const d of [...scenario.deploys].sort((a, b) => a.at.localeCompare(b.at))) {
    const history = [...(deployments[d.service]?.history ?? [])];
    for (const v of [d.previousVersion, d.version]) if (!history.includes(v)) history.push(v);
    deployments[d.service] = { version: d.version, previousVersion: d.previousVersion, replicas: d.replicas, blockedTags: [], history };
  }
  return {
    deployments,
    inventory: scenario.inventory ? structuredClone(scenario.inventory) : null,
    initialInventory: scenario.inventory ? structuredClone(scenario.inventory) : null,
    notes: [],
    tagsForReview: [],
    snapshots: [],
  };
}
