/**
 * Extracts a structured patient packet from a free-form EMT transcript.
 *
 * Schema returned:
 *   {
 *     name:           string | null,
 *     age:            number | null,
 *     sex:            "male" | "female" | null,
 *     chiefComplaint: string | null,        // primary presenting problem
 *     condition:      "cardiac" | "stroke" | "trauma" | null,
 *     severity:       "critical" | "high" | "moderate" | "low" | null,
 *     insuranceProvider: "Government" | "Kaiser" | null,
 *     bloodPressure:  string | null,
 *     heartRate:      number | null,
 *     oxygenSaturation: number | null,
 *     respiratoryRate: number | null,
 *     address:        string | null,
 *     summary:        string | null,
 *     confidence:     number | null,
 *     transcript:     string,
 *   }
 */

const CONDITION_KEYWORDS = {
  cardiac: [
    "stemi",
    "st elevation",
    "heart attack",
    "myocardial infarction",
    "chest pain",
    "chest pressure",
    "chest tightness",
    "crushing chest",
    "cardiac arrest",
    "cardiac",
    "mi ",
    "v-fib",
    "ventricular fibrillation",
  ],
  stroke: [
    "stroke",
    "facial droop",
    "face drooping",
    "slurred speech",
    "slurring",
    "can't speak",
    "difficulty speaking",
    "trouble speaking",
    "cva",
    "hemiparesis",
    "last known well",
    "weakness on one side",
    "one-sided weakness",
    "arm weakness",
    "sudden headache",
    "vision changes",
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
    "head injury",
    "head trauma",
    "penetrating",
    "crush injury",
  ],
};

// Each entry: canonical insurer label → spoken variants we want to match.
// Ordered so that more-specific phrases (e.g. "blue cross blue shield") are
// looked for before shorter substrings.
const INSURANCE_KEYWORDS = {
  Government: ["medicare", "medicaid", "medi-cal", "medi cal", "government insurance"],
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

// Trigger phrases for picking up the patient's name. Capture group is up to
// 3 word tokens after the trigger; we then require at least one capitalized
// token (proper-noun signal) and reject obvious non-names like "unconscious".
const NAME_PATTERNS = [
  /\bpatient(?:'s)?\s+name\s+is\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})\b/i,
  /\bname(?:\s+is)?\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})\b/i,
  /\bthis\s+is\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})\b/i,
  /\bwe(?:'ve|\s+have)\s+(?:got\s+)?([A-Za-z]+(?:\s+[A-Za-z]+){0,2})\b/i,
];

const NAME_STOPWORDS = new Set([
  "unconscious", "unresponsive", "unknown", "stable", "alert", "awake",
  "responsive", "breathing", "talking", "approximately", "got", "the",
  "a", "an", "patient", "male", "female", "no",
]);

export function extractPatient(rawTranscript) {
  const transcript = (rawTranscript || "").toString();
  const lower = transcript.toLowerCase();
  const vitals = extractVitals(transcript);
  const condition = pickByLastOccurrence(lower, CONDITION_KEYWORDS);
  const chiefComplaint = extractChiefComplaint(transcript);

  return {
    name: extractName(transcript),
    age: extractAge(transcript),
    sex: extractSex(transcript),
    condition,
    mechanismOfInjury: extractMechanism(lower),
    severity: inferSeverity(vitals, lower),
    insuranceProvider: pickByLastOccurrence(lower, INSURANCE_KEYWORDS),
    address: extractLocation(transcript)?.phrase ?? null,
    chiefComplaint,
    bloodPressure: vitals.bp,
    heartRate: vitals.hr,
    oxygenSaturation: vitals.spo2,
    respiratoryRate: vitals.rr,
    summary: buildSummary({ age: extractAge(transcript), sex: extractSex(transcript), chiefComplaint, condition, vitals }),
    confidence: 0.65,
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

function extractName(transcript) {
  for (const pattern of NAME_PATTERNS) {
    const match = transcript.match(pattern);
    const captured = match?.[1]?.trim();
    if (!captured) continue;
    const tokens = captured.split(/\s+/);
    if (NAME_STOPWORDS.has(tokens[0].toLowerCase())) continue;
    // Require at least one token to be capitalized — proper-noun signal.
    if (!tokens.some((t) => /^[A-Z]/.test(t))) continue;
    return captured;
  }
  return null;
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

  const rrMatch = transcript.match(/\b(?:resp(?:iratory)?\s+rate|rr|respirations?)\s*(?:is|of|at)?\s*(\d{1,3})\b/i);
  const rr = rrMatch ? Number(rrMatch[1]) : null;

  return { bp, hr, spo2, rr };
}

function extractChiefComplaint(transcript) {
  const patterns = [
    // Explicit formal phrases
    /\b(?:chief\s+complaint|presenting\s+complaint|c\/c)\s*(?:is\s*|:\s*)?(.+?)(?:[.,;]|\band\b|$)/i,
    /\b(?:complaining\s+of|c\/o|presents?\s+with|presented?\s+with)\s+(.+?)(?:[.,;]|\band\b|$)/i,
    /\bpatient\s+(?:is\s+experiencing|is\s+having|reports?)\s+(.+?)(?:[.,;]|$)/i,
    // "patient has [a/an] ..."
    /\bpatient\s+has\s+(?:a\s+|an\s+)?(.+?)(?:[.,;]|$)/i,
    // "suffering from", "found with / found having", "with complaints of"
    /\b(?:suffering\s+from|found\s+(?:with|having)|with\s+complaints?\s+of)\s+(.+?)(?:[.,;]|$)/i,
    // Most common informal EMT pattern: "45-year-old male, [complaint]"
    /\b\d+[- ]?(?:year[- ]?old|y\/o|yo)\s+(?:male|female|man|woman)\s*,\s*(.+?)(?:[.,;]|$)/i,
    // "we've got / we have a [patient/male/female] with ..."
    /\bwe(?:'ve|\s+have)\s+(?:got\s+)?(?:a\s+)?(?:\w+\s+){0,4}with\s+(.+?)(?:[.,;]|$)/i,
    // "brought in for", "calling for", "responding to a"
    /\b(?:brought\s+in\s+for|calling\s+for|responding\s+to\s+a(?:n)?)\s+(.+?)(?:[.,;]|$)/i,
    // "he/she/they is/are [condition]" — e.g. "she is unresponsive"
    /\b(?:he|she|they)\s+(?:is|are)\s+(.+?)(?:[.,;]|$)/i,
  ];
  for (const p of patterns) {
    const m = transcript.match(p);
    const phrase = m?.[1]?.trim();
    if (phrase && phrase.length >= 3 && phrase.length <= 100) {
      return phrase.replace(/\.$/, "").trim();
    }
  }
  return null;
}

function extractMechanism(lowerTranscript) {
  const checks = [
    [/\bgsw\b|gunshot\s+wound/, "GSW"],
    [/\bstabbing\b|\bstab\s+wound/, "stab wound"],
    [/\bmvc\b|motor\s+vehicle\s+(?:crash|accident|collision)/, "MVC"],
    [/\bfall(?:ing|en)?\s+from\b/, "fall"],
    [/\bejection\b/, "ejection from vehicle"],
    [/\bblunt\s+force\b/, "blunt force trauma"],
    [/\bcardiac\s+arrest\b/, "cardiac arrest"],
    [/\bheart\s+attack\b|\bmyocardial\s+infarction\b/, "acute MI"],
    [/\bstemi\b/, "STEMI"],
    [/\bstroke\b|\bcva\b/, "stroke / CVA"],
    [/\bseizure/, "seizure"],
    [/\boverdose\b/, "overdose"],
  ];
  for (const [re, label] of checks) {
    if (re.test(lowerTranscript)) return label;
  }
  return null;
}

function extractMentalStatus(transcript) {
  const gcs = transcript.match(/\b(?:gcs|glasgow\s+coma\s+(?:scale|score)?)\s*(?:of\s*|is\s*|score\s*)?(\d{1,2})\b/i);
  if (gcs) return `GCS ${gcs[1]}`;
  const avpu = transcript.match(
    /\b(alert(?:\s+and\s+oriented(?:\s+(?:x|times)\s*\d)?)?|a&ox\d|unresponsive|unconscious|confused|disoriented|lethargic)\b/i
  );
  return avpu ? avpu[1] : null;
}

function extractInterventions(lowerTranscript) {
  const checks = [
    [/\bcpr\b|\bcompressions?\b/, "CPR"],
    [/\bintubat/, "intubated"],
    [/\b(?:o2|oxygen|non-rebreather|nasal\s+cannula)/, "O2"],
    [/\btourniquet/, "tourniquet"],
    [/\biv\s+(?:access|line|established|started)|iv\s+access/, "IV access"],
    [/\baspirin/, "aspirin"],
    [/\bnitro(?:glycerin)?/, "nitroglycerin"],
    [/\bepinephrine\b|\bepi\b/, "epinephrine"],
    [/\bnarcan\b|\bnaloxone/, "naloxone"],
    [/\bdefib(?:rillat)?/, "defibrillation"],
    [/\bspinal\s+immobilization|c-collar|cervical\s+collar/, "spinal immobilization"],
  ];
  const found = [];
  for (const [re, label] of checks) {
    if (re.test(lowerTranscript)) found.push(label);
  }
  return found.length > 0 ? found : null;
}

function inferSeverity(vitals, lowerTranscript) {
  if (
    lowerTranscript.includes("unresponsive")
    || lowerTranscript.includes("cardiac arrest")
    || (vitals.spo2 != null && vitals.spo2 < 90)
    || (vitals.hr != null && vitals.hr > 130)
  ) {
    return "critical";
  }
  if (
    lowerTranscript.includes("worsening")
    || lowerTranscript.includes("severe")
    || (vitals.spo2 != null && vitals.spo2 < 94)
    || (vitals.hr != null && vitals.hr > 110)
  ) {
    return "high";
  }
  return lowerTranscript.trim() ? "moderate" : null;
}

function buildSummary({ age, sex, chiefComplaint, condition, vitals }) {
  const parts = [];
  if (age || sex) parts.push(`${age ? `${age} year old` : "Patient"}${sex ? ` ${sex}` : ""}`);
  if (chiefComplaint) parts.push(`with ${chiefComplaint}`);
  else if (condition) parts.push(`with possible ${condition} emergency`);
  const vitalParts = [
    vitals.bp && `BP ${vitals.bp}`,
    vitals.hr && `HR ${vitals.hr}`,
    vitals.spo2 && `oxygen ${vitals.spo2}%`,
  ].filter(Boolean);
  if (vitalParts.length) parts.push(`Vitals: ${vitalParts.join(", ")}`);
  return parts.length ? `${parts.join(". ")}.` : null;
}
