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

export function extractPatient(rawTranscript) {
  const transcript = (rawTranscript || "").toString();
  const lower = transcript.toLowerCase();

  const specification = pickSpecification(lower);

  const ageMatch = transcript.match(/\b(\d{1,3})[- ]?(?:year[- ]?old|y\/o|yo)\b/i);
  const age = ageMatch ? Number(ageMatch[1]) : null;

  const sexMatch = transcript.match(/\b(male|female|man|woman)\b/i);
  const sex = sexMatch
    ? sexMatch[1].toLowerCase().startsWith("f") || sexMatch[1].toLowerCase() === "woman"
      ? "female"
      : "male"
    : null;

  const bpMatch = transcript.match(/\bbp\s*(?:is|of|at)?\s*(\d{2,3})\s*(?:over|\/|on)\s*(\d{2,3})/i)
    ?? transcript.match(/\b(\d{2,3})\s*over\s*(\d{2,3})\b/i);
  const bp = bpMatch ? `${bpMatch[1]}/${bpMatch[2]}` : null;

  const hrMatch = transcript.match(/\b(?:hr|heart rate|pulse)\s*(?:is|of|at)?\s*(\d{2,3})\b/i);
  const hr = hrMatch ? Number(hrMatch[1]) : null;

  const spo2Match = transcript.match(/\b(?:spo2|sp02|sat|sats|oxygen|o2)\s*(?:is|of|at)?\s*(\d{2,3})\b/i);
  const spo2 = spo2Match ? Number(spo2Match[1]) : null;

  return {
    specification,
    age,
    sex,
    vitals: { bp, hr, spo2 },
    transcript: transcript.trim(),
  };
}

function pickSpecification(lowerTranscript) {
  let best = null;
  let bestIndex = -1;

  for (const [spec, terms] of Object.entries(SPEC_KEYWORDS)) {
    for (const term of terms) {
      const idx = lowerTranscript.lastIndexOf(term);
      if (idx > bestIndex) {
        bestIndex = idx;
        best = spec;
      }
    }
  }

  return best;
}
