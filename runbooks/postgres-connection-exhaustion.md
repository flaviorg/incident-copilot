---
id: postgres-connection-exhaustion
title: Postgres connection exhaustion
service: [orders-api, payments-api]
category: [dependency_failure, capacity]
---

## Symptoms

Intermittent 5xx errors and high latency in services that depend on Postgres. The logs show timeouts while acquiring a connection from the pool or refusals due to too many connections. Pool usage stays close to the configured maximum.

## Diagnosis

Check the number of active connections in the database and the maximum pool size of each service. See whether slow queries are holding connections or whether an increase in replicas multiplied the connections without a pool adjustment. If the problem started together with a change, review the pool configuration in that change.

## Mitigation

Shrink the pool per replica or put a connection pooler in front of the database. Kill stuck queries that hold connections for a long time. Scale the database only after confirming that the bottleneck is capacity.

## Prevention

Monitor pool usage and alert above 80%. Set query and connection-acquisition timeouts. Run load tests with the real number of production replicas.
