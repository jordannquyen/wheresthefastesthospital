import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

if (process.env.ALLOW_DB_RESET !== "true") {
  console.error("Refusing to reset patients. Set ALLOW_DB_RESET=true to run this development-only script.");
  process.exit(1);
}

const mongoUri = process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB_NAME;

if (!mongoUri || !mongoDbName) {
  console.error("MONGODB_URI and MONGODB_DB_NAME are required.");
  process.exit(1);
}

const client = new MongoClient(mongoUri);

try {
  await client.connect();
  const result = await client.db(mongoDbName).collection("patients").deleteMany({});
  console.log(`Deleted ${result.deletedCount} patient record${result.deletedCount === 1 ? "" : "s"}.`);
} finally {
  await client.close();
}
