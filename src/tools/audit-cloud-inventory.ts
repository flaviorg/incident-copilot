import * as z from "zod";
import { auditInventory } from "../domain/finops/inventory-audit.ts";
import type { CloudPrices } from "../domain/finops/inventory-audit.ts";
import { formatUsd } from "./format.ts";
import type { Tool } from "./registry.ts";

const Params = z.object({ account: z.string().min(1).describe("Cloud account to audit") });

export function createAuditCloudInventoryTool(d: { prices: CloudPrices }): Tool<z.infer<typeof Params>> {
  return {
    name: "audit_cloud_inventory",
    description: "Use to find idle resources (unattached volume, unassociated IP, instance with low CPU) and the computed monthly savings for each one.",
    paramsSchema: Params,
    run({ account }, { scenario, world, now }) {
      const inv = world.inventory ?? scenario.inventory;
      if (!inv || inv.account !== account) return { ok: false, summary: `no data for this account in this scenario: ${account}`, evidenceRef: null };
      const { findings, totalMonthlySavingsUsd } = auditInventory(inv, d.prices);
      const evidenceRef = `inventory:${account}@${now.toISOString().slice(0, 10)}`;
      if (findings.length === 0) {
        return { ok: true, summary: `no idle resources in account ${account} (${inv.region}).`, evidenceRef, data: { findings, totalMonthlySavingsUsd } };
      }
      const parts = findings.map((f) => `${f.target}: ${f.detail}`);
      return {
        ok: true,
        summary:
          `${findings.length} ${findings.length === 1 ? "finding" : "findings"} in account ${account} (${inv.region}), potential savings of ${formatUsd(totalMonthlySavingsUsd)} per month ` +
          `(illustrative prices ${d.prices.version}). ${parts.join("; ")}. Backup vaults are not counted as findings.`,
        evidenceRef,
        data: { findings, totalMonthlySavingsUsd },
      };
    },
  };
}
