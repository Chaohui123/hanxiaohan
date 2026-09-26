// daily-learning 多源改造测试：RSS 解析 + Reddit JSON 解析 + 俄文媒体过滤 + seller-edu 提取 + 简报统计口径
import { describe, it, expect } from "vitest";
import {
  parseRssItems,
  parseRedditPosts,
  isRuMediaRelevant,
  extractSellerEduLinks,
  extractSellerEduArticle,
} from "../src/jobs/daily-learning.js";

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

// ---- 源 3 Reddit：listing JSON 解析 ----

const REDDIT_SAMPLE = JSON.stringify({
  data: {
    children: [
      {
        data: {
          title: "How I scaled my store to $50k/mo",
          selftext: "Long story about email marketing and SEO...",
          permalink: "/r/ecommerce/comments/abc123/how_i_scaled/",
          score: 156,
          author: "seller_one",
          created_utc: 1757000000,
        },
      },
      {
        data: {
          title: "Low effort question",
          selftext: "",
          permalink: "/r/ecommerce/comments/def456/low_effort/",
          score: 3, // 低于 minScore 应被过滤
          author: "newbie",
          created_utc: 1757000100,
        },
      },
      {
        data: {
          title: "", // 无标题应被过滤
          permalink: "/r/ecommerce/comments/ghi789/empty/",
          score: 100,
        },
      },
      {
        data: {
          title: "FBA vs 3PL in 2026",
          selftext: "Cost breakdown...",
          permalink: "/r/FulfillmentByAmazon/comments/jkl012/fba_vs_3pl/",
          score: 42,
          author: "fba_pro",
          created_utc: 1757000200,
        },
      },
    ],
  },
});

describe("parseRedditPosts (Reddit 源)", () => {
  it("按 score 过滤、permalink 作幂等键、字段完整", () => {
    const items = parseRedditPosts(REDDIT_SAMPLE, 20, 10);
    expect(items).toHaveLength(2); // 低分与无标题被过滤
    expect(items[0].sourceId).toBe("/r/ecommerce/comments/abc123/how_i_scaled/");
    expect(items[0].source).toBe("reddit");
    expect(items[0].url).toBe("https://www.reddit.com/r/ecommerce/comments/abc123/how_i_scaled/");
    expect(items[0].author).toBe("seller_one");
    expect(items[0].text).toContain("email marketing");
    expect(items[0].publishedAt).toBe(1757000000);
    expect(items[1].title).toBe("FBA vs 3PL in 2026");
  });

  it("maxPerSub 截断生效", () => {
    expect(parseRedditPosts(REDDIT_SAMPLE, 20, 1)).toHaveLength(1);
  });

  it("非法 JSON 返回空数组（fail-open）", () => {
    expect(parseRedditPosts("not json", 20, 10)).toHaveLength(0);
  });
});

// ---- 源 4 俄文媒体：标题关键词过滤 ----

describe("isRuMediaRelevant (俄文媒体过滤)", () => {
  it("命中 ozon/маркетплейс/продвижение/выдача/селлер/e-commerce", () => {
    expect(isRuMediaRelevant("Ozon запустил новый сервис")).toBe(true);
    expect(isRuMediaRelevant("Как работать с маркетплейсами")).toBe(true); // 大小写不敏感
    expect(isRuMediaRelevant("Продвижение товаров в выдаче")).toBe(true);
    expect(isRuMediaRelevant("Советы селлерам по e-commerce")).toBe(true);
  });

  it("泛零售新闻被过滤", () => {
    expect(isRuMediaRelevant("Открылась новая сеть магазинов в Москве")).toBe(false);
    expect(isRuMediaRelevant("")).toBe(false);
  });
});

// ---- 源 5 seller-edu：列表链接提取 + 正文提取 ----

const SELLER_EDU_LIST_HTML = `
<html><body>
  <a href="/school/lessons/kak-prodavat-na-ozon">Урок 1</a>
  <a href="https://seller-edu.ozon.ru/school/lessons/reklama-na-ozon?utm_source=nav#top">Урок 2</a>
  <a href="/">Главная</a>
  <a href="#anchor">锚点</a>
  <a href="/static/app.js">js</a>
  <a href="/assets/logo.png">logo</a>
  <a href="https://other-site.ru/page">外链</a>
  <a href="/school/lessons/kak-prodavat-na-ozon">重复链接</a>
</body></html>`;

describe("extractSellerEduLinks (seller-edu 列表)", () => {
  it("同域教程链接提取、归一化去 query/hash、去重、排除静态资源与外链", () => {
    const links = extractSellerEduLinks(SELLER_EDU_LIST_HTML);
    expect(links).toContain("https://seller-edu.ozon.ru/school/lessons/kak-prodavat-na-ozon");
    expect(links).toContain("https://seller-edu.ozon.ru/school/lessons/reklama-na-ozon");
    expect(links).toHaveLength(2); // 首页/锚点/js/png/外链/重复全排除
  });
});

describe("extractSellerEduArticle (seller-edu 正文)", () => {
  it("取 h1 标题、去 script/style/标签/实体", () => {
    const html = `<html><head><title>页面标题</title><style>body{color:red}</style></head>
      <body><h1>Как продавать на Ozon</h1><script>var x=1;</script>
      <p>Шаг первый: регистрация&nbsp;&amp; настройка.</p></body></html>`;
    const { title, text } = extractSellerEduArticle(html);
    expect(title).toBe("Как продавать на Ozon");
    expect(text).toContain("Шаг первый: регистрация & настройка.");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("var x=1");
    expect(text).not.toContain("color:red");
  });

  it("无 h1 时兜底 title 标签", () => {
    const { title } = extractSellerEduArticle("<html><head><title>仅标题</title></head><body></body></html>");
    expect(title).toBe("仅标题");
  });
});
