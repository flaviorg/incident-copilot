---
id: generic-high-latency
title: High latency in any service
service: [*]
category: [capacity, dependency_failure, unknown]
---

## Symptoms

P99 latency rises well above the baseline, with or without more errors. Users report slowness and request queues grow.

## Diagnosis

Check the service's CPU, memory and thread saturation. Measure the latency of each dependency (database, queues, external APIs) to find where the time is spent. Compare the current throughput with that of normal days to tell a traffic peak apart from a regression.

## Mitigation

If it is a traffic peak, add replicas or enable caching for the most called routes. If a dependency is slow, apply a timeout and a circuit breaker to protect the service. If the regression is recent, consider undoing the last change.

## Prevention

Define a latency budget per route and alert when it is consumed too fast. Run periodic load tests and track dependency latency on dedicated dashboards.
