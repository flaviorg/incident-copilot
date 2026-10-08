// Estado do grafo: o próprio blackboard (spec 5.2). Cada chave usa o redutor padrão do LangGraph para objetos Zod
// (último valor), então cada nó devolve só as chaves que mudou e o resto do estado segue intacto.
import { BlackboardSchema } from "../contracts/index.ts";
import type { Blackboard } from "../contracts/index.ts";

export const IncidentGraphState = BlackboardSchema;
export type IncidentGraphStateType = Blackboard;
