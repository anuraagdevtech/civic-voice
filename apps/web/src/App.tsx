import { useCallback, useEffect, useState } from 'react';
import type { Authority, MySentiment, Topic } from '@civic-voice/sdk';
import { client, flushQueue, hasAccount, queueLength } from './api.ts';
import { RegionPicker } from './components/RegionPicker.tsx';
import { RtiPanel } from './components/RtiPanel.tsx';
import { TaxPanel } from './components/TaxPanel.tsx';
import { TopicCard } from './components/TopicCard.tsx';

type Tab = 'mood' | 'money' | 'rti';

const SESSION_KEY = 'civic.session';

interface Session {
  citizenId: string;
  regionId: number;
  regionPath: number[];
  regionName: string;
}

const readSession = (): Session | null => {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
};

export function App() {
  const [session, setSession] = useState<Session | null>(readSession);
  const [tab, setTab] = useState<Tab>('mood');
  const [topics, setTopics] = useState<Topic[]>([]);
  const [authorities, setAuthorities] = useState<Authority[]>([]);
  const [mine, setMine] = useState<MySentiment[]>([]);
  const [pending, setPending] = useState(queueLength());

  const refreshMine = useCallback(async () => {
    if (!hasAccount()) return;
    try {
      setMine((await client.mySentiment()).items);
    } catch {
      /* not fatal: the buttons simply will not show a current selection */
    }
    setPending(queueLength());
  }, []);

  useEffect(() => {
    void (async () => {
      if (!session) return;
      try {
        setTopics((await client.topics({ region_id: session.regionId, limit: 30 })).items);
      } catch {
        /* the empty state below covers this */
      }
      await refreshMine();
      const { sent } = await flushQueue();
      if (sent > 0) await refreshMine();
      setPending(queueLength());
    })();
  }, [session, refreshMine]);

  /**
   * The authority list for the RTI panel is drawn from the topics on screen — the bodies this citizen
   * actually has business with, rather than every public authority in the country. Each is fetched
   * once; the responses are edge-cached for an hour, so this costs nothing after the first visitor.
   */
  useEffect(() => {
    void (async () => {
      const ids = [
        ...new Set(topics.map((t) => t.authority_id).filter((id): id is number => id !== null)),
      ];
      const loaded = await Promise.all(
        ids.map(async (id) => {
          try {
            return await client.authority(id);
          } catch {
            return null;
          }
        }),
      );
      setAuthorities(loaded.filter((a): a is Authority => a !== null));
    })();
  }, [topics]);

  if (!session) {
    return (
      <div className="app">
        <Masthead />
        <RegionPicker
          onRegistered={(citizenId, region) => {
            const next = {
              citizenId,
              regionId: region.id,
              regionPath: region.path ?? [region.id],
              regionName: region.name,
            };
            try {
              localStorage.setItem(SESSION_KEY, JSON.stringify(next));
            } catch {
              /* ignore */
            }
            setSession(next);
          }}
        />
        <Fine />
      </div>
    );
  }

  return (
    <div className="app">
      <Masthead />

      {pending > 0 && (
        <p className="notice warn">
          {pending} response{pending === 1 ? '' : 's'} saved on this device, waiting to be sent.
        </p>
      )}

      <nav className="tabs">
        <button aria-current={tab === 'mood' ? 'page' : undefined} onClick={() => setTab('mood')}>
          Decisions
        </button>
        <button aria-current={tab === 'money' ? 'page' : undefined} onClick={() => setTab('money')}>
          Where the money went
        </button>
        <button aria-current={tab === 'rti' ? 'page' : undefined} onClick={() => setTab('rti')}>
          RTI requests
        </button>
      </nav>

      {tab === 'mood' &&
        (topics.length === 0 ? (
          <p className="suppressed">No decisions published for your area yet.</p>
        ) : (
          topics.map((topic) => (
            <TopicCard
              key={topic.id}
              topic={topic}
              citizenId={session.citizenId}
              regionId={session.regionId}
              mine={mine.find((m) => m.topic_id === topic.id)}
              onSubmitted={() => void refreshMine()}
            />
          ))
        ))}

      {tab === 'money' && <TaxPanel regionId={session.regionId} regionName={session.regionName} />}
      {tab === 'rti' && <RtiPanel authorities={authorities} />}

      <Fine />
    </div>
  );
}

function Masthead() {
  return (
    <header className="masthead">
      <h1>Civic Voice</h1>
      <p>
        Public sentiment on government decisions, the money actually spent, and the questions we got
        answered by asking.
      </p>
    </header>
  );
}

function Fine() {
  return (
    <footer className="fine">
      <p>
        <strong>What this is not.</strong> This is a sentiment platform, not an election system. It
        does not offer cryptographic receipts, end-to-end verifiability, or coercion resistance, and
        its figures are not a vote.
      </p>
      <p>
        <strong>What we hold.</strong> No name, no phone number, no government ID. Age, gender and
        similar details are stored as broad bands and only if you choose to give them. Any group of
        fewer than 25 people is withheld from every published figure. You can withdraw and have your
        record erased at any time; published totals are counts of at least 25 people and are not
        rewritten.
      </p>
    </footer>
  );
}
