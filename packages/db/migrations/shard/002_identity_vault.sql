-- Identity bindings live in their own schema with their own grants, and in production in their own
-- database entirely. It answers exactly one question — "has this identity already claimed an
-- account?" — and stores nothing that could answer any other (docs/PRIVACY.md §4).

CREATE SCHEMA IF NOT EXISTS civic_identity;

CREATE TABLE IF NOT EXISTS civic_identity.identity_binding (
  -- HMAC(pepper_v, normalised_identifier). The raw phone number or government ID is NEVER stored,
  -- in any store, at any time. The index cannot be reversed to the identifier.
  blind_index     text        PRIMARY KEY,
  citizen_id      uuid        NOT NULL,
  method          text        NOT NULL CHECK (method IN ('phone', 'gov_id')),
  -- Versioned so the pepper can be rotated by re-blinding rather than by re-collecting identities.
  pepper_version  integer     NOT NULL,
  verified_at     timestamptz NOT NULL DEFAULT now()
);

-- One identity, one account, per method. This constraint is the entire Sybil defence for tiers 2
-- and 3 (docs/TRUST.md §1).
CREATE UNIQUE INDEX IF NOT EXISTS identity_binding_citizen_method_idx
  ON civic_identity.identity_binding (citizen_id, method);
