// daily-learning 多源改造测试：vc.ru RSS 解析 + 简报统计口径
import { describe, it, expect } from "vitest";
import { parseRssItems } from "../src/jobs/daily-learning.js";

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" version="2.0">
<channel><title>vc.ru: #ozon</title>
<item>
  <title>Как продавать на Ozon в 2026</title>
  <link>https://vc.ru/trade/12345-kak-prodavat-na-ozon</link>
  <dc:creator><![CDATA[Иван Петров]]></dc:creator>
  <pubDate>Sat, 05 Sep 2026 10:00:00 GMT</pubDate>
  <description><![CDATA[<p>Короткое описание</p>]]></description>
  <content:encoded><![CDATA[<p>Полный текст статьи про <b>Ozon</b> продажи.</p>]]></content:encoded>
</item>
<item>
  <title>Без контента только description</title>
  <link>https://vc.ru/trade/12346-test</link>
  <pubDate>Sat, 05 Sep 2026 12:00:00 GMT</pubDate>
  <description>Текст без CDATA обёртки</description>
</item>
<item><title></title><link></link></item>
</channel></rss>`;

describe("parseRssItems (vc.ru)", () => {
  it("解析 item：title/link/作者/正文/pubTs", () => {
    const items = parseRssItems(RSS_SAMPLE);
    expect(items).toHaveLength(2); // 空 item 被过滤
    expect(items[0].title).toBe("Как продавать на Ozon в 2026");
    expect(items[0].link).toContain("vc.ru/trade/12345");
    expect(items[0].author).toBe("Иван Петров");
    // content:encoded 优先于 description，HTML 标签被剥离
    expect(items[0].text).toContain("Полный текст статьи про Ozon продажи");
    expect(items[0].text).not.toContain("<b>");
    expect(items[0].pubTs).toBe(Date.parse("Sat, 05 Sep 2026 10:00:00 GMT") / 1000);
    // description 兜底
    expect(items[1].text).toBe("Текст без CDATA обёртки");
  });

  it("空 feed 返回空数组", () => {
    expect(parseRssItems("<rss><channel></channel></rss>")).toHaveLength(0);
  });
});
