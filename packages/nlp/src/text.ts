/**
 * Text primitives for Indian-language civic comments.
 *
 * The inputs this system actually receives are mixed: English, Hindi in Devanagari, Telugu in Telugu
 * script, and — very commonly — Hindi or Telugu typed in the Latin alphabet ("paani nahi aa raha",
 * "roads baaga levu"). A pipeline that assumes one script per comment misclassifies a large share of
 * real traffic, so script is detected per character and romanised Indic is detected separately from
 * English.
 */

export const SCRIPTS = [
  'latin',
  'devanagari',
  'bengali',
  'gurmukhi',
  'gujarati',
  'odia',
  'tamil',
  'telugu',
  'kannada',
  'malayalam',
  'arabic',
  'other',
] as const;
export type Script = (typeof SCRIPTS)[number];

/** Unicode blocks for the scripts of the 22 scheduled languages that this pipeline distinguishes. */
const RANGES: Array<[number, number, Script]> = [
  [0x0900, 0x097f, 'devanagari'],
  [0x0980, 0x09ff, 'bengali'],
  [0x0a00, 0x0a7f, 'gurmukhi'],
  [0x0a80, 0x0aff, 'gujarati'],
  [0x0b00, 0x0b7f, 'odia'],
  [0x0b80, 0x0bff, 'tamil'],
  [0x0c00, 0x0c7f, 'telugu'],
  [0x0c80, 0x0cff, 'kannada'],
  [0x0d00, 0x0d7f, 'malayalam'],
  // Urdu and Kashmiri; Sindhi as well.
  [0x0600, 0x06ff, 'arabic'],
];

export function scriptOf(codePoint: number): Script | null {
  if ((codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a)) {
    return 'latin';
  }
  for (const [lo, hi, script] of RANGES) {
    if (codePoint >= lo && codePoint <= hi) return script;
  }
  return null;
}

/** Share of letters in each script. Digits, punctuation and emoji do not vote. */
export function scriptProfile(text: string): Map<Script, number> {
  const counts = new Map<Script, number>();
  let total = 0;
  for (const ch of text) {
    const script = scriptOf(ch.codePointAt(0) ?? 0);
    if (script === null) continue;
    counts.set(script, (counts.get(script) ?? 0) + 1);
    total += 1;
  }
  const profile = new Map<Script, number>();
  if (total === 0) return profile;
  for (const [script, n] of counts) profile.set(script, n / total);
  return profile;
}

export function dominantScript(text: string): Script {
  let best: Script = 'other';
  let bestShare = 0;
  for (const [script, share] of scriptProfile(text)) {
    if (share > bestShare) {
      best = script;
      bestShare = share;
    }
  }
  return best;
}

/**
 * Language labels. `-Latn` suffixes are romanised Indic — the same language in the Latin alphabet,
 * which needs different lexicons from both English and the native script.
 */
export const LANGUAGES = [
  'en',
  'hi',
  'hi-Latn',
  'te',
  'te-Latn',
  'ta',
  'kn',
  'ml',
  'bn',
  'mr',
  'gu',
  'pa',
  'or',
  'ur',
  'und',
] as const;
export type Language = (typeof LANGUAGES)[number];

/**
 * High-frequency function words that are distinctive of romanised Hindi and romanised Telugu. Content
 * words would be domain-specific; function words are what actually separates "Hinglish" from English
 * in a short comment.
 */
const HINGLISH_MARKERS = new Set([
  'hai',
  'hain',
  'nahi',
  'nahin',
  'kya',
  'kyu',
  'kyun',
  'kab',
  'kaise',
  'aur',
  'bhi',
  'hum',
  'humein',
  'hamare',
  'mera',
  'meri',
  'mere',
  'tum',
  'aap',
  'yeh',
  'ye',
  'woh',
  'wo',
  'ko',
  'ki',
  'ka',
  'ke',
  'se',
  'mein',
  'par',
  'tak',
  'raha',
  'rahi',
  'rahe',
  'chahiye',
  'karo',
  'karna',
  'karte',
  'kar',
  'sab',
  'bahut',
  'bohot',
  'accha',
  'acha',
  'achha',
  'bura',
  'sarkar',
  'log',
  'logon',
  'kuch',
  'koi',
  'hota',
  'hoti',
  'gaya',
  'gayi',
  'paani',
  'pani',
  'bijli',
  'naukri',
  'kisan',
  'kisano',
  'dikkat',
  'pareshani',
  'jaldi',
  'abhi',
  'kab',
  'milta',
  'milti',
  'milega',
  'diya',
  'wala',
  'wali',
]);

const TENGLISH_MARKERS = new Set([
  'ledu',
  'levu',
  'undi',
  'unnai',
  'unnayi',
  'unnaru',
  'chala',
  'chaala',
  'baaga',
  'bagundi',
  'bagaledu',
  'emi',
  'enti',
  'ela',
  'elaa',
  'enduku',
  'eppudu',
  'ekkada',
  'mana',
  'manaki',
  'naaku',
  'nenu',
  'meeru',
  'vallu',
  'cheyali',
  'cheyandi',
  'cheyyali',
  'kavali',
  'kaavali',
  'raavatledu',
  'vastundi',
  'vachindi',
  'ivvali',
  'istaru',
  'ichindi',
  'neellu',
  'neelu',
  'rodlu',
  'udyogalu',
  'rythu',
  'raitulu',
  'prabhutvam',
  'sarkaru',
  'kani',
  'inka',
  'intha',
  'antha',
  'lo',
  'ki',
  'gurinchi',
  'mundu',
  'tarvata',
  'pettali',
  'chesaru',
  'chestunnaru',
  'avutundi',
  'kaadu',
]);

/** English function words; used to decide whether a Latin comment is English or romanised Indic. */
const ENGLISH_MARKERS = new Set([
  'the',
  'is',
  'are',
  'was',
  'were',
  'and',
  'or',
  'but',
  'not',
  'no',
  'this',
  'that',
  'these',
  'there',
  'we',
  'our',
  'they',
  'their',
  'it',
  'its',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'from',
  'should',
  'would',
  'could',
  'will',
  'has',
  'have',
  'had',
  'been',
  'be',
  'very',
  'why',
  'when',
  'what',
  'how',
  'please',
  'government',
  'people',
  'need',
  'needs',
  'good',
  'bad',
  'still',
  'even',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFC')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

export interface LanguageGuess {
  language: Language;
  script: Script;
  confidence: number;
}

const NATIVE: Partial<Record<Script, Language>> = {
  devanagari: 'hi',
  telugu: 'te',
  tamil: 'ta',
  kannada: 'kn',
  malayalam: 'ml',
  bengali: 'bn',
  gujarati: 'gu',
  gurmukhi: 'pa',
  odia: 'or',
  arabic: 'ur',
};

/**
 * Guess the language of a comment.
 *
 * Native scripts map directly (Devanagari → Hindi is an approximation; Marathi and Nepali share the
 * script, and a script-only detector cannot separate them). Latin text is scored against English,
 * romanised-Hindi and romanised-Telugu function words, which is enough for the short comments this
 * handles; the confidence says how clear the decision was.
 */
export function detectLanguage(text: string): LanguageGuess {
  const script = dominantScript(text);
  if (script !== 'latin') {
    const language = NATIVE[script] ?? 'und';
    const share = scriptProfile(text).get(script) ?? 0;
    return { language, script, confidence: Math.round(share * 100) / 100 };
  }

  const tokens = tokenize(text);
  if (tokens.length === 0) return { language: 'und', script, confidence: 0 };

  let en = 0;
  let hi = 0;
  let te = 0;
  for (const token of tokens) {
    if (ENGLISH_MARKERS.has(token)) en += 1;
    if (HINGLISH_MARKERS.has(token)) hi += 1;
    if (TENGLISH_MARKERS.has(token)) te += 1;
  }
  const total = en + hi + te;
  if (total === 0) return { language: 'en', script, confidence: 0.3 };

  // "ki"/"lo" etc. appear in both romanised lexicons; ties go to the one with more distinctive hits.
  const scores: Array<[Language, number]> = [
    ['en', en],
    ['hi-Latn', hi],
    ['te-Latn', te],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [winner, top] = scores[0] as [Language, number];
  return { language: winner, script, confidence: Math.round((top / total) * 100) / 100 };
}

/**
 * Normalise for feature extraction. Keeps every script, strips what carries no meaning for sentiment
 * or topic and would otherwise become noise features: URLs, @mentions, repeated punctuation, and
 * elongations ("sooooo bad" → "soo bad", which keeps the emphasis signal without an unbounded
 * vocabulary).
 */
export function normalize(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@\w+/g, ' ')
    .replace(/(\p{L})\1{2,}/gu, '$1$1')
    .replace(/([!?.])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
