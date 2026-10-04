import { useState } from 'react';
import type { ResolveLocationResponse } from '@civic-voice/sdk';
import { client } from '../api.ts';

type Resolved = NonNullable<ResolveLocationResponse['region']>;

/**
 * "Use my location" → "You appear to be in Khairatabad ward. Is this where you live?"
 *
 * The browser's position is rounded to about 100 m in the SDK before it is sent, used once to find
 * the ward, and never stored — what is kept is the region the person confirms. A fix taken at work is
 * not a home, so the answer is always a question, never an assumption.
 */
export function LocationConfirm({
  onConfirmed,
  confirmLabel = 'Yes, I live here',
}: {
  onConfirmed: (region: Resolved, attestation: string) => void | Promise<void>;
  confirmLabel?: string;
}) {
  const [state, setState] = useState<
    | { step: 'idle' }
    | { step: 'locating' }
    | { step: 'found'; region: Resolved; attestation: string; attribution: string }
    | { step: 'failed'; message: string }
  >({ step: 'idle' });

  const locate = () => {
    if (!('geolocation' in navigator)) {
      setState({
        step: 'failed',
        message: 'This browser cannot share a location. Choose your area from the list instead.',
      });
      return;
    }
    setState({ step: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        void (async () => {
          try {
            const res = await client.resolveLocation(pos.coords.latitude, pos.coords.longitude);
            if (res.region && res.attestation) {
              setState({
                step: 'found',
                region: res.region,
                attestation: res.attestation,
                attribution: res.attribution,
              });
            } else {
              setState({
                step: 'failed',
                message:
                  res.unresolved_reason === 'outside_india'
                    ? 'That location is outside India. Choose your area from the list instead.'
                    : 'We do not have ward boundaries for your area yet. Choose your area from the list — you will still see everything that applies to you.',
              });
            }
          } catch {
            setState({
              step: 'failed',
              message: 'Could not look up your area. Choose it from the list instead.',
            });
          }
        })();
      },
      () =>
        setState({
          step: 'failed',
          message: 'Location permission was not given. Choose your area from the list instead.',
        }),
      { enableHighAccuracy: false, maximumAge: 10 * 60 * 1000, timeout: 15_000 },
    );
  };

  if (state.step === 'found') {
    const where = [...state.region.path_names].reverse().slice(0, 3).join(' · ');
    return (
      <div className="notice">
        <p style={{ margin: '0 0 8px' }}>
          You appear to be in <strong>{where}</strong>. Is this where you live?
        </p>
        <div className="chips">
          <button
            className="primary"
            onClick={() => void onConfirmed(state.region, state.attestation)}
          >
            {confirmLabel}
          </button>
          <button className="secondary" onClick={() => setState({ step: 'idle' })}>
            No, I'll choose
          </button>
        </div>
        <p style={{ margin: '8px 0 0', fontSize: 11 }}>{state.attribution}</p>
      </div>
    );
  }

  return (
    <div style={{ margin: '4px 0 14px' }}>
      <button className="secondary" onClick={locate} disabled={state.step === 'locating'}>
        {state.step === 'locating' ? 'Finding your ward…' : '📍 Use my location'}
      </button>
      <p className="meta" style={{ marginTop: 6 }}>
        Rounded to about 100 m on your device, used once to find your ward, never stored.
      </p>
      {state.step === 'failed' && <p className="notice warn">{state.message}</p>}
    </div>
  );
}
