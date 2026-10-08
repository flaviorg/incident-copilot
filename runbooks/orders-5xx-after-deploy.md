---
id: orders-5xx-after-deploy
title: 5xx in orders-api right after a deploy
service: [orders-api]
category: [bad_deploy]
---

## Symptoms

The orders-api 5xx response rate goes above 5% a few minutes after a new deploy. P99 latency usually rises with it. The errors show up only on the replicas already running the new version; the previous version was stable.

## Diagnosis

Compare the start of the 5xx spike with the time of the latest orders-api deploy. Group the ERROR logs by message and check in which version each exception appears (for example, a TypeError in a formatter). If the error exists only in the new version and started together with the rollout, treat it as a bad deploy. If it also appears in the previous version, look for another cause before rolling back.

## Mitigation

Roll back the orders-api deployment to the previous stable version; it is a high-impact action and requires human approval. After the rollback, block the image tag of the faulty version so no pipeline promotes it again. Record a note in the incident with the rolled-back version and the reason. Watch the 5xx rate and P99 latency for a few minutes before closing.

## Prevention

Promote versions with a gradual rollout and an automatic canary before reaching all replicas. Cover with tests the paths that read optional fields (such as the currency of a price). Keep the previous version ready for a fast rollback and document who can approve it.
