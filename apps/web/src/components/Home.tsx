import { useEffect, useState } from 'react';
import type { JobsSummary, TrendingItem } from '@civic-voice/sdk';
import { client } from '../api.ts';
import { count, KIND_LABELS } from '../format.ts';
import { DocumentList } from './Documents.tsx';
import { LocationConfirm } from './LocationConfirm.tsx';

/**
 * Near me: what people where you live are discussing, the orders and projects that concern your
 * area, and how many government jobs are open to you.
 */
export function Home({
  regionId,
  regionPath,
  regionName,
  regionBasis,
  onOpenTopic,
  onRegionConfirmed,
  onGo,
}: {
  regionId: number;
  regionPath: number[];
  regionName: string;
  regionBasis: 'declared' | 'device' | null;
  onOpenTopic: (topicId: number) => void;
  onRegionConfirmed: (
    region: { id: number; path: number[]; name: string },
    basis: 'device',
  ) => void;
  onGo: (tab: 'jobs' | 'discuss') => void;
}) {
  const [local, setLocal] = useState<TrendingItem[] | null>(null);
  const [national, setNational] = useState<TrendingItem[]>([]);
  const [jobs, setJobs] = useState<JobsSummary | null>(null);
  const [locMessage, setLocMessage] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        // Trending is kept per region; a topic counts in every region on its own jurisdiction path. So
        // "near me" merges the lists for each level I live in and keeps what applies to me.
        const lists = await Promise.all(
          regionPath.map((id) => client.trending(id, 20).then((r) => r.items)),
        );
        const merged = new Map<number, TrendingItem>();
        for (const item of lists.flat()) {
          if (!regionPath.includes(item.jurisdiction_region_id)) continue;
          const seen = merged.get(item.topic_id);
          if (!seen || seen.score < item.score) merged.set(item.topic_id, item);
        }
        setLocal([...merged.values()].sort((a, b) => b.score - a.score).slice(0, 8));
        setNational((lists[0] ?? []).slice(0, 5));
      } catch {
        setLocal([]);
      }
      try {
        setJobs(await client.jobs(regionId));
      } catch {
        setJobs(null);
      }
    })();
  }, [regionId, regionPath.join(',')]);

  const Trending = ({ items }: { items: TrendingItem[] }) => (
    <div>
      {items.map((t) => (
        <button key={t.topic_id} className="list-item" onClick={() => onOpenTopic(t.topic_id)}>
          <div className="title">{t.title}</div>
          <div className="sub">
            <span className="badge">{KIND_LABELS[t.kind] ?? t.kind}</span> {t.jurisdiction_name} ·{' '}
            {t.comments_24h} comment{t.comments_24h === 1 ? '' : 's'} today
          </div>
        </button>
      ))}
    </div>
  );

  return (
    <>
      {regionBasis === 'declared' && (
        <section className="card">
          <h2>Confirm where you live</h2>
          <p className="meta">
            Local discussions are for local residents. Confirming your area from your device marks
            your comments “📍 located”, so others know you are really from {regionName}.
          </p>
          <LocationConfirm
            confirmLabel="Yes, this is home"
            onConfirmed={async (region, attestation) => {
              try {
                if (region.id === regionId) {
                  await client.updateProfile({ location_attestation: attestation });
                } else {
                  await client.updateProfile({
                    region_id: region.id,
                    location_attestation: attestation,
                  });
                }
                onRegionConfirmed(
                  { id: region.id, path: region.path, name: region.name },
                  'device',
                );
                setLocMessage(`Home set to ${region.name}, confirmed by location.`);
              } catch {
                setLocMessage('Could not update your area. Please try again.');
              }
            }}
          />
        </section>
      )}
      {locMessage && <p className="notice">{locMessage}</p>}

      <section className="card">
        <h2>Hot topics where you live</h2>
        <p className="meta">
          What residents of {regionName} and above are discussing in the last 24 hours.
        </p>
        {local === null ? (
          <p className="suppressed">Loading…</p>
        ) : local.length === 0 ? (
          <p className="suppressed">
            Nothing is being discussed yet.{' '}
            <button className="link" onClick={() => onGo('discuss')}>
              Start with a topic or raise an issue →
            </button>
          </p>
        ) : (
          <Trending items={local} />
        )}
      </section>

      {jobs && (
        <section className="card">
          <h2>Government jobs open to you</h2>
          <div className="stat-row">
            <div className="stat">
              <div className="big">{count(jobs.open_notifications)}</div>
              <div className="k">open notifications</div>
            </div>
            <div className="stat">
              <div className="big">{count(jobs.stated_vacancies)}+</div>
              <div className="k">posts stated</div>
            </div>
            <div className="stat">
              <div className="big">{count(jobs.closing_within_7_days)}</div>
              <div className="k">closing this week</div>
            </div>
          </div>
          <button className="link" onClick={() => onGo('jobs')}>
            See all notifications →
          </button>
        </section>
      )}

      <section className="card">
        <h2>New orders and projects for your area</h2>
        <p className="meta">
          Government orders, projects, schemes and gazette notifications that concern {regionName}.
        </p>
        <DocumentList
          regionId={regionId}
          kinds={['government_order', 'project', 'scheme', 'gazette_notification']}
          limit={6}
          onOpenTopic={onOpenTopic}
        />
      </section>

      {national.length > 0 && (
        <section className="card">
          <h2>Across India</h2>
          <p className="meta">
            Trending nationally. You can read every discussion; you can join those that apply to
            you.
          </p>
          <Trending items={national} />
        </section>
      )}
    </>
  );
}
