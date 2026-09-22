import { fetchFeed } from "./lib/rss";
import { readConfig, setUser } from "./config";
import {
  createPost,
  getPostsForUser,
  searchPostsForUser,
} from "./lib/db/queries/posts";
import {
  createFeed,
  getFeeds,
  getFeedByUrl,
  createFeedFollow,
  getFeedFollowsForUser,
  deleteFeedFollow,
  markFeedFetched,
  getNextFeedToFetch,
} from "./lib/db/queries/feeds";
import type { Feed, User } from "./lib/db/schema";
import {
  createUser,
  getUserByName,
  deleteAllUsers,
  getUsers,
} from "./lib/db/queries/users";
type CommandHandler = (
  cmdName: string,
  ...args: string[]
) => Promise<void>;
type UserCommandHandler = (
  cmdName: string,
  user: User,
  ...args: string[]
) => Promise<void>;

type CommandsRegistry = {
  [key: string]: CommandHandler;
};
function middlewareLoggedIn(
  handler: UserCommandHandler
): CommandHandler {
  return async (
    cmdName: string,
    ...args: string[]
  ): Promise<void> => {
    const config = readConfig();

    const user = await getUserByName(config.currentUserName);

    if (!user) {
      throw new Error("current user not found");
    }

    await handler(cmdName, user, ...args);
  };
}

async function handlerLogin(
  cmdName: string,
  ...args: string[]
): Promise<void> {
  if (args.length === 0) {
    throw new Error("Username is required");
  }

  const username = args[0];

  const user = await getUserByName(username);

  if (!user) {
    throw new Error(`User ${username} does not exist`);
  }

  const config = readConfig();
  setUser(config, username);

  console.log(`User has been set to ${username}`);
}

async function handlerRegister(
  cmdName: string,
  ...args: string[]
): Promise<void> {
  if (args.length === 0) {
    throw new Error("Username is required");
  }

  const username = args[0];

  const existingUser = await getUserByName(username);

  if (existingUser) {
    throw new Error(`User ${username} already exists`);
  }

  const user = await createUser(username);

  const config = readConfig();
  setUser(config, username);

  console.log(`User ${username} was created`);
  console.log(user);
}

async function handlerReset(
  cmdName: string,
  ...args: string[]
): Promise<void> {
  await deleteAllUsers();
  console.log("Database reset successfully");
}

async function handlerUsers(
  cmdName: string,
  ...args: string[]
): Promise<void> {
  const config = readConfig();
  const allUsers = await getUsers();

  for (const user of allUsers) {
    if (user.name === config.currentUserName) {
      console.log(`* ${user.name} (current)`);
    } else {
      console.log(`* ${user.name}`);
    }
  }
}


function handleError(err: unknown): void {
  if (err instanceof Error) {
    console.error(err.message);
  } else {
    console.error(err);
  }
}


async function handlerAgg(
  cmdName: string,
  ...args: string[]
): Promise<void> {
  if (args.length !== 1) {
    throw new Error("time_between_reqs is required");
  }

  const durationStr = args[0];
  const timeBetweenRequests = parseDuration(durationStr);

  console.log(`Collecting feeds every ${durationStr}`);

  scrapeFeeds().catch(handleError);

  const interval = setInterval(() => {
    scrapeFeeds().catch(handleError);
  }, timeBetweenRequests);

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log("Shutting down feed aggregator...");
      clearInterval(interval);
      resolve();
    });
  });
}
async function handlerFeeds(
  cmdName: string,
  ...args: string[]
): Promise<void> {
  const allFeeds = await getFeeds();

  for (const { feed, user } of allFeeds) {
    printFeed(feed, user);
  }
}
async function handlerAddFeed(
  cmdName: string,
  user: User,
  ...args: string[]
): Promise<void> {
  if (args.length < 2) {
    throw new Error("name and url are required");
  }

  const name = args[0];
  const url = args[1];

  const feed = await createFeed(name, url, user.id);

  printFeed(feed, user);

  const feedFollow = await createFeedFollow(user.id, feed.id);

  console.log(`Following: ${feedFollow.feedName}`);
  console.log(`User: ${feedFollow.userName}`);

}

async function handlerFollow(
  cmdName: string,
  user: User,
  ...args: string[]
): Promise<void> {
  if (args.length === 0) {
    throw new Error("url is required");
  }

  const url = args[0];

  const feed = await getFeedByUrl(url);

  if (!feed) {
    throw new Error("feed not found");
  }

  const feedFollow = await createFeedFollow(user.id, feed.id);

  console.log(`Following: ${feedFollow.feedName}`);
  console.log(`User: ${feedFollow.userName}`);
}

async function handlerFollowing(
  cmdName: string,
  user: User,
  ...args: string[]
): Promise<void> {
  const feedFollows = await getFeedFollowsForUser(user.id);

  for (const feedFollow of feedFollows) {
    console.log(feedFollow.feedName);
  }
}
async function handlerUnfollow(
  cmdName: string,
  user: User,
  ...args: string[]
): Promise<void> {
  if (args.length === 0) {
    throw new Error("url is required");
  }

  const url = args[0];

  await deleteFeedFollow(user.id, url);

  console.log(`Unfollowed ${url}`);
}
function parseDuration(durationStr: string): number {
  const regex = /^(\d+)(ms|s|m|h)$/;
  const match = durationStr.match(regex);

  if (!match) {
    throw new Error("Invalid duration");
  }

  const amount = Number(match[1]);
  const unit = match[2];

  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60 * 1000;
    case "h":
      return amount * 60 * 60 * 1000;
    default:
      throw new Error("Invalid duration unit");
  }
}

async function scrapeFeeds(): Promise<void> {
  const feed = await getNextFeedToFetch();

  if (!feed) {
    console.log("No feeds found");
    return;
  }

  console.log(`Fetching: ${feed.name} (${feed.url})`);

  const rssFeed = await fetchFeed(feed.url);

  for (const item of rssFeed.channel.item) {
    const publishedAt = new Date(item.pubDate);

    if (Number.isNaN(publishedAt.getTime())) {
      console.log(`Skipping post with invalid date: ${item.title}`);
      continue;
    }

    await createPost(
      item.title,
      item.link,
      item.description,
      publishedAt,
      feed.id
    );
  }

  await markFeedFetched(feed.id);
}

async function handlerBrowse(
  cmdName: string,
  user: User,
  ...args: string[]
): Promise<void> {
  let limit = 2;
  let page = 1;
  let sort: "newest" | "oldest" = "newest";
  let feedName: string | undefined;

  let i = 0;

  if (args.length > 0 && /^\d+$/.test(args[0])) {
    limit = Number(args[0]);
    i = 1;
  }

  while (i < args.length) {
    if (args[i] === "--page") {
      page = Number(args[i + 1]);
      i += 2;
      continue;
    }

    if (args[i] === "--sort") {
      const value = args[i + 1];

      if (value !== "newest" && value !== "oldest") {
        throw new Error("sort must be newest or oldest");
      }

      sort = value;
      i += 2;
      continue;
    }

    if (args[i] === "--feed") {
      feedName = args[i + 1];
      i += 2;
      continue;
    }

    throw new Error(`Unknown browse option: ${args[i]}`);
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }

  if (!Number.isInteger(page) || page <= 0) {
    throw new Error("page must be a positive integer");
  }

  const offset = (page - 1) * limit;

  const userPosts = await getPostsForUser(
    user.id,
    limit,
    offset,
    sort,
    feedName
  );

  console.log(
    `Page ${page} | Sort: ${sort}` +
      (feedName ? ` | Feed: ${feedName}` : "")
  );
  console.log();

  for (const post of userPosts) {
    console.log(`Title: ${post.title}`);
    console.log(`Feed: ${post.feedName}`);
    console.log(`URL: ${post.url}`);
    console.log(`Published: ${post.publishedAt}`);

    const cleanDescription = (post.description ?? "")
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("Article URL:") &&
          !line.trim().startsWith("Comments URL:") &&
          !line.trim().startsWith("Points:") &&
          !line.trim().startsWith("# Comments:")
      )
      .join("\n")
      .trim();

    if (cleanDescription) {
      console.log(`Description: ${cleanDescription}`);
    }

    console.log();
  }
}
function printFeed(feed: Feed, user: User): void {
  console.log(`Feed name: ${feed.name}`);
  console.log(`Feed URL: ${feed.url}`);
  console.log(`Added by: ${user.name}`);
}


async function handlerSearch(
  cmdName: string,
  user: User,
  ...args: string[]
): Promise<void> {
  if (args.length === 0) {
    throw new Error("search query is required");
  }

  const query = args.join(" ");

  const results = await searchPostsForUser(
    user.id,
    query,
    10
  );

  if (results.length === 0) {
    console.log("No matching posts found");
    return;
  }

  console.log(`Search results for: ${query}`);
  console.log();

  for (const post of results) {
    console.log(`Title: ${post.title}`);
    console.log(`Feed: ${post.feedName}`);
    console.log(`URL: ${post.url}`);
    console.log(`Published: ${post.publishedAt}`);
    console.log();
  }
}
function registerCommand(
  registry: CommandsRegistry,
  cmdName: string,
  handler: CommandHandler
): void {
  registry[cmdName] = handler;
}

async function runCommand(
  registry: CommandsRegistry,
  cmdName: string,
  ...args: string[]
): Promise<void> {
  const handler = registry[cmdName];

  if (!handler) {
    throw new Error(`Unknown command: ${cmdName}`);
  }

  await handler(cmdName, ...args);
}

async function main() {
  const registry: CommandsRegistry = {};
registerCommand(registry, "login", handlerLogin);
registerCommand(registry, "register", handlerRegister);
registerCommand(registry, "reset", handlerReset);
registerCommand(registry, "users", handlerUsers);
registerCommand(registry, "agg", handlerAgg);
registerCommand(
  registry,
  "browse",
  middlewareLoggedIn(handlerBrowse)
);

registerCommand(
  registry,
  "addfeed",
  middlewareLoggedIn(handlerAddFeed)
);

registerCommand(
  registry,
  "feeds",
  handlerFeeds
);

registerCommand(
  registry,
  "follow",
  middlewareLoggedIn(handlerFollow)
);

registerCommand(
  registry,
  "following",
  middlewareLoggedIn(handlerFollowing)
);

registerCommand(
  registry,
  "unfollow",
  middlewareLoggedIn(handlerUnfollow)
);
 
registerCommand(
  registry,
  "unfollow",
  middlewareLoggedIn(handlerUnfollow)
);

registerCommand(
  registry,
  "search",
  middlewareLoggedIn(handlerSearch)
);

const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error("Not enough arguments provided");
    process.exit(1);
  }

  const cmdName = args[0];
  const cmdArgs = args.slice(1);

  try {
    await runCommand(registry, cmdName, ...cmdArgs);
  } catch (err) {
    if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error(err);
    }

    process.exit(1);
  }

  process.exit(0);
}

main();
