// Resolves the incident context for the nodes (spec 008, decision 5). Without an origin it is the same
// scenarios.get(scenarioId, { offsetSec }) call the nodes made before 0.4, so scenario mode is unchanged.
import type { ScenarioRepository } from "../infra/scenarios/scenario-loader.ts";
import type { ServiceMap } from "../domain/ingest/service-map.ts";
import type { IncidentContextResolver, LiveSource } from "../tools/context.ts";

export function createIncidentContextResolver(o: {
  scenarios: Pick<ScenarioRepository, "get">;
  live: { sources(): LiveSource[]; services: ServiceMap } | null;
}): IncidentContextResolver {
  return {
    resolve(state) {
      if (state.origin === undefined) {
        return { kind: "scenario", scenario: o.scenarios.get(state.scenarioId, { offsetSec: state.timeOffsetSec }) };
      }
      if (o.live === null) throw new Error("live incident without connector configuration");
      return {
        kind: "live",
        sources: o.live.sources(),
        services: o.live.services,
        incidentService: state.alert?.service ?? null,
        origin: state.origin,
      };
    },
  };
}
