// daily-learning 墙外源改造测试（2026-10-10）：
// Telegram t.me/s/ HTML 解析 + YouTube 频道 RSS(Atom) 解析 + 代理 fail-open（代理连不通时源跳过不炸）
import { describe, it, expect, afterEach } from "vitest";
import {
  parseTelegramChannelHtml,
  parseYouTubeRss,
  fetchRedditSub,
  fetchTelegramChannel,
  fetchYouTubeChannel,
} from "../src/jobs/daily-learning.js";

// ---- 源 6 Telegram：t.me/s/ 页面 HTML 解析 ----

// 结构参照 t.me/s/{channel} 真实页面：每消息 div.tgme_widget_message 带 data-post="channel/id"，
// 文本 div.tgme_widget_message_text，时间 time[datetime]；按时间升序
const TG_SAMPLE = `
<html><body>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="ozon_seller/1000">
    <div class="tgme_widget_message_bubble">
      <div class="tgme_widget_message_text js-message_text" dir="auto">
        <b>Важно!</b> С 1 ноября Ozon меняет правила &lt;продвижения&gt;<br/>Подробности на сайте &amp; в приложении
      </div>
      <span class="tgme_widget_message_meta">
        <a class="tgme_widget_message_date" href="https://t.me/ozon_seller/1000"><time datetime="2026-10-09T10:00:00+00:00">10:00</time></a>
      </span>
    </div>
  </div>
</div>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message js-widget_message" data-post="ozon_seller/1001">
    <div class="tgme_widget_message_bubble">
      <a class="tgme_widget_message_photo_wrap" href="https://t.me/ozon_seller/1001">photo</a>
      <a class="tgme_widget_message_date" href="https://t.me/ozon_seller/1001"><time datetime="2026-10-09T11:00:00+00:00">11:00</time></a>
    </div>
  </div>
</div>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message js-widget_message" data-post="ozon_seller/1002">
    <div class="tgme_widget_message_bubble">
      <div class="tgme_widget_message_text js-message_text" dir="auto">Новый сборник: 5 способов поднять CTR карточки &#8212; разбор внутри</div>
      <a class="tgme_widget_message_date" href="https://t.me/ozon_seller/1002"><time datetime="2026-10-09T12:00:00+00:00">12:00</time></a>
    </div>
  </div>
</div>
</body></html>`;

describe("parseTelegramChannelHtml (Telegram 源)", () => {
  it("提取消息文本/链接/时间，纯图消息跳过，实体反转义", () => {
    const items = parseTelegramChannelHtml(TG_SAMPLE, "ozon_seller", 20);
    expect(items).toHaveLength(2); // 1001 是纯图消息无文本，跳过
    expect(items[0].sourceId).toBe("https://t.me/ozon_seller/1000"); // 幂等键=消息链接
    expect(items[0].source).toBe("telegram");
    expect(items[0].author).toBe("tg:ozon_seller");
    // HTML 标签剥离 + 实体反转义（&lt; &amp;）
    expect(items[0].text).toContain("Ozon меняет правила <продвижения>");
    expect(items[0].text).toContain("на сайте & в приложении");
    expect(items[0].text).not.toContain("<b>");
    // <br/> 转换行；title=首行截断
    expect(items[0].text).toContain("\nПодробности");
    expect(items[0].title).toContain("Важно! С 1 ноября");
    expect(items[0].publishedAt).toBe(Date.parse("2026-10-09T10:00:00+00:00") / 1000);
    // 数字实体（&#8212; = —）反转义
    expect(items[1].text).toContain("CTR карточки — разбор внутри");
  });

  it("maxMessages 取末尾（页面升序=最近消息）", () => {
    const items = parseTelegramChannelHtml(TG_SAMPLE, "ozon_seller", 1);
    expect(items).toHaveLength(1);
    expect(items[0].sourceId).toBe("https://t.me/ozon_seller/1002");
  });

  it("空页面/无消息返回空数组", () => {
    expect(parseTelegramChannelHtml("<html><body></body></html>", "ozon_seller", 20)).toHaveLength(0);
  });
});

// ---- 源 7 YouTube：频道 RSS(Atom) 解析 ----

const YT_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UCtest123"/>
  <id>yt:channel:UCtest123</id>
  <title>Ремонт лодочных моторов</title>
  <entry>
    <id>yt:video:dQw4w9WgXcQ</id>
    <yt:videoId>dQw4w9WgXcQ</yt:videoId>
    <yt:channelId>UCtest123</yt:channelId>
    <title>Замена импеллера 9.9 л.с. &amp; обслуживание</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"/>
    <author><name>Ремонт лодочных моторов</name><uri>https://www.youtube.com/channel/UCtest123</uri></author>
    <published>2026-10-08T15:00:00+00:00</published>
    <updated>2026-10-08T16:00:00+00:00</updated>
    <media:group>
      <media:title>Замена импеллера 9.9 л.с. &amp; обслуживание</media:title>
      <media:description>Полный разбор замены импеллера: инструменты, подводные камни.</media:description>
    </media:group>
  </entry>
  <entry>
    <id>yt:video:oldvideo1</id>
    <yt:videoId>oldvideo1</yt:videoId>
    <yt:channelId>UCtest123</yt:channelId>
    <title>Старое видео за пределами окна</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=oldvideo1"/>
    <author><name>Ремонт лодочных моторов</name><uri>https://www.youtube.com/channel/UCtest123</uri></author>
    <published>2026-09-01T15:00:00+00:00</published>
    <media:group><media:description>old</media:description></media:group>
  </entry>
</feed>`;

describe("parseYouTubeRss (YouTube 源)", () => {
  const MIN_TS = Date.parse("2026-10-02T00:00:00+00:00") / 1000; // 模拟 7 天窗口下限

  it("解析 entry：标题实体反转义/视频 URL 幂等键/频道名/描述/published", () => {
    const items = parseYouTubeRss(YT_SAMPLE, MIN_TS, 5);
    expect(items).toHaveLength(1); // 9-01 老视频被 7 天窗口过滤
    expect(items[0].source).toBe("youtube");
    expect(items[0].sourceId).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(items[0].url).toBe(items[0].sourceId);
    expect(items[0].title).toBe("Замена импеллера 9.9 л.с. & обслуживание"); // &amp; 反转义
    expect(items[0].author).toBe("Ремонт лодочных моторов");
    expect(items[0].text).toContain("Полный разбор замены импеллера");
    expect(items[0].publishedAt).toBe(Date.parse("2026-10-08T15:00:00+00:00") / 1000);
  });

  it("minPubTs=0 时全部放行；maxPerChannel 截断", () => {
    expect(parseYouTubeRss(YT_SAMPLE, 0, 5)).toHaveLength(2);
    expect(parseYouTubeRss(YT_SAMPLE, 0, 1)).toHaveLength(1);
  });

  it("空 feed 返回空数组", () => {
    expect(parseYouTubeRss("<feed></feed>", 0, 5)).toHaveLength(0);
  });
});

// ---- 代理 fail-open：ProxyAgent 指向必拒连端口，三个墙外源都应返回空数组而不是抛错 ----

describe("墙外源代理 fail-open", () => {
  const OLD_PROXY = process.env.LEARNING_PROXY_URL;

  afterEach(() => {
    if (OLD_PROXY === undefined) delete process.env.LEARNING_PROXY_URL;
    else process.env.LEARNING_PROXY_URL = OLD_PROXY;
  });

  it("代理不可用时 Reddit/Telegram/YouTube 源全部跳过不炸", async () => {
    process.env.LEARNING_PROXY_URL = "socks5://127.0.0.1:1"; // 端口 1 必拒连（ECONNREFUSED）
    await expect(fetchRedditSub("ecommerce")).resolves.toEqual([]);
    await expect(fetchTelegramChannel("ozon_seller")).resolves.toEqual([]);
    await expect(fetchYouTubeChannel("UCtest123")).resolves.toEqual([]);
  }, 30_000);
});
