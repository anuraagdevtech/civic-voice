/**
 * Keyset cursors for comment threads. Opaque to clients (base64url JSON), so the ordering can change
 * without a contract change.
 *
 * "new" pages on (created_at, id), which never changes, so pages never overlap. "top" pages on
 * (upvotes, created_at, id); upvotes move while someone is reading, so a comment can occasionally
 * appear on two pages or be skipped. That is the accepted trade for "top" everywhere, and the client
 * de-duplicates by id.
 */
export interface ThreadCursor {
  upvotes?: number;
  created_at: string;
  id: string;
}

export function encodeCursor(c: ThreadCursor): string {
  return Buffer.from(JSON.stringify([c.upvotes ?? null, c.created_at, c.id]), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(raw: string | null | undefined): ThreadCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [upvotes, createdAt, id] = parsed as [unknown, unknown, unknown];
    if (
      typeof createdAt !== 'string' ||
      typeof id !== 'string' ||
      Number.isNaN(Date.parse(createdAt))
    )
      return null;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { ...(typeof upvotes === 'number' ? { upvotes } : {}), created_at: createdAt, id };
  } catch {
    return null;
  }
}
