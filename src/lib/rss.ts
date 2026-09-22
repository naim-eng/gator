import { XMLParser } from "fast-xml-parser";

export type RSSFeed = {
  channel: {
    title: string;
    link: string;
    description: string;
    item: RSSItem[];
  };
};

export type RSSItem = {
  title: string;
  link: string;
  description: string;
  pubDate: string;
};

export async function fetchFeed(feedURL: string): Promise<RSSFeed> {
  const response = await fetch(feedURL, {
    headers: {
      "User-Agent": "gator",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch feed: ${response.status}`);
  }

  const xml = await response.text();

  const parser = new XMLParser({
    processEntities: false,
  });

  const parsed = parser.parse(xml);

  const channel = parsed?.rss?.channel;

  if (!channel || typeof channel !== "object") {
    throw new Error("RSS channel not found");
  }

  const title = channel.title;
  const link = channel.link;
  const description = channel.description;

  if (
    typeof title !== "string" ||
    typeof link !== "string" ||
    typeof description !== "string"
  ) {
    throw new Error("Invalid RSS channel metadata");
  }

  let rawItems: any[] = [];

  if (channel.item) {
    rawItems = Array.isArray(channel.item)
      ? channel.item
      : [channel.item];
  }

  const items: RSSItem[] = [];

  for (const item of rawItems) {
    if (
      typeof item?.title !== "string" ||
      typeof item?.link !== "string" ||
      typeof item?.description !== "string" ||
      typeof item?.pubDate !== "string"
    ) {
      continue;
    }

    items.push({
      title: item.title,
      link: item.link,
      description: item.description,
      pubDate: item.pubDate,
    });
  }

  return {
    channel: {
      title,
      link,
      description,
      item: items,
    },
  };
}
