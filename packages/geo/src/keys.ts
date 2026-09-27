/** Stable region keys. Kept apart from regions.ts, which loads data files at import time. */

export function slug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function wardKey(name: string): string {
  return `IN-TG-GHMC-${slug(name)}`;
}
