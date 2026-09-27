/**
 * A dependency-free Prometheus-text-format registry.
 *
 * Deliberately small: counters, gauges and histograms with explicit buckets. The alternative was
 * another runtime dependency on the hot path of a service that must hold a 1.5ms CPU budget per
 * write, for features we do not use.
 */

type Labels = Record<string, string | number>;

function labelKey(labels: Labels | undefined): string {
  if (!labels) return '';
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`).join(',');
}

interface Series {
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  values: Map<string, number>;
  /** histogram only */
  buckets?: number[];
  bucketCounts?: Map<string, number[]>;
  sums?: Map<string, number>;
}

export class Metrics {
  private readonly series = new Map<string, Series>();

  counter(name: string, help: string): void {
    this.ensure(name, help, 'counter');
  }

  gauge(name: string, help: string): void {
    this.ensure(name, help, 'gauge');
  }

  histogram(name: string, help: string, buckets: number[]): void {
    const s = this.ensure(name, help, 'histogram');
    s.buckets = [...buckets].sort((a, b) => a - b);
    s.bucketCounts ??= new Map();
    s.sums ??= new Map();
  }

  inc(name: string, labels?: Labels, by = 1): void {
    const s = this.series.get(name);
    if (!s) return;
    const k = labelKey(labels);
    s.values.set(k, (s.values.get(k) ?? 0) + by);
  }

  set(name: string, value: number, labels?: Labels): void {
    const s = this.series.get(name);
    if (!s) return;
    s.values.set(labelKey(labels), value);
  }

  observe(name: string, value: number, labels?: Labels): void {
    const s = this.series.get(name);
    if (!s || !s.buckets) return;
    const k = labelKey(labels);
    const counts = s.bucketCounts?.get(k) ?? new Array(s.buckets.length + 1).fill(0);
    let placed = false;
    for (let i = 0; i < s.buckets.length; i += 1) {
      if (value <= (s.buckets[i] as number)) {
        counts[i] = (counts[i] as number) + 1;
        placed = true;
        break;
      }
    }
    if (!placed) counts[s.buckets.length] = (counts[s.buckets.length] as number) + 1;
    s.bucketCounts?.set(k, counts);
    s.sums?.set(k, (s.sums.get(k) ?? 0) + value);
    s.values.set(k, (s.values.get(k) ?? 0) + 1);
  }

  /** Current value of a series, for tests and health checks. */
  read(name: string, labels?: Labels): number {
    return this.series.get(name)?.values.get(labelKey(labels)) ?? 0;
  }

  render(): string {
    const out: string[] = [];
    for (const [name, s] of this.series) {
      out.push(`# HELP ${name} ${s.help}`, `# TYPE ${name} ${s.type}`);
      if (s.type === 'histogram' && s.buckets) {
        for (const [k, counts] of s.bucketCounts ?? []) {
          let cumulative = 0;
          for (let i = 0; i < s.buckets.length; i += 1) {
            cumulative += counts[i] as number;
            out.push(`${name}_bucket{${join(k, `le="${s.buckets[i]}"`)}} ${cumulative}`);
          }
          cumulative += counts[s.buckets.length] as number;
          out.push(`${name}_bucket{${join(k, 'le="+Inf"')}} ${cumulative}`);
          out.push(`${name}_sum${wrap(k)} ${s.sums?.get(k) ?? 0}`);
          out.push(`${name}_count${wrap(k)} ${cumulative}`);
        }
      } else {
        for (const [k, v] of s.values) out.push(`${name}${wrap(k)} ${v}`);
      }
    }
    return `${out.join('\n')}\n`;
  }

  private ensure(name: string, help: string, type: Series['type']): Series {
    const existing = this.series.get(name);
    if (existing) return existing;
    const s: Series = { help, type, values: new Map() };
    this.series.set(name, s);
    return s;
  }
}

const join = (labels: string, extra: string) => (labels ? `${labels},${extra}` : extra);
const wrap = (labels: string) => (labels ? `{${labels}}` : '');

/** Latency buckets in milliseconds, chosen to bracket the budgets in docs/SCALING.md §8. */
export const LATENCY_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 150, 250, 500, 1_000, 2_500, 5_000];

export function createMetrics(): Metrics {
  const m = new Metrics();
  m.counter('civic_http_requests_total', 'HTTP requests by route, method and status');
  m.histogram('civic_http_duration_ms', 'HTTP handler duration', LATENCY_BUCKETS_MS);
  m.counter('civic_sentiment_writes_total', 'Accepted sentiment submissions');
  m.counter('civic_sentiment_replayed_total', 'Submissions served from the idempotency record');
  m.counter('civic_quota_rejections_total', 'Writes rejected by quota or cooldown');
  m.counter('civic_degraded_total', 'Requests served in a degraded mode, by component');
  m.counter('civic_events_consumed_total', 'Events consumed by the worker');
  m.counter('civic_events_deduped_total', 'Redelivered events skipped as already applied');
  m.gauge('civic_consumer_lag_events', 'Events behind the head of the log, by partition');
  m.gauge('civic_rollup_staleness_seconds', 'Age of the newest applied rollup');
  m.counter('civic_anonymity_suppressions_total', 'Buckets withheld by the k-anonymity gate');
  m.counter('civic_rti_deadline_transitions_total', 'RTI requests advanced by the sweeper');
  m.histogram('civic_redis_pipeline_ms', 'Counter-store pipeline duration', LATENCY_BUCKETS_MS);
  return m;
}
