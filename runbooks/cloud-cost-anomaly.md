---
id: cloud-cost-anomaly
title: Cloud cost anomaly
service: [*]
category: [cost_anomaly]
---

## Symptoms

The account's daily cost climbs well over its recent average with no matching growth in usage. The projected monthly cost goes over the budget.

## Diagnosis

Audit the account inventory for idle resources: a volume unattached for several days, an idle public IP with no association, and an idle, underused instance with low average CPU for two weeks. Compute the monthly savings of each finding with the current price table. Backup vaults and recovery points are not waste: they depend on the retention policy.

## Mitigation

Before deleting an unattached volume, create a snapshot of it so the deletion can be undone. Release the idle IP and resize the idle instance to a smaller type of the same family. Volume deletion, IP release and resizing require human approval. Never delete backups to cut cost.

## Prevention

Tag resources with an owner and a review date. Run the inventory audit every week and alert when the daily cost exceeds the average by more than 20%.
