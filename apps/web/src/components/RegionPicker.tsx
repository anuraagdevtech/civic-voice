import { useEffect, useState } from 'react';
import { AGE_BANDS, GENDERS, LOCALES, URBANITY, type Region } from '@civic-voice/sdk';
import { client } from '../api.ts';

/**
 * Region and demographics.
 *
 * Every demographic question is optional and says so. That is not politeness: a citizen who declines
 * a dimension still counts in every total, and the arithmetic is built for it — so there is no reason
 * to pressure anyone into answering, and the copy should not imply otherwise.
 */
export function RegionPicker({
  onRegistered,
}: {
  onRegistered: (citizenId: string, region: Region) => void;
}) {
  const [levels, setLevels] = useState<Region[][]>([]);
  const [chosen, setChosen] = useState<Region[]>([]);
  const [ageBand, setAgeBand] = useState('');
  const [gender, setGender] = useState('');
  const [urbanity, setUrbanity] = useState('');
  const [locale, setLocale] = useState('en');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const country = await client.region(1);
        const states = await client.childRegions(country.id);
        setLevels([states.items]);
      } catch {
        setError('Could not load the list of regions.');
      }
    })();
  }, []);

  const pick = async (depth: number, region: Region) => {
    const nextChosen = [...chosen.slice(0, depth), region];
    setChosen(nextChosen);
    try {
      const children = await client.childRegions(region.id);
      setLevels([
        ...levels.slice(0, depth + 1),
        ...(children.items.length > 0 ? [children.items] : []),
      ]);
    } catch {
      setLevels(levels.slice(0, depth + 1));
    }
  };

  const register = async () => {
    const region = chosen.at(-1);
    if (!region) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.register({
        region_id: region.id,
        locale: locale as never,
        demographics: {
          ...(ageBand ? { age_band: ageBand as never } : {}),
          ...(gender ? { gender: gender as never } : {}),
          ...(urbanity ? { urbanity: urbanity as never } : {}),
        },
      });
      onRegistered(result.citizen.id, region);
    } catch {
      setError('Could not create your account. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const LABELS = ['State or union territory', 'District', 'Constituency', 'Ward or panchayat'];

  return (
    <section className="card">
      <h2>Where do you live?</h2>
      <p className="meta">
        This decides which decisions you are shown and which area your response counts towards. We
        store no name, no phone number and no government ID.
      </p>

      {levels.map((options, depth) => (
        <div key={depth} style={{ marginBottom: 10 }}>
          <label>
            <span className="k">{LABELS[depth] ?? 'Area'}</span>
            <br />
            <select
              value={chosen[depth]?.id ?? ''}
              onChange={(e) => {
                const region = options.find((o) => o.id === Number(e.target.value));
                if (region) void pick(depth, region);
              }}
            >
              <option value="">Choose…</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ))}

      <h2 style={{ marginTop: 18 }}>About you — all optional</h2>
      <p className="meta">
        These let the figures be broken down by group. Any group smaller than 25 people is withheld,
        so nothing here can identify you. Leave anything blank and you will still be counted in the
        totals.
      </p>

      <div className="stat-row">
        <label>
          <span className="k">Age</span>
          <br />
          <select value={ageBand} onChange={(e) => setAgeBand(e.target.value)}>
            <option value="">Prefer not to say</option>
            {AGE_BANDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="k">Gender</span>
          <br />
          <select value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="">Prefer not to say</option>
            {GENDERS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="k">Area</span>
          <br />
          <select value={urbanity} onChange={(e) => setUrbanity(e.target.value)}>
            <option value="">Prefer not to say</option>
            {URBANITY.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="k">Language</span>
          <br />
          <select value={locale} onChange={(e) => setLocale(e.target.value)}>
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="notice warn">{error}</p>}

      <button
        className="primary"
        disabled={busy || chosen.length === 0}
        onClick={() => void register()}
      >
        {busy ? 'Creating…' : 'Start'}
      </button>
    </section>
  );
}
