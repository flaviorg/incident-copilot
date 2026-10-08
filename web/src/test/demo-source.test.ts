// Fonte demo (spec 8.2; AC-39): só ./demo/, gravação inválida vira erro explícito e nada parcial é devolvido.
import { describe, expect, it } from "vitest";
import { DemoRecordingSchema } from "@contracts";
import { loadIndex, loadRecording } from "../data/demo-source.ts";
import { rec } from "./fixtures/recording.ts";

const fakeFetch = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;
const spyFetch = (urls: string[]): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(rec), { status: 200 });
  }) as typeof fetch;

describe("demo source", () => {
  it("the hand-written fixture is a valid recording", () => {
    expect(DemoRecordingSchema.safeParse(rec).success).toBe(true);
  });

  it("loads a valid recording", async () => {
    const r = await loadRecording("deploy-5xx-rollback", fakeFetch(rec));
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.scenario.id).toBe("deploy-5xx-rollback");
  });

  it("invalid recording is an explicit error and nothing partial is returned", async () => {
    const r = await loadRecording("deploy-5xx-rollback", fakeFetch({ ...rec, label: "outra" }));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/gravação inválida/);
    expect("value" in r).toBe(false);
    const broken = await loadRecording("deploy-5xx-rollback", fakeFetch("{nope"));
    expect(broken.ok).toBe(false);
    expect((broken as { error: string }).error).toMatch(/gravação inválida/);
  });

  it("only fetches files under ./demo/", async () => {
    const urls: string[] = [];
    for (const bad of ["../etc", "x/y", "", "UPPER", "a.json", "https://evil.example/x"]) {
      const r = await loadRecording(bad, spyFetch(urls));
      expect(r.ok).toBe(false);
    }
    expect(urls).toEqual([]);
    await loadRecording("cost-anomaly", spyFetch(urls));
    expect(urls).toEqual(["./demo/cost-anomaly.json"]);
  });

  it("HTTP and network failures are explicit errors", async () => {
    const notFound = await loadRecording("cost-anomaly", fakeFetch("nada", 404));
    expect(notFound.ok).toBe(false);
    expect((notFound as { error: string }).error).toMatch(/404/);
    const offline = await loadIndex((async () => {
      throw new TypeError("offline");
    }) as typeof fetch);
    expect(offline.ok).toBe(false);
    expect((offline as { error: string }).error).toMatch(/não foi possível carregar/);
  });

  it("loads and validates the index from ./demo/index.json", async () => {
    const urls: string[] = [];
    const ok = await loadIndex((async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify([rec.scenario]), { status: 200 });
    }) as typeof fetch);
    expect(urls).toEqual(["./demo/index.json"]);
    expect(ok.ok && ok.value[0]!.id).toBe("deploy-5xx-rollback");
    const bad = await loadIndex(fakeFetch([{ id: 1 }]));
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toMatch(/índice inválido/);
  });
});
