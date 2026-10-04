/**
 * The needs taxonomy — what a comment is asking for.
 *
 * This is what powers "what do the youth need" and "what do farmers need": comments are labelled with
 * zero or more needs, and those labels are aggregated per cohort and region behind the k-anonymity
 * gate. The taxonomy is deliberately small and concrete. A fine-grained one would be more expressive
 * and much less reliable, and a need that is misclassified half the time is worse than no label.
 *
 * Each need carries a lexicon in the languages this pipeline sees most: English, Hindi (Devanagari and
 * romanised), and Telugu (script and romanised). The lexicon is not the classifier — it is a
 * high-precision signal that is combined with the learned model, and the part a domain expert can
 * correct without retraining anything.
 */

export { NEEDS, NEED_LABELS, type Need } from '@civic-voice/contracts';
import { NEEDS, type Need } from '@civic-voice/contracts';

/**
 * Lexicon entries are matched against whole tokens (for Latin and romanised text) or as substrings (for
 * Indic scripts, where inflection attaches to the stem: నీళ్లు / నీళ్ల / నీటి all share a stem, and
 * किसान / किसानों likewise).
 */
export const NEED_LEXICON: Record<Need, { tokens: string[]; stems: string[] }> = {
  employment: {
    tokens: [
      'job',
      'jobs',
      'employment',
      'unemployment',
      'unemployed',
      'vacancy',
      'vacancies',
      'recruitment',
      'notification',
      'notifications',
      'hiring',
      'salary',
      'naukri',
      'naukriyan',
      'rozgar',
      'berozgari',
      'udyogalu',
      'udyogam',
      'jobless',
      'tspsc',
      'tgpsc',
      'appsc',
      'ssc',
      'upsc',
      'group1',
      'group2',
      'posts',
      'layoffs',
      'internship',
    ],
    stems: ['नौकरी', 'रोजगार', 'बेरोजगार', 'भर्ती', 'ఉద్యోగ', 'నిరుద్యోగ', 'నోటిఫికేషన్', 'ఖాళీ'],
  },
  education: {
    tokens: [
      'school',
      'schools',
      'college',
      'colleges',
      'fees',
      'fee',
      'exam',
      'exams',
      'teacher',
      'teachers',
      'education',
      'student',
      'students',
      'scholarship',
      'scholarships',
      'syllabus',
      'paper',
      'leak',
      'university',
      'padhai',
      'shiksha',
      'chaduvu',
      'badi',
      'neet',
      'jee',
      'coaching',
      'hostel',
    ],
    stems: [
      'स्कूल',
      'शिक्षा',
      'परीक्षा',
      'फीस',
      'छात्र',
      'పాఠశాల',
      'చదువు',
      'పరీక్ష',
      'ఫీజు',
      'విద్యార్థ',
      'బడి',
    ],
  },
  health: {
    tokens: [
      'hospital',
      'hospitals',
      'doctor',
      'doctors',
      'medicine',
      'medicines',
      'health',
      'clinic',
      'ambulance',
      'aarogyasri',
      'ayushman',
      'treatment',
      'nurse',
      'dengue',
      'fever',
      'dawai',
      'davakhana',
      'aspatal',
      'vaidyam',
      'phc',
    ],
    stems: ['अस्पताल', 'डॉक्टर', 'दवा', 'इलाज', 'ఆసుపత్రి', 'ఆస్పత్రి', 'డాక్టర్', 'వైద్య', 'మందు'],
  },
  agriculture: {
    tokens: [
      'farmer',
      'farmers',
      'farming',
      'crop',
      'crops',
      'msp',
      'harvest',
      'paddy',
      'cotton',
      'fertilizer',
      'fertiliser',
      'urea',
      'seeds',
      'irrigation',
      'kisan',
      'kisano',
      'fasal',
      'kheti',
      'rythu',
      'raitulu',
      'rythubandhu',
      'rythubharosa',
      'panta',
      'pantalu',
      'mandi',
      'procurement',
      'drought',
      'loan',
      'waiver',
      'insurance',
      'tractor',
      'agriculture',
    ],
    stems: [
      'किसान',
      'फसल',
      'खेती',
      'खाद',
      'सिंचाई',
      'రైతు',
      'పంట',
      'ఎరువు',
      'విత్తన',
      'సాగు',
      'మద్దతు ధర',
    ],
  },
  water: {
    tokens: [
      'water',
      'drinking',
      'tanker',
      'tankers',
      'pipeline',
      'borewell',
      'paani',
      'pani',
      'neellu',
      'neelu',
      'manjeera',
      'supply',
    ],
    stems: ['पानी', 'जल', 'నీళ్', 'నీటి', 'నీరు', 'తాగునీ'],
  },
  roads_transport: {
    tokens: [
      'road',
      'roads',
      'pothole',
      'potholes',
      'traffic',
      'metro',
      'bus',
      'buses',
      'rtc',
      'tsrtc',
      'flyover',
      'footpath',
      'transport',
      'sadak',
      'sadkein',
      'rodlu',
      'rodu',
      'mmts',
      'highway',
      'signal',
    ],
    stems: [
      'सड़क',
      'सडक',
      'गड्ढ',
      'ट्रैफिक',
      'मेट्रो',
      'రోడ్',
      'రహదార',
      'గుంత',
      'ట్రాఫిక్',
      'మెట్రో',
      'బస్సు',
    ],
  },
  housing: {
    tokens: [
      'house',
      'houses',
      'housing',
      'rent',
      '2bhk',
      'indiramma',
      'pmay',
      'awas',
      'ghar',
      'illu',
      'illulu',
      'flats',
    ],
    stems: ['मकान', 'घर', 'आवास', 'ఇల్లు', 'ఇళ్ల', 'గృహ'],
  },
  electricity: {
    tokens: [
      'power',
      'electricity',
      'current',
      'powercut',
      'outage',
      'bijli',
      'transformer',
      'units',
      'bill',
    ],
    stems: ['बिजली', 'కరెంటు', 'కరెంట్', 'విద్యుత్'],
  },
  sanitation: {
    tokens: [
      'garbage',
      'drain',
      'drains',
      'drainage',
      'sewage',
      'flood',
      'flooding',
      'waterlogging',
      'nala',
      'overflow',
      'desilt',
      'desilting',
      'stormwater',
      'waterlogged',
      'inundate',
      'nalas',
      'mosquitoes',
      'dustbin',
      'kachra',
      'gandagi',
      'chetta',
      'murugu',
    ],
    stems: ['कचरा', 'नाली', 'गंदगी', 'बाढ़', 'చెత్త', 'మురుగు', 'డ్రైనేజ్', 'వరద'],
  },
  safety: {
    tokens: [
      'police',
      'crime',
      'theft',
      'safety',
      'harassment',
      'women',
      'unsafe',
      'chain',
      'snatching',
      'streetlight',
      'streetlights',
    ],
    stems: ['पुलिस', 'अपराध', 'सुरक्षा', 'చోరీ', 'పోలీస్', 'నేర', 'భద్రత'],
  },
  corruption: {
    tokens: [
      'corruption',
      'bribe',
      'bribes',
      'corrupt',
      'scam',
      'rishwat',
      'lanchalu',
      'commission',
      'kickback',
    ],
    stems: ['भ्रष्टाचार', 'रिश्वत', 'घोटाल', 'లంచ', 'అవినీతి', 'కుంభకోణ'],
  },
  prices: {
    tokens: [
      'price',
      'prices',
      'inflation',
      'costly',
      'expensive',
      'petrol',
      'diesel',
      'gas',
      'cylinder',
      'lpg',
      'mehangai',
      'mahangai',
      'dharalu',
      'dhara',
      'vegetables',
      'onion',
      'tomato',
    ],
    stems: ['महंगाई', 'कीमत', 'दाम', 'ధరలు', 'ధర', 'గ్యాస్'],
  },
  welfare: {
    tokens: [
      'pension',
      'pensions',
      'ration',
      'aasara',
      'cheyutha',
      'scheme',
      'schemes',
      'welfare',
      'subsidy',
      'benefit',
      'benefits',
      'kalyana',
      'shaadi',
      'mubarak',
    ],
    stems: ['पेंशन', 'राशन', 'योजना', 'పింఛన్', 'పెన్షన్', 'రేషన్', 'పథక', 'సంక్షేమ'],
  },
  environment: {
    tokens: [
      'pollution',
      'lake',
      'lakes',
      'trees',
      'tree',
      'air',
      'dust',
      'smoke',
      'environment',
      'musi',
      'green',
      'encroachment',
    ],
    stems: ['प्रदूषण', 'पेड़', 'तालाब', 'కాలుష్య', 'చెరువు', 'చెట్ల', 'మూసీ'],
  },
};

/** Lexicon hits per need, as a feature for the learned model and as a fallback on its own. */
/**
 * English inflections folded onto the lexicon's base forms: "floods", "flooded" and "flooding" all
 * say "flood". Deliberately crude — suffix stripping, not a stemmer — because it only has to reach
 * the lexicon's own words, and every candidate it produces is checked against that list.
 */
export function latinVariants(token: string): string[] {
  if (!/^[a-z]+$/.test(token) || token.length < 4) return [token];
  const out = new Set([token]);
  if (token.endsWith('ies')) out.add(`${token.slice(0, -3)}y`);
  if (token.endsWith('es')) out.add(token.slice(0, -2));
  if (token.endsWith('s') && !token.endsWith('ss')) out.add(token.slice(0, -1));
  for (const suffix of ['ed', 'ing']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      const base = token.slice(0, -suffix.length);
      out.add(base);
      out.add(`${base}e`); // "delayed" → "delay", "closed" → "close"
      if (base.length >= 3 && base.at(-1) === base.at(-2)) out.add(base.slice(0, -1)); // "stopped" → "stop"
    }
  }
  return [...out];
}

export function lexiconNeeds(tokens: readonly string[], rawText: string): Map<Need, number> {
  const tokenSet = new Set(tokens.flatMap(latinVariants));
  const hits = new Map<Need, number>();
  for (const need of NEEDS) {
    const { tokens: words, stems } = NEED_LEXICON[need];
    let n = 0;
    for (const word of words) if (tokenSet.has(word)) n += 1;
    for (const stem of stems) if (rawText.includes(stem)) n += 1;
    if (n > 0) hits.set(need, n);
  }
  return hits;
}

/**
 * Suggestion markers — a comment that proposes an action rather than only reacting. This is what
 * separates "what people think" from "what people say needs to be done".
 */
export const SUGGESTION_MARKERS = {
  tokens: [
    'should',
    'must',
    'need',
    'needs',
    'please',
    'kindly',
    'request',
    'suggest',
    'suggestion',
    'instead',
    'chahiye',
    'karo',
    'kijiye',
    'karein',
    'banao',
    'do',
    'cheyali',
    'cheyandi',
    'kavali',
    'ivvali',
    'pettali',
    'veyali',
    'build',
    'provide',
    'increase',
    'reduce',
    'fix',
    'start',
    'stop',
    'release',
  ],
  stems: [
    'चाहिए',
    'कीजिए',
    'करें',
    'करना होगा',
    'చేయాలి',
    'కావాలి',
    'ఇవ్వాలి',
    'పెట్టాలి',
    'వేయాలి',
    'చేయండి',
  ],
};

export function suggestionHits(tokens: readonly string[], rawText: string): number {
  const tokenSet = new Set(tokens);
  let n = 0;
  for (const word of SUGGESTION_MARKERS.tokens) if (tokenSet.has(word)) n += 1;
  for (const stem of SUGGESTION_MARKERS.stems) if (rawText.includes(stem)) n += 1;
  return n;
}
