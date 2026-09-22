
import { asc, desc, eq, and, ilike, or } from "drizzle-orm";
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
  limit: number,
  offset: number = 0,
  sort: "newest" | "oldest" = "newest",
  feedName?: string
) {
  const result = await db
    .select({
      id: posts.id,
      title: posts.title,
      url: posts.url,
      description: posts.description,
      publishedAt: posts.publishedAt,
      feedId: posts.feedId,
      feedName: feeds.name,
    })
    .from(posts)
    .innerJoin(feeds, eq(posts.feedId, feeds.id))
    .innerJoin(
      feedFollows,
      eq(feedFollows.feedId, feeds.id)
    )
    .where(
      and(
        eq(feedFollows.userId, userId),
        feedName ? ilike(feeds.name, `%${feedName}%`) : undefined
      )
    )
    .orderBy(
      sort === "oldest"
        ? asc(posts.publishedAt)
        : desc(posts.publishedAt)
    )
    .limit(limit)
    .offset(offset);

  return result;
}


export async function searchPostsForUser(
  userId: string,
  query: string,
  limit: number = 10
) {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const searchConditions = terms.map((term) =>
    or(
      ilike(posts.title, `%${term}%`),
      ilike(posts.description, `%${term}%`)
    )
  );

  const result = await db
    .select({
      id: posts.id,
      title: posts.title,
      url: posts.url,
      description: posts.description,
      publishedAt: posts.publishedAt,
      feedId: posts.feedId,
      feedName: feeds.name,
    })
    .from(posts)
    .innerJoin(feeds, eq(posts.feedId, feeds.id))
    .innerJoin(
      feedFollows,
      eq(feedFollows.feedId, feeds.id)
    )
    .where(
      and(
        eq(feedFollows.userId, userId),
        ...searchConditions
      )
    )
    .orderBy(desc(posts.publishedAt))
    .limit(limit);

  return result;
}
