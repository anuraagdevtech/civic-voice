-- The discussion forum (ADR-0008).
--
-- Unlike everything in 001, these tables are keyed by TOPIC, not citizen: a thread is read as a
-- whole, so a topic's comments, votes, reports and digest live together on the shard that owns
-- vshardForTopic(topic_id), and every read of a thread is single-shard. What a citizen wrote is
-- indexed separately, on the citizen's own shard (`my_comment`), which is what "my comments" and
-- erasure use. Neither side ever needs a cross-shard query.
SET search_path TO civic_shard;

CREATE TABLE IF NOT EXISTS comment (
  topic_id            bigint      NOT NULL,
  id                  uuid        NOT NULL,
  vshard              integer     NOT NULL CHECK (vshard >= 0 AND vshard < 1024),
  -- One level of replies. Deeper nesting is where threads go to argue with themselves.
  parent_id           uuid,
  -- Per-topic pseudonym (docs/PRIVACY.md §2), never the citizen id: linking one person's comments
  -- across topics needs every topic's salt.
  pseudonym           char(32)    NOT NULL,
  handle              text        NOT NULL,
  body                text        NOT NULL CHECK (char_length(body) <= 2000),
  language            text        NOT NULL,
  -- Where the author lives, one level below the topic's jurisdiction, as a display name.
  area                text,
  located             boolean     NOT NULL DEFAULT false,
  verification_tier   smallint    NOT NULL CHECK (verification_tier BETWEEN 0 AND 3),
  state               text        NOT NULL CHECK (state IN
                        ('pending', 'published', 'held', 'rejected', 'removed', 'deleted')),
  moderation_reasons  text[]      NOT NULL DEFAULT '{}',
  sentiment           smallint    CHECK (sentiment BETWEEN -1 AND 1),
  needs               text[]      NOT NULL DEFAULT '{}',
  suggestion          boolean     NOT NULL DEFAULT false,
  model               text,
  upvotes             integer     NOT NULL DEFAULT 0 CHECK (upvotes >= 0),
  reply_count         integer     NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  report_count        integer     NOT NULL DEFAULT 0 CHECK (report_count >= 0),
  created_at          timestamptz NOT NULL,
  PRIMARY KEY (topic_id, id)
);

-- The two orders a thread is read in. Partial on state, so held and deleted rows cost the hot
-- indexes nothing.
CREATE INDEX IF NOT EXISTS comment_thread_new_idx
  ON comment (topic_id, created_at DESC, id DESC) WHERE state = 'published' AND parent_id IS NULL;
CREATE INDEX IF NOT EXISTS comment_thread_top_idx
  ON comment (topic_id, upvotes DESC, created_at DESC, id DESC) WHERE state = 'published' AND parent_id IS NULL;
CREATE INDEX IF NOT EXISTS comment_replies_idx
  ON comment (topic_id, parent_id, created_at) WHERE state = 'published' AND parent_id IS NOT NULL;

-- One upvote per pseudonym per comment. The primary key is the dedupe.
CREATE TABLE IF NOT EXISTS comment_vote (
  topic_id    bigint      NOT NULL,
  comment_id  uuid        NOT NULL,
  pseudonym   char(32)    NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, comment_id, pseudonym)
);

-- One report per pseudonym per comment, so a single person cannot report something off the site.
CREATE TABLE IF NOT EXISTS comment_report (
  topic_id    bigint      NOT NULL,
  comment_id  uuid        NOT NULL,
  pseudonym   char(32)    NOT NULL,
  reason      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, comment_id, pseudonym)
);

-- "What the public thinks and what needs to be done", regenerated as a thread grows.
CREATE TABLE IF NOT EXISTS topic_digest (
  topic_id      bigint      PRIMARY KEY,
  vshard        integer     NOT NULL CHECK (vshard >= 0 AND vshard < 1024),
  digest        jsonb       NOT NULL,
  based_on      integer     NOT NULL,
  generated_at  timestamptz NOT NULL
);

-- On the CITIZEN's shard: what this citizen wrote, and where. Erasure walks this, blanks each comment
-- on its topic's shard, then deletes these rows — in that order, so an interrupted erasure is retried
-- rather than orphaned.
CREATE TABLE IF NOT EXISTS my_comment (
  citizen_id  uuid        NOT NULL,
  comment_id  uuid        NOT NULL,
  topic_id    bigint      NOT NULL,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (citizen_id, comment_id)
);

CREATE INDEX IF NOT EXISTS my_comment_recent_idx ON my_comment (citizen_id, created_at DESC);
