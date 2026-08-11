import { MongoClient, type Db } from "mongodb";

let client: MongoClient | null = null;
let db: Db | null = null;

export async function getDb(): Promise<Db | null> {
  const uri = process.env.MONGO_URI;
  if (!uri) return null;

  if (db) return db;

  client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db("foundry_agent");
  return db;
}

export interface TurnDocument {
  agentSessionId: string;
  conversationId?: string;
  responseId: string;
  userMessage: string;
  assistantReply: string;
  delegations: { agent: string; ok: boolean }[];
  timestamp: Date;
}

/**
 * Persist a completed conversation turn to MongoDB.
 * Fire-and-forget safe — errors are logged, never thrown.
 */
export async function persistTurn(doc: TurnDocument): Promise<void> {
  try {
    const database = await getDb();
    if (!database) return;
    await database.collection<TurnDocument>("turns").insertOne(doc);
  } catch (err) {
    console.error("[mongo] failed to persist turn:", err instanceof Error ? err.message : err);
  }
}
