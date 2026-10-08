// Comportamentos de biblioteca dos quais o design depende (spec, "Instrução obrigatória").
// Se algum destes testes falhar depois de uma atualização, o design precisa ser revisto antes de seguir.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { StateGraph, START, END, GraphRecursionError } from "@langchain/langgraph";
import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const S = z.object({ n: z.number() });

// Grafo a <-> b sem saída: cada nó soma 1.
function loop() {
  return new StateGraph(S)
    .addNode("a", (s) => ({ n: s.n + 1 }))
    .addNode("b", (s) => ({ n: s.n + 1 }))
    .addEdge(START, "a")
    .addConditionalEdges("a", () => "b")
    .addEdge("b", "a")
    .compile();
}

test("StateGraph accepts a Zod 4 object and merges partial updates", async () => {
  const g = new StateGraph(S).addNode("inc", (s) => ({ n: s.n + 1 })).addEdge(START, "inc").addEdge("inc", END).compile();
  assert.deepEqual(await g.invoke({ n: 1 }), { n: 2 });
});

test("a node cannot share its name with a state key (reason for GRAPH_NODE_ID in src/graph/routing.ts)", () => {
  const T = z.object({ n: z.number(), supervisor: z.object({ k: z.number() }) });
  assert.throws(() => new StateGraph(T).addNode("supervisor", (s) => ({ n: s.n + 1 })), /already being used as a state attribute/);
  assert.doesNotThrow(() => new StateGraph(T).addNode("supervisor_agent", (s) => ({ n: s.n + 1 })));
});

test("GraphRecursionError is exported from the root and thrown past recursionLimit", async () => {
  await assert.rejects(loop().invoke({ n: 0 }, { recursionLimit: 5 }), (e) => e instanceof GraphRecursionError);
});

test("stream values keeps the last emitted state when GraphRecursionError is thrown", async () => {
  let last: { n: number } | undefined;
  let thrown: unknown = null;
  try {
    for await (const chunk of await loop().stream({ n: 0 }, { streamMode: "values", recursionLimit: 5 })) {
      last = chunk as { n: number };
    }
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof GraphRecursionError);
  assert.deepEqual(last, { n: 5 });
});

test("a subgraph invoked inside a node inherits recursionLimit (reason for the in-node ReAct loop)", async () => {
  const R = z.object({ steps: z.number() });
  // Subgrafo ReAct think/act: think decide (ação ou final); 12 ações = 12 think + 12 act + 1 think final = 25 supersteps.
  const sub = new StateGraph(R)
    .addNode("think", (s) => ({ steps: s.steps }))
    .addNode("act", (s) => ({ steps: s.steps + 1 }))
    .addEdge(START, "think")
    .addConditionalEdges("think", (s) => (s.steps >= 12 ? END : "act"))
    .addEdge("act", "think")
    .compile();
  const parentWithSubgraph = new StateGraph(R)
    .addNode("analyst", async (s) => sub.invoke(s))
    .addEdge(START, "analyst")
    .addEdge("analyst", END)
    .compile();
  await assert.rejects(parentWithSubgraph.invoke({ steps: 0 }, { recursionLimit: 25 }), (e) => e instanceof GraphRecursionError);
  // Prova de herança (e não do padrão 25): com o pai em 100, o mesmo subgrafo termina.
  assert.deepEqual(await parentWithSubgraph.invoke({ steps: 0 }, { recursionLimit: 100 }), { steps: 12 });

  const parentWithLoop = new StateGraph(R)
    .addNode("analyst", (s) => {
      let steps = s.steps;
      for (let i = 0; i < 12; i++) steps += 1;
      return { steps };
    })
    .addEdge(START, "analyst")
    .addEdge("analyst", END)
    .compile();
  assert.deepEqual(await parentWithLoop.invoke({ steps: 0 }, { recursionLimit: 25 }), { steps: 12 });
});

test("AbortSignal.timeout rejects invoke with a TimeoutError", async () => {
  const g = new StateGraph(S)
    .addNode("slow", async (s, config) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 300);
        config.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(config.signal?.reason);
        });
      });
      return { n: s.n + 1 };
    })
    .addEdge(START, "slow")
    .addEdge("slow", END)
    .compile();
  await assert.rejects(g.invoke({ n: 0 }, { signal: AbortSignal.timeout(50) }), (e) => (e as Error).name === "TimeoutError");
});

test("node:sqlite has no transaction() and run() returns changes and lastInsertRowid", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal("transaction" in db, false);
  db.exec("create table t (id integer primary key, v text)");
  const r = db.prepare("insert into t (v) values (?)").run("x");
  assert.equal(r.changes, 1);
  assert.equal(Number(r.lastInsertRowid), 1);
});

test("zod 4 exposes toJSONSchema and iso.datetime", () => {
  const js = z.toJSONSchema(z.object({ at: z.iso.datetime() }));
  assert.equal((js as any).properties.at.format, "date-time");
});

test("McpServer.registerTool accepts a Zod 4 raw shape", () => {
  const s = new McpServer({ name: "t", version: "0.0.0" });
  s.registerTool("echo", { description: "d", inputSchema: { a: z.string() }, outputSchema: { a: z.string() } },
    async ({ a }) => ({ content: [{ type: "text", text: a }], structuredContent: { a } }));
});
