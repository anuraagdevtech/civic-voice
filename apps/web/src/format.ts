/** Display helpers. Indian numbering throughout: lakh and crore, not million and billion. */

export function inr(amount: number | null): string {
  if (amount === null) return '—';
  const crore = amount / 1e7;
  if (crore >= 1)
    return `₹${crore >= 100 ? Math.round(crore).toLocaleString('en-IN') : crore.toFixed(crore >= 10 ? 0 : 1)} crore`;
  const lakh = amount / 1e5;
  if (lakh >= 1) return `₹${lakh.toFixed(lakh >= 10 ? 0 : 1)} lakh`;
  return `₹${Math.round(amount).toLocaleString('en-IN')}`;
}

export function count(n: number): string {
  return n.toLocaleString('en-IN');
}

export function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function date(iso: string | null): string {
  if (!iso) return 'undated';
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export const KIND_LABELS: Record<string, string> = {
  policy: 'Policy',
  decision: 'Decision',
  scheme: 'Scheme',
  law: 'Notification',
  budget_line: 'Budget',
  project: 'Project',
  government_order: 'GO',
  news: 'News',
  local_issue: 'Local issue',
  gazette_notification: 'Gazette',
  press_release: 'Press release',
  tender: 'Tender',
  job_notification: 'Jobs',
};
