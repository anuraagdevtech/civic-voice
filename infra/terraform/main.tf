# Managed infrastructure — a sketch, not a deployable root module.
#
# It is here to record the *shape* and the sizing decisions that follow from docs/SCALING.md, so that
# whoever provisions this for real starts from the reasoning rather than from a blank file. Backend,
# providers, networking and IAM are deliberately left out: those belong to whoever owns the account,
# and guessing them would produce something that looks runnable and is not.

terraform {
  required_version = ">= 1.9"
}

variable "region" {
  description = "Primary region. ap-south-1 keeps data and latency in-country."
  type        = string
  default     = "ap-south-1"
}

variable "shard_clusters" {
  description = <<-EOT
    Number of physical Postgres clusters holding the 1024 logical vshards (ADR-0001).

    1024 is divisible by every power of two, so the fleet can grow 4 → 8 → … → 128 without ever
    remapping a vshard that is not moving. Start at 4. At 64 clusters each holds 16 vshards, roughly
    4.4 GB of citizen rows (docs/SCALING.md §4).
  EOT
  type        = number
  default     = 4

  validation {
    condition     = var.shard_clusters > 0 && 1024 % var.shard_clusters == 0
    error_message = "shard_clusters must divide 1024 evenly, or vshards cannot be distributed without remainder."
  }
}

locals {
  vshards_per_cluster = 1024 / var.shard_clusters

  # Sized from the capacity model, not from a round number. See packages/core/src/capacity.ts —
  # `pnpm loadtest` re-measures the inputs and fails if they have drifted.
  capacity = {
    spike_writes_per_second = 174000
    spike_reads_per_second  = 520000
    edge_hit_rate           = 0.98
    rollup_touches_per_write = 28
    redis_commands_per_touch = 2
  }

  origin_reads_per_second = local.capacity.spike_reads_per_second * (1 - local.capacity.edge_hit_rate)
  redis_commands_per_second = (
    local.capacity.spike_writes_per_second
    * local.capacity.rollup_touches_per_write
    * local.capacity.redis_commands_per_touch
  )
}

# ── Sharded OLTP ──
# Citizen-owned rows only, always queried by primary key (ADR-0001, ADR-0007). Each cluster is small
# because the 1.4B-row tables are only ever touched one row at a time.
module "postgres_shards" {
  source = "./modules/postgres-cluster"
  count  = var.shard_clusters

  name               = "civic-shard-${count.index}"
  vshards            = local.vshards_per_cluster
  instance_class     = "db.r6g.2xlarge"
  storage_gb         = 500
  # Synchronous standby in another AZ. A shard going down takes 1/N of citizens offline for their
  # OWN data; aggregates are unaffected, because nothing region-shaped is served from here.
  multi_az           = true
  read_replicas      = 1
  backup_retention_days = 35
}

# ── Catalogue ──
# ~10M rows of regions, topics, authorities, schemes and budget lines. Read-mostly and cacheable, so
# it is scaled with replicas rather than a bigger primary.
module "postgres_catalogue" {
  source = "./modules/postgres-cluster"

  name                  = "civic-catalogue"
  instance_class        = "db.r6g.xlarge"
  storage_gb            = 200
  multi_az              = true
  # One per availability zone: every API pod reads this, and it must never be a cross-AZ hop.
  read_replicas         = 3
  backup_retention_days = 35
}

# ── Identity vault ──
# Blind indexes only, in its own cluster with its own credentials and its own security group. The API
# has no network route to it at all (infra/k8s/base/networkpolicy.yaml) — verification runs as a
# separate workload, which is what keeps an RCE in the API away from it.
module "postgres_identity" {
  source = "./modules/postgres-cluster"

  name                  = "civic-identity"
  instance_class        = "db.r6g.large"
  storage_gb            = 200
  multi_az              = true
  read_replicas         = 0
  backup_retention_days = 35
  encryption_key_arn    = aws_kms_key.identity.arn
}

# ── Counters ──
# Disposable: everything here is rebuildable from ClickHouse, so a lost shard is an availability
# event and not data loss. 64 shards runs at ~15% utilisation at the modelled spike.
module "redis" {
  source = "./modules/redis-cluster"

  name       = "civic-counters"
  shards     = 64
  node_type  = "cache.r7g.xlarge"
  replicas_per_shard = 1
  # LRU rather than noeviction: under memory pressure, dropping a cold counter and rebuilding it from
  # ClickHouse is strictly better than refusing writes.
  maxmemory_policy = "allkeys-lru"

  # Recorded so the sizing can be re-derived rather than taken on trust.
  expected_commands_per_second = local.redis_commands_per_second
}

# ── Event log ──
# The write path's commit point (ADR-0003). Partitioned by topic_id so one topic's deltas land on one
# partition and the consumer can aggregate without cross-partition coordination.
module "kafka" {
  source = "./modules/kafka-cluster"

  name              = "civic-events"
  broker_count      = 12
  instance_type     = "kafka.m7g.2xlarge"
  storage_gb        = 6000
  partitions        = 256
  replication_factor = 3
  min_insync_replicas = 2
  retention_hours   = 168 # 7 days hot; Parquet in object storage after that
}

# ── Analytics ──
module "clickhouse" {
  source = "./modules/clickhouse-cluster"

  name          = "civic-analytics"
  shards        = 4
  replicas      = 2
  instance_type = "m7g.4xlarge"
  hot_storage_gb = 2000
  cold_bucket   = aws_s3_bucket.cold.id
}

# ── Edge ──
# The single most important cost and capacity lever: at a 98% hit rate the origin sees ~10k reads/s
# instead of 520k. It works only because aggregate URLs are deliberately low-cardinality.
module "cdn" {
  source = "./modules/cdn"

  name                = "civic-edge"
  origin              = module.api_ingress.hostname
  default_ttl_seconds = 30
  # Serve stale instantly and refresh behind the request, so an expiring entry never becomes an
  # origin stampede.
  stale_while_revalidate_seconds = 120
  # Static assets are content-hashed, so they can be immutable for a year.
  static_ttl_seconds  = 31536000
  waf_enabled         = true

  expected_origin_requests_per_second = local.origin_reads_per_second
}

# ── Keys ──
resource "aws_kms_key" "identity" {
  description         = "Pepper for identity blind indexes. Rotation re-blinds rather than re-collects."
  enable_key_rotation = false # Rotation here is a re-blinding migration, not an automatic operation.
}

resource "aws_kms_key" "pseudonym" {
  description = <<-EOT
    Root for per-topic pseudonym salts (docs/PRIVACY.md §2).

    This key must never be held in the same account or role as the analytics data. The entire
    unlinkability property is that reading ClickHouse does not get you the salts.
  EOT
  enable_key_rotation = false
}

resource "aws_kms_key" "citizen_dek" {
  description         = "Wraps per-citizen data-encryption keys. Erasure destroys the DEK (ADR-0004)."
  enable_key_rotation = true
}

resource "aws_s3_bucket" "cold" {
  bucket = "civic-voice-cold"
}

resource "aws_s3_bucket" "disclosures" {
  bucket = "civic-voice-disclosures" # RTI response documents, content-addressed by sha256
}

output "sizing_summary" {
  description = "The derived figures behind the resource sizes above."
  value = {
    shard_clusters            = var.shard_clusters
    vshards_per_cluster       = local.vshards_per_cluster
    origin_reads_per_second   = local.origin_reads_per_second
    redis_commands_per_second = local.redis_commands_per_second
  }
}
