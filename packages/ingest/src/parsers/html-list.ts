import { parse } from 'node-html-parser';
import { stripTags } from './rss.ts';

/**
 * Listing pages — "latest GOs", "what's new", "notifications" — described declaratively.
 *
 * Government portals get redesigned, and a scraper written as code breaks silently and needs a
 * developer. Written as selectors in the source registry, a layout change is a one-line data fix, and
 * the ingestor's health check notices it: a source that normally yields items and suddenly yields zero
 * is reported as "selectors probably stale", not quietly treated as "nothing new today".
 */
export interface ListSelectors {
  /** Selector for one row / card / list item. */
  item: string;
  /** Within an item: the element whose text is the title. Defaults to the link text. */
  title?: string;
  /** Within an item: the anchor whose href is the document. */
  link: string;
  /** Within an item: the element whose text holds the date, if any. */
  date?: string;
  /** Within an item: extra text to keep (department, GO number column…). */
  extra?: string[];
}

export interface ListItem {
  title: string;
  link: string;
  dateText: string | null;
  extra: string[];
}

export function parseListing(html: string, selectors: ListSelectors, baseUrl: string): ListItem[] {
  const root = parse(html);
  const items: ListItem[] = [];
  for (const node of root.querySelectorAll(selectors.item)) {
    const anchor = node.querySelector(selectors.link);
    const href = anchor?.getAttribute('href');
    if (!anchor || !href || href.startsWith('javascript:') || href === '#') continue;

    const titleNode = selectors.title ? node.querySelector(selectors.title) : anchor;
    const title = stripTags(titleNode?.innerHTML ?? '');
    if (!title) continue;

    let link: string;
    try {
      link = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    const dateText = selectors.date
      ? stripTags(node.querySelector(selectors.date)?.innerHTML ?? '') || null
      : null;
    const extra = (selectors.extra ?? [])
      .map((sel) => stripTags(node.querySelector(sel)?.innerHTML ?? ''))
      .filter((s) => s.length > 0);

    items.push({ title, link, dateText, extra });
  }
  return items;
}
