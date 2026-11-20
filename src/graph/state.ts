// Graph state: the blackboard itself (spec 5.2). Each key uses LangGraph's default reducer for Zod objects
// (last value), so each node returns only the keys it changed and the rest of the state stays intact.
import { BlackboardSchema } from "../contracts/index.ts";
import type { Blackboard } from "../contracts/index.ts";

export const IncidentGraphState = BlackboardSchema;
export type IncidentGraphStateType = Blackboard;
