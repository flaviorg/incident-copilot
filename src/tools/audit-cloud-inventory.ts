import * as z from "zod";
import { auditInventory } from "../domain/finops/inventory-audit.ts";
import type { CloudPrices } from "../domain/finops/inventory-audit.ts";
import { formatUsd } from "./format.ts";
import type { Tool } from "./registry.ts";

const Params = z.object({ account: z.string().min(1).describe("Conta de nuvem a auditar") });

export function createAuditCloudInventoryTool(d: { prices: CloudPrices }): Tool<z.infer<typeof Params>> {
  return {
    name: "audit_cloud_inventory",
    description: "Use para achar recursos ociosos (volume sem anexo, IP sem associação, instância com CPU baixa) e a economia mensal calculada de cada um.",
    paramsSchema: Params,
    run({ account }, { scenario, world, now }) {
      const inv = world.inventory ?? scenario.inventory;
      if (!inv || inv.account !== account) return { ok: false, summary: `conta sem dados neste cenário: ${account}`, evidenceRef: null };
      const { findings, totalMonthlySavingsUsd } = auditInventory(inv, d.prices);
      const evidenceRef = `inventory:${account}@${now.toISOString().slice(0, 10)}`;
      if (findings.length === 0) {
        return { ok: true, summary: `nenhum recurso ocioso na conta ${account} (${inv.region}).`, evidenceRef, data: { findings, totalMonthlySavingsUsd } };
      }
      const parts = findings.map((f) => `${f.target}: ${f.detail}`);
      return {
        ok: true,
        summary:
          `${findings.length} achado(s) na conta ${account} (${inv.region}), economia potencial de ${formatUsd(totalMonthlySavingsUsd)} por mês ` +
          `(preços ilustrativos ${d.prices.version}). ${parts.join("; ")}. Cofres de backup não entram como achado.`,
        evidenceRef,
        data: { findings, totalMonthlySavingsUsd },
      };
    },
  };
}
