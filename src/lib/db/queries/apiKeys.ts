import { eq } from "drizzle-orm";
import { db } from "../index";
import { apiKeys, users } from "../schema";

export async function createApiKey(
  userId: string,
  tokenHash: string
) {
  const [result] = await db
    .insert(apiKeys)
    .values({
      userId,
      tokenHash,
    })
    .returning();

  return result;
}

export async function getUserByApiKeyHash(
  tokenHash: string
) {
  const [result] = await db
    .select({
      user: users,
    })
    .from(apiKeys)
    .innerJoin(
      users,
      eq(apiKeys.userId, users.id)
    )
    .where(eq(apiKeys.tokenHash, tokenHash));

  return result?.user;
}
