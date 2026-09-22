import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  randomBytes,
  createHash,
} from "node:crypto";

import {
  createApiKey,
  getUserByApiKeyHash,
} from "./lib/db/queries/apiKeys";

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { fetchFeed } from "./lib/rss";
import { readConfig, setUser } from "./config";

import {
  createPost,
  getPostsForUser,
  searchPostsForUser,
  getPostByUrl,
  createBookmark,
  deleteBookmark,
  getBookmarksForUser,
} from "./lib/db/queries/posts";

import {
  createFeed,
  getFeeds,
  getFeedByUrl,
  createFeedFollow,
getFeedsToFetch,  
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




async function scrapeSingleFeed(feed: Feed): Promise<void> {
  console.log(`Fetching: ${feed.name} (${feed.url})`);

  try {
    const rssFeed = await fetchFeed(feed.url);

    for (const item of rssFeed.channel.item) {
      const publishedAt = new Date(item.pubDate);

      if (Number.isNaN(publishedAt.getTime())) {
        console.log(`Skipping invalid date: ${item.title}`);
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

    console.log(`Finished: ${feed.name}`);
  } catch (err) {
    if (err instanceof Error) {
      console.error(`Failed ${feed.name}: ${err.message}`);
    } else {
      console.error(`Failed ${feed.name}`);
    }
  }
}

async function scrapeFeeds(): Promise<void> {
  const feedsToFetch = await getFeedsToFetch(3);

  if (feedsToFetch.length === 0) {
    console.log("No feeds found");
    return;
  }

  console.log(
    `Fetching ${feedsToFetch.length} feed(s) concurrently...`
  );

  await Promise.all(
    feedsToFetch.map((feed) => scrapeSingleFeed(feed))
  );
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

async function handlerBookmark(
  cmdName: string,
  user: User,
  ...args: string[]
): Promise<void> {
  if (args.length === 0) {
    throw new Error("post URL is required");
  }

  const url = args[0];

  const post = await getPostByUrl(url);

  if (!post) {
    throw new Error("post not found");
  }

  await createBookmark(user.id, post.id);

  console.log(`Bookmarked: ${post.title}`);
}


async function handlerUnbookmark(
  cmdName: string,
  user: User,
  ...args: string[]
): Promise<void> {
  if (args.length === 0) {
    throw new Error("post URL is required");
  }

  const url = args[0];

  const post = await getPostByUrl(url);

  if (!post) {
    throw new Error("post not found");
  }

  const deleted = await deleteBookmark(
    user.id,
    post.id
  );

  if (!deleted) {
    throw new Error("bookmark not found");
  }

  console.log(`Removed bookmark: ${post.title}`);
}


async function handlerBookmarks(
  cmdName: string,
  user: User,
  ...args: string[]
): Promise<void> {
  let limit = 10;

  if (args.length > 0) {
    limit = Number(args[0]);

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("limit must be a positive integer");
    }
  }

  const bookmarks = await getBookmarksForUser(
    user.id,
    limit
  );

  if (bookmarks.length === 0) {
    console.log("No bookmarks found");
    return;
  }

  for (const post of bookmarks) {
    console.log(`Title: ${post.title}`);
    console.log(`Feed: ${post.feedName}`);
    console.log(`URL: ${post.url}`);
    console.log(`Published: ${post.publishedAt}`);
    console.log();
  }
}


function cleanPostDescription(description: string | null): string {
  return (description ?? "")
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
}

async function handlerTui(
  cmdName: string,
  user: User,
  ...args: string[]
): Promise<void> {
  let limit = 10;

  if (args.length > 0) {
    limit = Number(args[0]);

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("limit must be a positive integer");
    }
  }

  const rl = createInterface({
    input,
    output,
  });

  try {
    while (true) {
      const posts = await getPostsForUser(
        user.id,
        limit,
        0,
        "newest"
      );

      if (posts.length === 0) {
        console.log("No posts found");
        return;
      }

      console.clear();

      console.log("==================================");
      console.log("         GATOR POST READER");
      console.log("==================================");
      console.log();

      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];

        console.log(`${i + 1}. ${post.title}`);
        console.log(`   Feed: ${post.feedName}`);
        console.log(
          `   Published: ${post.publishedAt.toLocaleString()}`
        );
        console.log();
      }

      console.log("q. Quit");

      const answer = (
        await rl.question("\nSelect a post: ")
      )
        .trim()
        .toLowerCase();

      if (answer === "q") {
        return;
      }

      const selection = Number(answer);

      if (
        !Number.isInteger(selection) ||
        selection < 1 ||
        selection > posts.length
      ) {
        console.log("Invalid selection.");
        await rl.question("Press Enter to continue...");
        continue;
      }

      const post = posts[selection - 1];

      console.clear();

      console.log("==================================");
      console.log(post.title);
      console.log("==================================");
      console.log();

      console.log(`Feed: ${post.feedName}`);
      console.log(`Published: ${post.publishedAt.toLocaleString()}`);
      console.log();
      console.log(`URL: ${post.url}`);
      console.log();

      const description = cleanPostDescription(
        post.description
      );

      if (description) {
        console.log("Description:");
        console.log();
        console.log(description);
        console.log();
      }

      const next = (
        await rl.question(
          "Press Enter to go back, or q to quit: "
        )
      )
        .trim()
        .toLowerCase();

      if (next === "q") {
        return;
      }
    }
  } finally {
    rl.close();
  }
}

function hashApiKey(token: string): string {
  return createHash("sha256")
    .update(token)
    .digest("hex");
}

function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");

  res.end(JSON.stringify(data, null, 2));
}

async function authenticateRequest(
  req: IncomingMessage
): Promise<User | undefined> {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = authorization.slice(7).trim();

  if (!token) {
    return undefined;
  }

  return await getUserByApiKeyHash(
    hashApiKey(token)
  );
}

async function readJsonBody(
  req: IncomingMessage
): Promise<any> {
  let body = "";

  for await (const chunk of req) {
    body += chunk;
  }

  if (!body) {
    return {};
  }

  return JSON.parse(body);
}

async function handlerApiKey(
  cmdName: string,
  user: User,
  ...args: string[]
): Promise<void> {
  const token = randomBytes(32).toString("hex");

  await createApiKey(
    user.id,
    hashApiKey(token)
  );

  console.log("API key created.");
  console.log();
  console.log(token);
  console.log();
  console.log(
    "Save this key somewhere safe. It will not be shown again."
  );
}

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`
  );

  if (
    req.method === "GET" &&
    url.pathname === "/health"
  ) {
    sendJson(res, 200, {
      status: "ok",
    });

    return;
  }

  const user = await authenticateRequest(req);

  if (!user) {
    sendJson(res, 401, {
      error: "Unauthorized",
    });

    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/posts"
  ) {
    const requestedLimit = Number(
      url.searchParams.get("limit") ?? "10"
    );

    const limit =
      Number.isInteger(requestedLimit) &&
      requestedLimit > 0
        ? Math.min(requestedLimit, 100)
        : 10;

    const posts = await getPostsForUser(
      user.id,
      limit,
      0,
      "newest"
    );

    sendJson(res, 200, posts);
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/bookmarks"
  ) {
    const bookmarks =
      await getBookmarksForUser(user.id, 20);

    sendJson(res, 200, bookmarks);
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/bookmarks"
  ) {
    const body = await readJsonBody(req);

    if (
      typeof body.url !== "string" ||
      !body.url
    ) {
      sendJson(res, 400, {
        error: "url is required",
      });

      return;
    }

    const post = await getPostByUrl(body.url);

    if (!post) {
      sendJson(res, 404, {
        error: "Post not found",
      });

      return;
    }

    await createBookmark(
      user.id,
      post.id
    );

    sendJson(res, 201, {
      message: "Post bookmarked",
      title: post.title,
    });

    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/follow"
  ) {
    const body = await readJsonBody(req);

    if (
      typeof body.url !== "string" ||
      !body.url
    ) {
      sendJson(res, 400, {
        error: "url is required",
      });

      return;
    }

    const feed = await getFeedByUrl(body.url);

    if (!feed) {
      sendJson(res, 404, {
        error: "Feed not found",
      });

      return;
    }

    await createFeedFollow(
      user.id,
      feed.id
    );

    sendJson(res, 201, {
      message: "Feed followed",
      feed: feed.name,
    });

    return;
  }

  sendJson(res, 404, {
    error: "Not found",
  });
}

async function handlerServe(
  cmdName: string,
  ...args: string[]
): Promise<void> {
  const port = args.length > 0
    ? Number(args[0])
    : 8080;

  if (
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65535
  ) {
    throw new Error("invalid port");
  }

  const server = createServer(
    (req, res) => {
      handleApiRequest(req, res).catch(
        (err) => {
          console.error(err);

          if (!res.headersSent) {
            sendJson(res, 500, {
              error: "Internal server error",
            });
          }
        }
      );
    }
  );

  await new Promise<void>(
    (resolve, reject) => {
      server.once("error", reject);

      server.listen(
        port,
        "127.0.0.1",
        () => {
          console.log(
            `Gator API running on http://127.0.0.1:${port}`
          );

          console.log(
            "Press Ctrl+C to stop."
          );
        }
      );

      process.on("SIGINT", () => {
        console.log(
          "\nShutting down Gator API..."
        );

        server.close(() => {
          resolve();
        });
      });
    }
  );
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


registerCommand(
  registry,
  "bookmark",
  middlewareLoggedIn(handlerBookmark)
);

registerCommand(
  registry,
  "unbookmark",
  middlewareLoggedIn(handlerUnbookmark)
);

registerCommand(
  registry,
  "bookmarks",
  middlewareLoggedIn(handlerBookmarks)
);


registerCommand(
  registry,
  "tui",
  middlewareLoggedIn(handlerTui)
);

registerCommand(
  registry,
  "apikey",
  middlewareLoggedIn(handlerApiKey)
);

registerCommand(
  registry,
  "serve",
  handlerServe
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
