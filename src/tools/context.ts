// Incident context of the read tools (spec 008, decision 5). Types only. A scenario incident reads its recorded data;
// a live incident reads the configured query capabilities. The graph receives a resolver, never a connector.
import type { Blackboard, IncidentOrigin, WorldState } from "../contracts/index.ts";
import type { LoadedScenario } from "../infra/scenarios/scenario-loader.ts";
import type { ServiceMap } from "../domain/ingest/service-map.ts";
import type { QueryCapability } from "../connectors/types.ts";

export type LiveSource = { connectorId: string; type: string; query: QueryCapability };

export type IncidentContext =
  | { kind: "scenario"; scenario: LoadedScenario }
  | { kind: "live"; sources: LiveSource[]; services: ServiceMap; incidentService: string | null; origin: IncidentOrigin };

export interface IncidentContextResolver {
  resolve(state: Pick<Blackboard, "scenarioId" | "timeOffsetSec" | "origin"> & Partial<Pick<Blackboard, "alert">>): IncidentContext;
}

export type ToolContext = { incident: IncidentContext; world: WorldState; now: Date; signal?: AbortSignal };
