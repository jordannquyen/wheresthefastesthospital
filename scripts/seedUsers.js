import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

dotenv.config();

const mongoUri = process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB_NAME;

if (!mongoUri || !mongoDbName) {
  console.error("MONGODB_URI and MONGODB_DB_NAME are required.");
  process.exit(1);
}

const allowOverwrite = process.env.ALLOW_USER_OVERWRITE === "true";

// Demo users. Hospital users need a real Socrata `hospital_pk` — look these up
// once via `GET /api/hospitals?city=LOS%20ANGELES` and update the values below.
// If `hospitalId` doesn't appear in the Socrata cache, the seed warns but still
// inserts; signups via the UI use the same validation and will catch typos.
const SEED_USERS = [
  { username: "emt1", password: "emt-pass", role: "emt", displayName: "EMT One" },
  { username: "admin1", password: "admin-pass", role: "admin", displayName: "Admin" },
  // Replace these hospitalId values with real hospital_pk strings for your demo.
  { username: "hospital-ucla", password: "ucla-pass", role: "hospital", hospitalId: "REPLACE_ME_UCLA_PK", displayName: "UCLA Front Desk" },
  { username: "hospital-cedars", password: "cedars-pass", role: "hospital", hospitalId: "REPLACE_ME_CEDARS_PK", displayName: "Cedars Front Desk" },
];

async function fetchSocrataHospitals() {
  try {
    const url = new URL("https://healthdata.gov/resource/anag-cw7u.json");
    url.searchParams.set("$limit", "150");
    url.searchParams.set("state", "CA");
    url.searchParams.set("$where", "city='LOS ANGELES'");
    url.searchParams.set("$order", "collection_week DESC");
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const raw = await res.json();
    return raw;
  } catch {
    return [];
  }
}

const client = new MongoClient(mongoUri);

try {
  await client.connect();
  const collection = client.db(mongoDbName).collection("users");

  await collection.createIndexes([
    { key: { username: 1 }, unique: true },
    { key: { hospitalId: 1 } },
  ]);

  const socrataHospitals = await fetchSocrataHospitals();
  const knownPks = new Set(socrataHospitals.map((h) => String(h.hospital_pk)));

  let inserted = 0;
  let skipped = 0;
  let updated = 0;

  for (const seed of SEED_USERS) {
    const username = seed.username.trim().toLowerCase();
    const existing = await collection.findOne({ username });

    if (existing && !allowOverwrite) {
      console.log(`= skip   ${username} (already exists; set ALLOW_USER_OVERWRITE=true to overwrite)`);
      skipped++;
      continue;
    }

    let hospitalName = null;
    if (seed.role === "hospital") {
      if (!seed.hospitalId || seed.hospitalId.startsWith("REPLACE_ME")) {
        console.warn(`! warn   ${username}: hospitalId is a placeholder; replace it before running for real.`);
      } else if (!knownPks.has(String(seed.hospitalId))) {
        console.warn(`! warn   ${username}: hospitalId "${seed.hospitalId}" not found in Socrata LA cache.`);
      } else {
        const match = socrataHospitals.find((h) => String(h.hospital_pk) === String(seed.hospitalId));
        hospitalName = match?.hospital_name ?? null;
      }
    }

    const passwordHash = await bcrypt.hash(seed.password, 10);
    const now = new Date();

    if (existing) {
      await collection.updateOne(
        { username },
        {
          $set: {
            passwordHash,
            role: seed.role,
            hospitalId: seed.role === "hospital" ? String(seed.hospitalId) : null,
            hospitalName,
            displayName: seed.displayName ?? null,
            updatedAt: now,
          },
        }
      );
      console.log(`✎ update ${username} (role=${seed.role}${seed.hospitalId ? `, hospitalId=${seed.hospitalId}` : ""})`);
      updated++;
    } else {
      await collection.insertOne({
        userId: randomUUID(),
        username,
        passwordHash,
        role: seed.role,
        hospitalId: seed.role === "hospital" ? String(seed.hospitalId) : null,
        hospitalName,
        displayName: seed.displayName ?? null,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`+ insert ${username} (role=${seed.role}${seed.hospitalId ? `, hospitalId=${seed.hospitalId}` : ""})`);
      inserted++;
    }
  }

  console.log(`\nDone. inserted=${inserted}, updated=${updated}, skipped=${skipped}`);
} finally {
  await client.close();
}
