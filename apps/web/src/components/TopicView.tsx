import { useEffect, useState } from 'react';
import type { MySentiment, Topic } from '@civic-voice/sdk';
import { client } from '../api.ts';
import { KIND_LABELS } from '../format.ts';
import { Comments } from './Comments.tsx';
import { DigestCard } from './Digest.tsx';
import { TopicCard } from './TopicCard.tsx';

/**
 * One topic: its mood, what people think of it, and the discussion. A GO or a news story arrives here
 * from the documents it was made from; a local issue from the resident who raised it.
 */
export function TopicView({
  topicId,
  citizenId,
  regionId,
  regionPath,
  mine,
  onBack,
  onSubmitted,
}: {
  topicId: number;
  citizenId: string | null;
  regionId: number | null;
  regionPath: number[];
  mine: MySentiment | undefined;
  onBack: () => void;
  onSubmitted: () => void;
}) {
  const [topic, setTopic] = useState<Topic | null>(null);
  const [jurisdiction, setJurisdiction] = useState<string | null>(null);
  const [activity, setActivity] = useState(0);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const t = await client.topic(topicId);
        setTopic(t);
        setJurisdiction((await client.region(t.jurisdiction_region_id)).name);
      } catch {
        setMissing(true);
      }
    })();
  }, [topicId]);

  if (missing) {
    return (
      <>
        <button className="link" onClick={onBack}>
          ← Back
        </button>
        <p className="suppressed">This topic is not available.</p>
      </>
    );
  }
  if (!topic) return <p className="suppressed">Loading…</p>;

  const isLocal = regionPath.includes(topic.jurisdiction_region_id);
  const source = topic.source_refs[0];

  return (
    <>
      <button className="link" onClick={onBack}>
        ← Back
      </button>
      <div className="chips" style={{ marginTop: 4 }}>
        <span className="badge">{KIND_LABELS[topic.kind] ?? topic.kind}</span>
        {jurisdiction && <span className="badge">{jurisdiction}</span>}
        {isLocal && <span className="badge local">applies to you</span>}
      </div>
      {source && (
        <p className="meta" style={{ margin: '4px 0 10px', fontSize: 13 }}>
          Source:{' '}
          <a href={source} target="_blank" rel="noreferrer noopener">
            {new URL(source).hostname}
          </a>
        </p>
      )}

      {isLocal ? (
        <TopicCard
          topic={topic}
          citizenId={citizenId}
          regionId={regionId}
          mine={mine}
          onSubmitted={onSubmitted}
        />
      ) : (
        <article className="card">
          <h2>{topic.title}</h2>
          {topic.summary && <p className="meta">{topic.summary}</p>}
        </article>
      )}

      <DigestCard topicId={topic.id} refreshKey={activity} />
      <Comments
        topicId={topic.id}
        isLocal={isLocal}
        jurisdictionName={jurisdiction}
        onActivity={() => setActivity((n) => n + 1)}
      />
    </>
  );
}
