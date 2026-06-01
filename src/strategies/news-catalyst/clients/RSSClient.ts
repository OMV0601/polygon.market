import Parser from 'rss-parser';

export interface RSSItem {
  guid: string;
  title: string;
  link: string;
  pubDate: Date;
  source: string;
}

const parser = new Parser({ timeout: 8_000 });

export async function fetchFeed(feedUrl: string): Promise<RSSItem[]> {
  const feed = await parser.parseURL(feedUrl);

  return (feed.items ?? [])
    .filter((item) => item.title && item.link)
    .map((item) => ({
      guid: item.guid ?? item.link ?? item.title ?? '',
      title: item.title!.trim(),
      link: item.link!,
      pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
      source: feedUrl,
    }));
}
