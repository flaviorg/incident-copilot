// Auditoria de inventário FinOps (spec 7.3): achados e economia mensal calculados por código, nunca pelo LLM. Puro.
import type { Inventory } from "../../contracts/index.ts";

export type CloudPrices = {
  version: string;
  note: string;
  hoursPerMonth: number;
  volumeGbMonthUsd: Record<string, number>;
  publicIpv4HourUsd: number;
  instanceHourUsd: Record<string, number>;
};

export type InventoryFinding = {
  kind: "unattached_volume" | "unassociated_ip" | "oversized_instance";
  resourceId: string;
  target: string;
  monthlyCostUsd: number;
  monthlySavingsUsd: number;
  detail: string;
  recommendation: { actionType: "delete_volume" | "release_elastic_ip" | "resize_instance"; params: Record<string, unknown> };
};

/** CPU média de 14 dias até este valor indica instância ociosa. */
export const IDLE_CPU_MAX_PCT = 10;

export function roundUsd(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

const usd = (x: number) => `US$ ${x.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (x: number) => x.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

/** Volume sem anexo, IP sem associação e instância com CPU baixa viram achados. Cofres de backup nunca viram achado. */
export function auditInventory(inv: Inventory, prices: CloudPrices): { findings: InventoryFinding[]; totalMonthlySavingsUsd: number } {
  const findings: InventoryFinding[] = [];

  for (const v of inv.volumes) {
    if (v.attachedTo !== null) continue;
    const perGb = prices.volumeGbMonthUsd[v.type];
    if (perGb === undefined) continue;
    const cost = roundUsd(v.sizeGb * perGb);
    findings.push({
      kind: "unattached_volume",
      resourceId: v.id,
      target: `volume/${inv.account}/${v.id}`,
      monthlyCostUsd: cost,
      monthlySavingsUsd: cost,
      detail: `volume ${v.type} de ${num(v.sizeGb)} GB sem anexo há ${v.unattachedDays} dias custa ${usd(cost)} por mês`,
      recommendation: { actionType: "delete_volume", params: {} },
    });
  }

  for (const ip of inv.publicIps) {
    if (ip.associatedWith !== null) continue;
    const cost = roundUsd(prices.publicIpv4HourUsd * prices.hoursPerMonth);
    findings.push({
      kind: "unassociated_ip",
      resourceId: ip.id,
      target: `ip/${inv.account}/${ip.id}`,
      monthlyCostUsd: cost,
      monthlySavingsUsd: cost,
      detail: `IPv4 público ${ip.id} sem associação custa ${usd(cost)} por mês`,
      recommendation: { actionType: "release_elastic_ip", params: {} },
    });
  }

  for (const i of inv.instances) {
    if (i.avgCpuPct14d > IDLE_CPU_MAX_PCT) continue;
    const current = prices.instanceHourUsd[i.type];
    const family = i.type.split(".")[0];
    const toType = `${family}.large`;
    const smaller = prices.instanceHourUsd[toType];
    if (current === undefined || smaller === undefined || toType === i.type || smaller >= current) continue;
    const savings = roundUsd((current - smaller) * prices.hoursPerMonth);
    findings.push({
      kind: "oversized_instance",
      resourceId: i.id,
      target: `instance/${inv.account}/${i.id}`,
      monthlyCostUsd: roundUsd(current * prices.hoursPerMonth),
      monthlySavingsUsd: savings,
      detail: `instância ${i.type} (${i.role}) com CPU média de ${num(i.avgCpuPct14d)}% em 14 dias; ${toType} economiza ${usd(savings)} por mês`,
      recommendation: { actionType: "resize_instance", params: { toType } },
    });
  }

  const totalMonthlySavingsUsd = roundUsd(findings.reduce((acc, f) => acc + f.monthlySavingsUsd, 0));
  return { findings, totalMonthlySavingsUsd };
}

/** Custo mensal projetado do inventário: volumes (GB x preço), IPs ociosos, instâncias (preço por hora x horas) e cofres. */
export function projectedMonthlyCostUsd(inv: Inventory, prices: CloudPrices): number {
  const volumes = inv.volumes.reduce((acc, v) => acc + v.sizeGb * (prices.volumeGbMonthUsd[v.type] ?? 0), 0);
  const idleIps = inv.publicIps.filter((ip) => ip.associatedWith === null).length * prices.publicIpv4HourUsd * prices.hoursPerMonth;
  const instances = inv.instances.reduce((acc, i) => acc + (prices.instanceHourUsd[i.type] ?? 0) * prices.hoursPerMonth, 0);
  const vaults = inv.backupVaults.reduce((acc, b) => acc + b.monthlyCostUsd, 0);
  return roundUsd(volumes + idleIps + instances + vaults);
}
