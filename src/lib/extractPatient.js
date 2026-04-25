/**
 * Extracts a structured patient packet from a free-form EMT transcript.
 *
 * Schema returned:
 *   {
 *     specification: "stemi" | "stroke" | "trauma" | null,
 *     insurance: "Medicare" | "Medicaid" | "Blue Cross" | "Aetna"
 *              | "United Healthcare" | "Cigna" | "Kaiser" | null,
 *     location: { phrase: string } | null,   // free-text — geocode upstream
 *     age: number | null,
 *     sex: "male" | "female" | null,
 *     vitals: { bp: string|null, hr: number|null, spo2: number|null },
 *     transcript: string,
 *   }
 */

const SPEC_KEYWORDS = {
  stemi: [
    "stemi",
    "heart attack",
    "myocardial infarction",
    "chest pain",
    "chest tightness",
    "cardiac arrest",
    "cardiac",
    "mi ",
  ],
  stroke: [
    "stroke",
    "facial droop",
    "slurred speech",
    "slurring",
    "cva",
    "hemiparesis",
    "last known well",
    "weakness on one side",
  ],
  trauma: [
    "trauma",
    "gsw",
    "gunshot",
    "stabbing",
    "stab wound",
    "mvc",
    "motor vehicle",
    "car crash",
    "fall from",
    "ejection",
    "blunt force",
  ],
};

// Each entry: canonical insurer label → spoken variants we want to match.
// Ordered so that more-specific phrases (e.g. "blue cross blue shield") are
// looked for before shorter substrings.
const INSURANCE_KEYWORDS = {
  Medicare: ["medicare"],
  Medicaid: ["medicaid", "medi-cal", "medi cal"],
  "Blue Cross": ["blue cross blue shield", "blue cross", "bcbs", "anthem"],
  Aetna: ["aetna"],
  "United Healthcare": ["united healthcare", "unitedhealthcare", "unitedhealth", "uhc"],
  Cigna: ["cigna"],
  Kaiser: ["kaiser permanente", "kaiser"],
};

// Patterns that capture a location phrase. First match wins. Each pattern's
// first capture group is the spoken location phrase (geocoded upstream).
const LOCATION_PATTERNS = [
  // "intersection of 5th and Main" / "at the corner of Wilshire and Vermont"
  // (Tried first so the " and " in cross-streets isn't treated as a stop word.)
  /\b(?:at\s+the\s+)?(?:intersection|corner)\s+of\s+(.+?)(?:[.,;]|$)/i,
  // Bare street address: "1234 Wilshire Blvd"
  /\b(\d{1,5}\s+\w+(?:\s+\w+){0,4}\s+(?:street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|way|highway|hwy|freeway|fwy)\.?)\b/i,
  // "located at 1234 Main Street"
  /\blocated\s+at\s+(.+?)(?:[.,;]|$)/i,
  // "address is 5500 Wilshire Boulevard"
  /\baddress\s+(?:is\s+)?(.+?)(?:[.,;]|$)/i,
  // "patient at the Santa Monica Pier"
  /(?:patient(?:'s|\s+is)?\s+(?:at|located\s+at|near))\s+(.+?)(?:[.,;]|\s+(?:with|who|she|he|they)\b|$)/i,
  // "we're at the corner of Wilshire and Vermont" / "we are near the freeway"
  /\bwe(?:'re|\s+are)\s+(?:at|near)\s+(.+?)(?:[.,;]|\s+(?:with|who)\b|$)/i,
];

export function extractPatient(rawTranscript) {
  const transcript = (rawTranscript || "").toString();
  const lower = transcript.toLowerCase();

  return {
    specification: pickByLastOccurrence(lower, SPEC_KEYWORDS),
    insurance: pickByLastOccurrence(lower, INSURANCE_KEYWORDS),
    location: extractLocation(transcript),
    age: extractAge(transcript),
    sex: extractSex(transcript),
    vitals: extractVitals(transcript),
    transcript: transcript.trim(),
  };
}

function pickByLastOccurrence(lowerTranscript, keywordMap) {
  let best = null;
  let bestIndex = -1;

  for (const [label, terms] of Object.entries(keywordMap)) {
    for (const term of terms) {
      const idx = lowerTranscript.lastIndexOf(term);
      if (idx > bestIndex) {
        bestIndex = idx;
        best = label;
      }
    }
  }

  return best;
}

function extractLocation(transcript) {
  for (const pattern of LOCATION_PATTERNS) {
    const match = transcript.match(pattern);
    const phrase = match?.[1]?.trim();
    if (phrase && phrase.length >= 3) {
      // Strip trailing filler so "1234 Main Street period" → "1234 Main Street".
      return { phrase: phrase.replace(/\s+(?:please|right now|now|over)\s*$/i, "").trim() };
    }
  }
  return null;
}

function extractAge(transcript) {
  const match = transcript.match(/\b(\d{1,3})[- ]?(?:year[- ]?old|y\/o|yo)\b/i);
  return match ? Number(match[1]) : null;
}

function extractSex(transcript) {
  const match = transcript.match(/\b(male|female|man|woman)\b/i);
  if (!match) return null;
  const term = match[1].toLowerCase();
  if (term === "female" || term === "woman") return "female";
  return "male";
}

function extractVitals(transcript) {
  const bpMatch =
    transcript.match(/\bbp\s*(?:is|of|at)?\s*(\d{2,3})\s*(?:over|\/|on)\s*(\d{2,3})/i) ||
    transcript.match(/\b(\d{2,3})\s*over\s*(\d{2,3})\b/i);
  const bp = bpMatch ? `${bpMatch[1]}/${bpMatch[2]}` : null;

  const hrMatch = transcript.match(/\b(?:hr|heart rate|pulse)\s*(?:is|of|at)?\s*(\d{2,3})\b/i);
  const hr = hrMatch ? Number(hrMatch[1]) : null;

  const spo2Match = transcript.match(/\b(?:spo2|sp02|sat|sats|oxygen|o2)\s*(?:is|of|at)?\s*(\d{2,3})\b/i);
  const spo2 = spo2Match ? Number(spo2Match[1]) : null;

  return { bp, hr, spo2 };
}
