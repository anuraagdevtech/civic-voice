/**
 * robots.txt, per RFC 9309.
 *
 * Many state government portals run on small servers that fall over under a crawler that ignores
 * robots.txt or hammers them in parallel — and a civic platform that knocks a government portal offline
 * has harmed exactly the citizens it exists for. Honouring robots.txt is therefore not optional here,
 * and the parser is exact about the parts of the RFC that decide the answer:
 *
 *  - the group for the most specific matching user-agent wins, falling back to `*`;
 *  - within a group, the **longest** matching rule wins, and on a tie `Allow` wins;
 *  - `*` in a path is a wildcard and a trailing `$` anchors the end;
 *  - `Crawl-delay` is not in the RFC but is widely used by Indian government sites, so it is honoured.
 */

interface Rule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelaySeconds: number | null;
}

export interface RobotsPolicy {
  groups: Group[];
  sitemaps: string[];
}

function compile(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

export function parseRobots(text: string): RobotsPolicy {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      // Consecutive user-agent lines share one group; a user-agent after rules starts a new one.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;

    if (key === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (!current) continue;

    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow means "allow everything" and contributes no rule.
      if (value === '') continue;
      current.rules.push({ allow: key === 'allow', pattern: value, regex: compile(value) });
    } else if (key === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }
  return { groups, sitemaps };
}

/** The group that applies to this user agent: the longest matching product token, else `*`. */
function groupFor(policy: RobotsPolicy, userAgent: string): Group | null {
  const token = userAgent.toLowerCase().split('/')[0] ?? '';
  let best: Group | null = null;
  let bestLength = -1;
  for (const group of policy.groups) {
    for (const agent of group.agents) {
      if (agent !== '*' && token.includes(agent) && agent.length > bestLength) {
        best = group;
        bestLength = agent.length;
      }
    }
  }
  if (best) return best;
  return policy.groups.find((g) => g.agents.includes('*')) ?? null;
}

export function isAllowed(policy: RobotsPolicy, userAgent: string, path: string): boolean {
  if (path === '/robots.txt') return true;
  const group = groupFor(policy, userAgent);
  if (!group) return true;

  let decision: Rule | null = null;
  for (const rule of group.rules) {
    if (!rule.regex.test(path)) continue;
    if (
      !decision ||
      rule.pattern.length > decision.pattern.length ||
      (rule.pattern.length === decision.pattern.length && rule.allow && !decision.allow)
    ) {
      decision = rule;
    }
  }
  return decision === null || decision.allow;
}

export function crawlDelaySeconds(policy: RobotsPolicy, userAgent: string): number | null {
  return groupFor(policy, userAgent)?.crawlDelaySeconds ?? null;
}
