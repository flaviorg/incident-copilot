# Full terminal demo output

Real output of both scenarios, copied from the terminal. The demo runs offline with the scripted fake provider and forces the fake even if the shell has `OPENROUTER_API_KEY` (only `--live` uses the real model). The clock is simulated, so the times and the MTTR repeat on every run. Summary and context in the [README](../README.md#quick-start).

## Scenario `deploy-5xx-rollback` (default)

```text
$ npm run demo
incident-copilot · demo · provider: scripted fake (no network, no key)
scenario deploy-5xx-rollback · service orders-api · sev1

09:42:30  INC-0001 opened: "5xx rate above 5% in orders-api" (impact since 09:40:30)
09:42:50  supervisor → telemetry analyst: Correlate orders-api 5xx errors and latency with the v3.8.0 deploy
09:43:10    think I need to confirm the size of the 5xx spike and when it started.
09:43:10    act   query_metrics(orders-api, http_5xx_rate, 30m) · tier 1
09:43:13    obs   http_5xx_rate of orders-api over 30m (09:13:10–09:43:10 UTC, 60 samples): start 0.2%, peak 9.9% at 09:40:30, last 9.3%, mean 1.3%. First sample above the alert threshold (5.0%) at 09:40:30.
09:43:33    think The spike started around 09:40; I will check whether orders-api had a recent deploy.
09:43:33    act   list_deploys(orders-api) · tier 1
09:43:36    obs   1 deploy of orders-api in the last 7 days, most recent first: v3.8.0 at 10/04 09:40 UTC, 4 min ago (previous v3.7.2, 6 replicas). Version running now: v3.8.0 (6 replicas).
09:43:56    think v3.8.0 was deployed at 09:40. I will group the errors from the last 15 minutes by message and version.
09:43:56    act   query_logs(orders-api, ERROR, 15m) · tier 1
09:43:59    obs   380 ERROR lines for orders-api over 15m, 1 group; most frequent: [380x, versions v3.8.0, since 09:40:40] TypeError: Cannot read properties of undefined (reading 'currency') at PriceFormatter.format
09:44:19    think The 5xx errors started together with the v3.8.0 rollout and the only frequent error exists only in that version. The evidence points to a bad deploy.
09:44:19  telemetry analyst: diagnosis bad_deploy (faulty deploy, high confidence, 3 pieces of evidence): The orders-api v3.8.0 deploy introduced a TypeError in PriceFormatter.format when reading currency from prices with no currency set; the 5xx errors started together with the rollout.
09:44:19  telemetry analyst → supervisor: diagnosis bad_deploy (faulty deploy, high confidence, 3 pieces of evidence)
09:44:39  supervisor → runbook retriever: Search for runbooks on 5xx errors after a deploy in orders-api
09:44:39    act   search_runbooks(5xx above 5% for 2 min The orders-api v3.8.0 deploy introduced a TypeError in PriceFormatter.format when reading currency from prices with no currency set; the…) · tier 1
09:44:39    obs   orders-5xx-after-deploy@21828c §mitigation (normalized score 0.09); orders-5xx-after-deploy@21828c §diagnosis (normalized score 0.08); orders-5xx-after-deploy@21828c §symptoms (normalized score 0.08)
09:44:39  runbook retriever → supervisor: 3 runbook passages: orders-5xx-after-deploy#mitigation, orders-5xx-after-deploy#diagnosis, orders-5xx-after-deploy#symptoms
09:44:59  supervisor → remediation planner: Build the remediation plan from the 5xx-after-deploy runbook
09:45:19  remediation planner: plan revision 0 with 3 steps: Roll orders-api back to v3.7.2, record the reason in the incident and block the 3.8.0 image so it is not promoted again.
09:45:19  remediation planner → auditor: plan revision 0 with 3 steps
09:45:39  auditor: approved (Plan consistent with the diagnosis: rollback to the version before the deploy, a note in the incident and the tag block only after the rollback.)
09:45:39  auditor → supervisor: plan revision 0 approved (5 of 5 rules ok)
09:45:59  supervisor → remediation gate: Assess the risk of each step of the audited plan
09:46:05    act   add_incident_note(incident/orders-api, orders-api rollback from v3.8.0 to v3.7.2: TypeError in PriceFormatter.format after the deploy.) · tier 2
09:46:05    obs   add_incident_note tier 2: dry run ok (incident/orders-api: note recorded) → ready, runs after the decisions
09:46:05    act   rollback_deployment(deployment/orders-api, v3.7.2) · tier 3
09:46:05    obs   rollback_deployment tier 3: dry run ok (deployment/orders-api: v3.8.0 -> v3.7.2 (6 replicas)) → awaiting APR-0001
09:46:05    act   block_image_tag(image/orders-api:3.8.0) · tier 2
09:46:05    obs   block_image_tag tier 2: dry run ok (image/orders-api:3.8.0: tag blocked from promotion) → ready, runs after the decisions, depends on step 2
09:46:05  remediation gate → human: awaiting approval of APR-0001
09:49:05  demo operator approved APR-0001 (token verified, value omitted)
09:49:05  human → executor: decisions recorded: 1 approved, 0 rejected, 0 expired
09:49:05    act   add_incident_note(incident/orders-api, orders-api rollback from v3.8.0 to v3.7.2: TypeError in PriceFormatter.format after the deploy.) · tier 2
09:49:06    obs   add_incident_note: incident/orders-api: note recorded
09:49:06    act   rollback_deployment(deployment/orders-api, v3.7.2) · tier 3
09:50:36    obs   rollback_deployment: deployment/orders-api: v3.8.0 -> v3.7.2 (6 replicas)
09:50:36    act   block_image_tag(image/orders-api:3.8.0) · tier 2
09:50:41    obs   block_image_tag: image/orders-api:3.8.0: tag blocked from promotion
09:51:41  canary: approved (healthy canary: 5xx 0.5% ≤ 5%; P99 205 ms ≤ 270 ms)
09:51:41  verifier → supervisor: healthy canary; incident mitigated
09:52:01  supervisor → reporter: Write the post-mortem of the resolved incident
09:52:21  reporter: The orders-api v3.8.0 deploy introduced a TypeError in PriceFormatter.format and the 5xx rate crossed the threshold right after the rollout. The incident was detected in 2 min and resolved with a human-approved rollback to v3.7.2; MTTR was 11.2 min, of which …

outcome: resolved (healthy canary)

MTTR                    11.2 min        measured (simulated timeline, 09:40:30 → 09:51:41)
  awaiting approval     3.0 min         measured (sum of decided approvals)
MTTD                    2.0 min         measured
Minutes saved           33.8 to 83.8    illustrative (synthetic baseline of 45 to 95 min)
ROI                     18.9x to 48.2x  illustrative (assumptions in data/business-assumptions.json)
LLM cost                US$ 0.00        measured (12 calls, 13956 tokens)

trace 41 events (thought 4 · action 10 · observation 10 · plan 1 · critique 2 · answer 2 · handoff 12)
post-mortem: reports/INC-0001-postmortem.md
```

## Scenario `cost-anomaly`

It shows Reflection (the auditor sends revision 0 back because of the rule in code `snapshot_before_delete`), the tier 4 `delete_backups` blocked without a dry run, and the three tier 3 approvals.

```text
$ npm run demo -- --scenario cost-anomaly
incident-copilot · demo · provider: scripted fake (no network, no key)
scenario cost-anomaly · account data-platform · sev3

08:00:00  INC-0001 opened: "Daily cost 41% above average in the data-platform account" (impact since 08:00:00)
08:00:20  supervisor → telemetry analyst: Audit the data-platform account inventory and confirm when the daily cost went up
08:00:40    think Cost went up without higher usage; I start by auditing the account inventory for idle resources.
08:00:40    act   audit_cloud_inventory(data-platform) · tier 1
08:00:43    obs   3 findings in account data-platform (us-east-1), potential savings of US$ 339.59 per month (illustrative prices 2026-10-04). volume/data-platform/vol-0c41d2: gp3 volume of 750 GB unattached for 23 days costs US$ 60.00 p…
08:01:03    think I will check the daily cost over the last 7 days to confirm when the increase started.
08:01:03    act   query_metrics(data-platform, daily_cost_usd, 7d) · tier 1
08:01:06    obs   daily_cost_usd of data-platform over 7d (09/27 08:01–10/04 08:01 UTC, 168 samples): start US$ 16.40, peak US$ 23.10 at 10/03 08:00, last US$ 23.10, mean US$ 17.40.
08:01:26    think The daily cost increase coincides with idle resources shown by the inventory; there is no sign of higher usage.
08:01:26  telemetry analyst: diagnosis cost_anomaly (cost anomaly, high confidence, 2 pieces of evidence): Idle resources in the data-platform account (unattached gp3 volume, unassociated public IPv4 and underused r6i.2xlarge instance) explain the daily cost increase.
08:01:26  telemetry analyst → supervisor: diagnosis cost_anomaly (cost anomaly, high confidence, 2 pieces of evidence)
08:01:46  supervisor → runbook retriever: Search for cost anomaly runbooks for the data-platform account
08:01:46    act   search_runbooks(daily cost 41% above the 7-day average Idle resources in the data-platform account (unattached gp3 volume, unassociated public IPv4 and underused r6i.2xlarge i…) · tier 1
08:01:46    obs   cloud-cost-anomaly@f2635e §diagnosis (normalized score 0.09); cloud-cost-anomaly@f2635e §mitigation (normalized score 0.08)
08:01:46  runbook retriever → supervisor: 2 runbook passages: cloud-cost-anomaly#diagnosis, cloud-cost-anomaly#mitigation
08:02:06  supervisor → remediation planner: Plan the removal of the idle resources found by the inventory
08:02:26  remediation planner: plan revision 0 with 5 steps: Cut the idle cost of the data-platform account: tag and delete the unattached volume, release the idle IPv4, resize the underused instance and delete old backu…
08:02:26  remediation planner → auditor: plan revision 0 with 5 steps
08:02:46  auditor: asks for revision (A snapshot of volume vol-0c41d2 is missing before the deletion: add create_volume_snapshot and make delete_volume depend on it. | failed rules: snapshot_before_delete)
08:02:46  auditor → remediation planner: revise the plan: A snapshot of volume vol-0c41d2 is missing before the deletion: add create_volume_snapshot and make delete_volume depend on it. | failed rules: snapshot_before_delete
08:03:06  remediation planner: plan revision 1 with 6 steps: Cut the idle cost of the data-platform account with a snapshot of the volume before deletion, release of the idle IPv4, resize of the underused instance and cl…
08:03:06  remediation planner → auditor: plan revision 1 with 6 steps
08:03:26  auditor: approved (The snapshot comes before the deletion and the other steps follow the inventory findings.)
08:03:26  auditor → supervisor: plan revision 1 approved (5 of 5 rules ok)
08:03:46  supervisor → remediation gate: Assess the risk of each step of the revised plan
08:03:56    act   tag_resource_for_review(volume/data-platform/vol-0c41d2, gp3 volume unattached for 23 days) · tier 2
08:03:56    obs   tag_resource_for_review tier 2: dry run ok (volume/data-platform/vol-0c41d2: tagged for review (gp3 volume unattached for 23 days)) → ready, runs after the decisions
08:03:56    act   create_volume_snapshot(volume/data-platform/vol-0c41d2) · tier 2
08:03:56    obs   create_volume_snapshot tier 2: dry run ok (volume/data-platform/vol-0c41d2: snapshot of 750 GB created) → ready, runs after the decisions
08:03:56    act   delete_volume(volume/data-platform/vol-0c41d2) · tier 3
08:03:56    obs   delete_volume tier 3: dry run ok (volume/data-platform/vol-0c41d2: gp3 volume of 750 GB deleted), depends on step 2 → awaiting APR-0001
08:03:56    act   release_elastic_ip(ip/data-platform/eipalloc-0f19) · tier 3
08:03:56    obs   release_elastic_ip tier 3: dry run ok (ip/data-platform/eipalloc-0f19: public IPv4 released) → awaiting APR-0002
08:03:56    act   resize_instance(instance/data-platform/i-07ab3, r6i.large) · tier 3
08:03:56    obs   resize_instance tier 3: dry run ok (instance/data-platform/i-07ab3: r6i.2xlarge -> r6i.large) → awaiting APR-0003
08:03:56    act   delete_backups(backup_vault/data-platform/data-platform-prod) · tier 4
08:03:56    obs   delete_backups tier 4: blocked without dry run (forbidden by construction (tier 4))
08:03:56  gate: blocked (delete_backups on backup_vault/data-platform/data-platform-prod: forbidden by construction (tier 4))
08:03:56  remediation gate → human: awaiting approval of APR-0001, APR-0002, APR-0003
08:06:56  demo operator approved APR-0001 (token verified, value omitted)
08:09:56  demo operator approved APR-0002 (token verified, value omitted)
08:12:56  demo operator approved APR-0003 (token verified, value omitted)
08:12:56  human → executor: decisions recorded: 3 approved, 0 rejected, 0 expired
08:12:56    act   tag_resource_for_review(volume/data-platform/vol-0c41d2, gp3 volume unattached for 23 days) · tier 2
08:12:58    obs   tag_resource_for_review: volume/data-platform/vol-0c41d2: tagged for review (gp3 volume unattached for 23 days)
08:12:58    act   create_volume_snapshot(volume/data-platform/vol-0c41d2) · tier 2
08:13:28    obs   create_volume_snapshot: volume/data-platform/vol-0c41d2: snapshot of 750 GB created
08:13:28    act   delete_volume(volume/data-platform/vol-0c41d2) · tier 3
08:13:48    obs   delete_volume: volume/data-platform/vol-0c41d2: gp3 volume of 750 GB deleted
08:13:48    act   release_elastic_ip(ip/data-platform/eipalloc-0f19) · tier 3
08:13:53    obs   release_elastic_ip: ip/data-platform/eipalloc-0f19: public IPv4 released
08:13:53    act   resize_instance(instance/data-platform/i-07ab3, r6i.large) · tier 3
08:18:53    obs   resize_instance: instance/data-platform/i-07ab3: r6i.2xlarge -> r6i.large
08:19:53  canary: approved (healthy canary: projected monthly cost US$ 356.94 ≤ US$ 600.00)
08:19:53  verifier → supervisor: healthy canary; incident mitigated
08:20:13  supervisor → reporter: Write the post-mortem with the monthly savings of the executed actions
08:20:33  reporter: Idle resources in the data-platform account raised the daily cost. With human approval, the unattached volume was deleted after a snapshot, the idle IPv4 was released and the underused instance was resized; the monthly savings from the executed actions are US…

outcome: resolved (healthy canary)

MTTR                    19.9 min        measured (simulated timeline, 08:00:00 → 08:19:53)
  awaiting approval     18.0 min        measured (sum of decided approvals)
MTTD                    0.0 min         measured
Monthly savings         US$ 339.59      derived (inventory findings of executed actions)
Minutes saved           25.1 to 75.1    illustrative (synthetic baseline of 45 to 95 min)
ROI                     12.8x to 17.8x  illustrative (assumptions in data/business-assumptions.json)
LLM cost                US$ 0.00        measured (13 calls, 15531 tokens)

trace 53 events (thought 3 · action 14 · observation 14 · plan 2 · critique 4 · answer 2 · handoff 14)
post-mortem: reports/INC-0001-postmortem.md
```

## Variations

- `npm run demo -- --reject`: the operator rejects, the rollback is cancelled along with the step that depended on it, and the incident ends escalated with `mitigation_rejected`.
- `npm run demo -- --scenario cost-anomaly`: the FinOps scenario (above).
- `npm run demo -- --json`: only the final object.
- `npm run demo -- --persist`: writes to `data/incident-copilot.db`; the second run becomes `INC-0002`.
