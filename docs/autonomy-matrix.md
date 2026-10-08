# Autonomy Matrix

> File generated from `src/domain/autonomy/catalog.ts` by `node scripts/gen-autonomy-doc.ts` (also runs in `npm run regen`). Do not edit by hand: the `docs-matrix.unit.test.ts` test fails if this file diverges from the catalog.

The tier of each step comes from the catalog and from context rules that only raise the tier, never lower it. The model output has no tier field.

## Tiers

| Tier | Rule | What belongs here |
|---|---|---|
| Tier 1: decides alone | Read-only, zero risk | Tools `query_metrics`, `query_logs`, `list_deploys`, `audit_cloud_inventory` |
| Tier 2: decides and records | Reversible change or no effect on the service, with audit | `add_incident_note`, `block_image_tag`, `tag_resource_for_review`, `create_volume_snapshot` |
| Tier 3: requires human approval | Destructive or high impact | `rollback_deployment`, `release_elastic_ip`, `delete_volume`, `resize_instance` |
| Tier 4: forbidden by construction | Exposing data, deleting audit or backup, disabling controls | `delete_audit_log`, `disable_security_scanner`, `export_user_data`, `run_arbitrary_command`, `delete_backups` and any type not in the catalog (deny by default) |

## Executable action catalog

| Tier | Type | Target | Parameters | Mitigates | Reversible | Simulated duration |
|---|---|---|---|---|---|---|
| 2 | `add_incident_note` | `incident/<incident service or account>` | `{ text: string }` | no | no | 1 s |
| 2 | `block_image_tag` | `image/<service>:<tag>` | `{}` | no | yes | 5 s |
| 2 | `tag_resource_for_review` | `<volume, ip or instance>/<account>/<id>` | `{ reason: string }` | no | yes | 2 s |
| 2 | `create_volume_snapshot` | `volume/<account>/<id>` | `{}` | no | yes | 30 s |
| 3 | `rollback_deployment` | `deployment/<service>` | `{ toVersion: string }` | yes | yes | 90 s |
| 3 | `release_elastic_ip` | `ip/<account>/<id>` | `{}` | yes | no | 5 s |
| 3 | `delete_volume` | `volume/<account>/<id>` | `{}` | yes | no | 20 s |
| 3 | `resize_instance` | `instance/<account>/<id>` | `{ toType: string }` | yes | yes | 300 s |

Parameters outside the catalog schema move the step to `rejected_invalid_params`, without a dry run.

## Context rules (raise to tier 3)

- target outside the incident scope: the target is neither the incident itself nor owned by the incident service or account (blast radius).
- step without a reference runbook: the step does not cite a runbook passage (null `runbookRef`).
- plan revisions exhausted: the plan reached the remediation gate with the auditor revisions exhausted and a final `revise` verdict.

## Tier 4 by construction

1. The executor registry is typed by `ExecutableActionType`, and the forbidden types do not belong to it: no code exists that executes them.
2. `classifyAction` returns tier 4 for forbidden and unknown types, and the remediation gate blocks them without a dry run and without an approval queue.
3. The `audit_log` table has triggers that abort `UPDATE` and `DELETE`, and the store has no delete method.
