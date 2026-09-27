# Fixtures

**Synthetic.** Each file approximates the format its source is expected to serve. None is a capture of
the live site: outbound access to government and news hosts was blocked in the environment these were
written in. RSS fixtures follow the RSS 2.0 standard exactly, so they are a faithful test of the
parser. HTML fixtures follow each portal's *estimated* structure; replace them with real captures
(`pnpm ingest:check --save-fixtures`) on the first run with network access.

The content — GO numbers, amounts, vacancy counts, dates — is invented for testing and does not
describe real orders or notifications.
