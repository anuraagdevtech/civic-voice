# Civic Voice — mobile

An Expo / React Native client on the same `@civic-voice/sdk` as the web app, so the two cannot drift
apart on the API contract: a breaking change fails `pnpm typecheck` here as well (ADR-0006).

```bash
pnpm --filter @civic-voice/mobile start
```

## What is different from the web app, and why

The two apps share the SDK, the contracts and the domain vocabulary. They differ where the device
differs, and those differences are the reason a separate app exists at all rather than a wrapped web
view:

- **Offline is the default assumption, not an error path.** Submissions are written to
  `AsyncStorage` first and sent when connectivity returns, keeping their original idempotency key so
  a replay cannot double-submit. On the networks most of this audience uses, a failed request is the
  normal case.
- **Device attestation.** Play Integrity and App Attest give a tier-0 signal the web cannot, which
  raises the cost of a bot farm (docs/TRUST.md §1).
- **Push notifications for RTI deadlines.** The statutory clock is the part of the product that most
  needs to reach a citizen when they are not looking at the app — a §19(1) appeal window is 30 days
  and starts on a day nobody announces.

## Screens

| Screen | Purpose |
| --- | --- |
| `Onboarding` | Drill down from state to ward, then register (no name, phone or ID) |
| `Discuss` (“Near me”) | Hot topics where the citizen lives, the digest of what people think, the thread, posting, and the open-jobs count |
| `Decisions` | Topics for the citizen's region, with the mood scale and published aggregates |
| `Rti` | Filed requests, statutory deadlines, and the next action |

Not yet on the phone, and in the web app: device-location confirmation (it needs `expo-location`),
voting and reporting on comments, raising a local issue, the youth/farmer insights, the jobs list,
indicators and the tax ledger.

The native build is not wired into CI: Expo needs a native toolchain, and adding an Android SDK to
every PR run would cost more than it catches. CI does typecheck this app against the shared SDK, which
covers the contract — the part that actually breaks.
