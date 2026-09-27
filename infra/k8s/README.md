# Kubernetes

`base/` is the deployable shape of the system, with the reasoning for each non-obvious setting in
comments beside it. It is not a running cluster definition: the datastores here are sketched rather
than fully specified, because in practice Postgres, Kafka and Redis at this scale come from managed
services or dedicated operators, not from hand-written StatefulSets.

| File | What it covers |
| --- | --- |
| `api.yaml` | Stateless API, HPA on in-flight requests, PDB, graceful drain |
| `worker.yaml` | Aggregation and comment pipelines, scaled on **consumer lag** rather than CPU |
| `ingestor.yaml` | Polls government and news sources; **exactly one replica**, because politeness is per host |
| `config.yaml` | Tunables that must be changeable without a redeploy, plus the secret contract |
| `networkpolicy.yaml` | Default deny; the API has **no** route to the identity vault, and the ingestor — which parses hostile HTML from the open web — reaches nothing inside the cluster but the catalogue |
| `clickhouse.yaml` | Analytical store with the tiered hot/cold storage policy |

## Things worth knowing before deploying this

- **The HPA scales on in-flight requests, not CPU alone.** Civic attention spikes ~100× in minutes
  (docs/SCALING.md §1); CPU is a lagging signal and the fleet would arrive after the spike.
- **The worker uses `Recreate`, not `RollingUpdate`.** Two generations of consumers in one group
  cause a rebalance storm, and a rebalance mid-batch is redelivery the dedupe layer must absorb.
- **Liveness is `/healthz`, readiness is `/readyz`.** If liveness checked dependencies, a Redis blip
  would restart the entire fleet at the moment Redis came back.
- **CPU has no limit on the API.** Throttling a latency-sensitive write path turns a load spike into
  a timeout cascade. Memory is limited; CPU is requested.
- **Secrets are a contract, not values.** `CIVIC_PSEUDONYM_SALT_ROOT` must be KMS-held and must never
  live beside the analytics data, or per-topic pseudonyms protect nothing.
