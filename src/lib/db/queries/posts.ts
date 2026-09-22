import { desc, eq } from "drizzle-orm";
import { db } from "../index";
import { posts, feeds, feedFollows } from "../schema";

export async function createPost(
  title: string,
  url: string,
  description: string | null,
  publishedAt: Date,
  feedId: string
) {
  const [result] = await db
    .insert(posts)
    .values({
      title,
      url,
      description,
      publishedAt,
      feedId,
    })
    .onConflictDoNothing({
      target: posts.url,
    })
    .returning();

  return result;
}

export async function getPostsForUser(
  userId: string,
  limit: number
) {
  const result = await db
    .select({
      id: posts.id,
      title: posts.title,
      url: posts.url,
      description: posts.description,
      publishedAt: posts.publishedAt,
      feedId: posts.feedId,
    })
    .from(posts)
    .innerJoin(feeds, eq(posts.feedId, feeds.id))
    .innerJoin(
      feedFollows,
      eq(feedFollows.feedId, feeds.id)
    )
    .where(eq(feedFollows.userId, userId))
    .orderBy(desc(posts.publishedAt))
    .limit(limit);

  return result;
}
