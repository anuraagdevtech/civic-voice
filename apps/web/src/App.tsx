import { useCallback, useEffect, useState } from 'react';
import type { Authority, MySentiment, Topic } from '@civic-voice/sdk';
import { client, flushQueue, hasAccount, queueLength } from './api.ts';
import { Discuss } from './components/Discuss.tsx';
import { Economy } from './components/Economy.tsx';
import { Finance } from './components/Finance.tsx';
import { Home } from './components/Home.tsx';
import { Jobs } from './components/Jobs.tsx';
import { RegionPicker } from './components/RegionPicker.tsx';
import { RtiPanel } from './components/RtiPanel.tsx';
import { TaxPanel } from './components/TaxPanel.tsx';
import { TopicView } from './components/TopicView.tsx';
import { Voices } from './components/Voices.tsx';

type Tab = 'home' | 'discuss' | 'voices' | 'jobs' | 'money' | 'rti';

const TABS: Array<[Tab, string]> = [
  ['home', 'Near me'],
  ['discuss', 'Discuss'],
  ['voices', 'Youth & farmers'],
  ['jobs', 'Jobs'],
  ['money', 'Money'],
  ['rti', 'RTI'],
];

/** `#/topic/123` opens a discussion, so a topic can be shared as a link. */
const topicFromHash = (): number | null => {
  const m = /^#\/topic\/(\d+)$/.exec(typeof location === 'undefined' ? '' : location.hash);
  return m ? Number(m[1]) : null;
};

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
  const [tab, setTab] = useState<Tab>('home');
  const [openTopic, setOpenTopic] = useState<number | null>(topicFromHash);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [authorities, setAuthorities] = useState<Authority[]>([]);
  const [mine, setMine] = useState<MySentiment[]>([]);
  const [pending, setPending] = useState(queueLength());
  const [demo, setDemo] = useState(false);
  const [regionBasis, setRegionBasis] = useState<'declared' | 'device' | null>(null);
  const [regionNames, setRegionNames] = useState<Record<number, string>>({});

  useEffect(() => {
    void client
      .meta()
      .then((m) => setDemo(m.demo))
      .catch(() => {});
    const onHash = () => setOpenTopic(topicFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const open = (topicId: number | null) => {
    if (topicId === null) history.pushState(null, '', location.pathname);
    else location.hash = `#/topic/${topicId}`;
    setOpenTopic(topicId);
    window.scrollTo(0, 0);
  };

  useEffect(() => {
    void (async () => {
      if (!session || !hasAccount()) return;
      try {
        setRegionBasis((await client.me()).region_basis);
      } catch {
        setRegionBasis(null);
      }
      const names: Record<number, string> = {};
      await Promise.all(
        session.regionPath.map(async (id) => {
          try {
            names[id] = (await client.region(id)).name;
          } catch {
            /* a missing name shows as its id */
          }
        }),
      );
      setRegionNames(names);
    })();
  }, [session]);

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
        {demo && <DemoBanner />}
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

  const saveSession = (next: Session) => {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setSession(next);
  };

  return (
    <div className="app">
      {demo && <DemoBanner />}
      <Masthead />

      {pending > 0 && (
        <p className="notice warn">
          {pending} response{pending === 1 ? '' : 's'} saved on this device, waiting to be sent.
        </p>
      )}

      <nav className="tabs">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            aria-current={tab === id && openTopic === null ? 'page' : undefined}
            onClick={() => {
              setTab(id);
              open(null);
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      {openTopic !== null ? (
        <TopicView
          topicId={openTopic}
          citizenId={session.citizenId}
          regionId={session.regionId}
          regionPath={session.regionPath}
          mine={mine.find((m) => m.topic_id === openTopic)}
          onBack={() => open(null)}
          onSubmitted={() => void refreshMine()}
        />
      ) : (
        <>
          {tab === 'home' && (
            <Home
              regionId={session.regionId}
              regionPath={session.regionPath}
              regionName={session.regionName}
              regionBasis={regionBasis}
              onOpenTopic={open}
              onGo={setTab}
              onRegionConfirmed={(region, basis) => {
                saveSession({
                  ...session,
                  regionId: region.id,
                  regionPath: region.path,
                  regionName: region.name,
                });
                setRegionBasis(basis);
              }}
            />
          )}
          {tab === 'discuss' && <Discuss regionId={session.regionId} onOpenTopic={open} />}
          {tab === 'voices' && <Voices regionPath={session.regionPath} regionNames={regionNames} />}
          {tab === 'jobs' && <Jobs regionId={session.regionId} />}
          {tab === 'money' && (
            <>
              <Finance regionPath={session.regionPath} regionNames={regionNames} />
              <Economy regionId={session.regionId} />
              <TaxPanel regionId={session.regionId} regionName={session.regionName} />
            </>
          )}
          {tab === 'rti' && <RtiPanel authorities={authorities} />}
        </>
      )}

      <Fine />
    </div>
  );
}

function DemoBanner() {
  return (
    <div className="banner" role="status">
      Demo data. The comments are invented by simulated residents, and the documents and figures are
      development samples — none of it is real.
    </div>
  );
}

function Masthead() {
  return (
    <header className="masthead">
      <h1>Civic Voice</h1>
      <p>
        What people think of government decisions where they live — new orders, projects and news,
        discussed by the residents they affect — with the money spent, the jobs open, and the
        questions answered by asking.
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
        its figures are not a vote. Needs and tone shown for comments are labels assigned by a
        model, which makes mistakes.
      </p>
      <p>Ward boundaries © OpenStreetMap contributors (ODbL).</p>
      <p>
        <strong>What we hold.</strong> No name, no phone number, no government ID. Age, gender and
        similar details are stored as broad bands and only if you choose to give them. Any group of
        fewer than 25 people is withheld from every published figure. Comments appear under a name
        used only on that topic. Your location, if you share it, is used once to find your ward and
        never stored. You can withdraw and have your record — comments included — erased at any
        time; published totals are counts of at least 25 people and are not rewritten.
      </p>
    </footer>
  );
}
