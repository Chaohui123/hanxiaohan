#!/usr/bin/env node
// ============================================================
// ONZO 1688 素材一键抓取 — drive the user's real browser via Kimi WebBridge
// to pull ALL images + videos + SKU/specs from a 1688 product page,
// saved to D:\下载\<offerId>\ with a procurement manifest.
//
// Usage:
//   node scripts/download-1688-assets.cjs <1688商品链接或offerId> [输出根目录]
//
// Requires: Kimi WebBridge daemon running locally (127.0.0.1:10086) and the
// browser extension connected. Windows-only (writes temp JSON + curl.exe).
// ============================================================

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

// ---- Config ----
const WB = "http://127.0.0.1:10086/command";
const SESSION = "onzo-assets";
const OUT_ROOT = process.argv[3] || "D:/下载";
const REFERER = "https://detail.1688.com/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const NAV_TIMEOUT_MS = 90_000;
const DL_TIMEOUT_S = 60;
const MIN_IMG_BYTES = 2500; // SKU thumbnails upgraded to originals are normally >20KB; this only guards against 1x1 placeholders
const MIN_VID_BYTES = 10_000;

// ---- Args ----
const input = process.argv[2];
if (!input) {
  console.error("用法: node scripts/download-1688-assets.cjs <1688商品链接或offerId> [输出根目录]");
  process.exit(1);
}
const offerId = (input.match(/offer\/(\d+)\.html/) || input.match(/(\d{6,})/) || [])[1];
if (!offerId) { console.error("无法从输入解析 offerId:", input); process.exit(1); }
const url = input.startsWith("http") ? input : `https://detail.1688.com/offer/${offerId}.html`;
const OUT_DIR = path.join(OUT_ROOT, `1688_${offerId}`);

// ---- WebBridge helper (Windows: temp JSON file + curl.exe) ----
function wbCall(action, args = {}, timeoutMs = NAV_TIMEOUT_MS) {
  const reqFile = path.join("temp", `wb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
  fs.mkdirSync("temp", { recursive: true });
  fs.writeFileSync(reqFile, JSON.stringify({ action, args, session: SESSION }));
  try {
    const winPath = ("D:\\Onzo\\" + reqFile).replace(/\//g, "\\");
    const out = cp.execFileSync("curl.exe", ["-s", "-X", "POST", WB, "-H", "Content-Type: application/json", "--data-binary", `@${winPath}`], { encoding: "utf8", timeout: timeoutMs });
    const resp = JSON.parse(out);
    if (!resp.ok) throw new Error(resp.error?.message || `${action} failed`);
    return resp.data;
  } finally {
    fs.existsSync(reqFile) && fs.unlinkSync(reqFile);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Page extraction (runs inside the product page) ----
// Sources: <img> src/data-*/srcset, inline background-image (1688 SKU thumbs
// are often backgrounds, not <img>), <video>, <a> links to video files, and
// mp4/m3u8 URLs scanned from the raw HTML (catches data-layer videos that
// never enter the DOM). NOTE: inside a template literal every regex backslash
// must be doubled (\\s, \\., \\/), single \s would silently degrade to "s".
const EXTRACT_CODE = `(function(){
  function norm(u){ if(!u) return null; if(u.indexOf('//')===0) return 'https:'+u; return u; }
  function txt(el){ return (el && (el.innerText||el.textContent) || '').trim(); }
  var imgs={}, vids={};
  function addImg(u){ u=norm(u); if(u && /\\.(jpg|jpeg|png|webp)/i.test(u) && !/icon|logo|avatar|blank|search|\\.svg|qrcode|gg_dtc|tps-\\d/i.test(u)) imgs[u]=1; }
  document.querySelectorAll('img').forEach(function(im){
    addImg(im.src); addImg(im.getAttribute('data-src')); addImg(im.getAttribute('data-lazyload')); addImg(im.getAttribute('data-origin'));
    var ss = im.getAttribute('srcset'); if(ss) ss.split(',').forEach(function(p){ addImg(p.trim().split(/\\s+/)[0]); });
  });
  document.querySelectorAll('[style*="background-image"]').forEach(function(el){
    var m = (el.getAttribute('style')||'').match(/background-image:\\s*url\\(["']?([^"')]+)/);
    if(m) addImg(m[1]);
  });
  document.querySelectorAll('video').forEach(function(v){ var u=norm(v.src||v.currentSrc); if(u) vids[u]=1; });
  document.querySelectorAll('a[href]').forEach(function(a){ var u=norm(a.href); if(u && /\\.(mp4|mov|webm|m3u8)/i.test(u)) vids[u]=1; });
  // Data-layer videos: scan raw HTML for mp4/m3u8 URLs (may be JSON-escaped, HTML-entitized)
  var html = document.documentElement.innerHTML;
  var vre = /https?:\\/\\/[^"'\\s]+?\\.(mp4|m3u8)(\\?[^"'\\s]*)?/gi, vm;
  while((vm = vre.exec(html)) !== null){ vids[vm[0].replace(/&amp;/g,'&')] = 1; if(Object.keys(vids).length >= 10) break; }

  var rawTitle = txt(document.querySelector('h1')) || '';
  // Prefer the page <title> (product name) over supplier-region h1; strip the " - 阿里巴巴" suffix
  var title = document.title.replace(/\\s*[-—_]?\\s*阿里巴巴.*$/, '').trim() || rawTitle.slice(0,200);
  var priceText = '';
  var priceEl = document.querySelector('[class*=price],[class*=Price]');
  if(priceEl) priceText = txt(priceEl).slice(0,100);

  var specs = [];
  document.querySelectorAll('[class*=attr] tr, [class*=spec] tr, [class*=parameter] tr, [class*=attribute] li').forEach(function(tr){
    var t = txt(tr); if(t && t.length<120) specs.push(t);
  });

  return JSON.stringify({ title:title, priceText:priceText, specs:specs.slice(0,30), imgs:Object.keys(imgs), vids:Object.keys(vids) });
})()`;

// ---- Scroll to trigger lazy-load: slow pass to bottom, back to top, settle ----
const SCROLL_CODE = `(function(){ return new Promise(function(res){ var h=0; var t=setInterval(function(){ window.scrollBy(0,400); h+=400; if(h>=document.body.scrollHeight+400){ clearInterval(t); window.scrollTo(0,0); setTimeout(function(){ res('scrolled:'+h); },1500); } },150); }); })()`;

// alicdn thumbnails/derivatives carry a suffix (e.g. ".jpg_60x60q90.jpg",
// ".jpg_220x220q90.jpg_.webp", ".jpg_sum.jpg"); stripping it yields the original.
function upgradeUrl(u) {
  return u
    .replace(/\.(jpg|jpeg|png|webp)_\d+x\d+[^?]*(\?.*)?$/i, ".$1")
    .replace(/\.(jpg|jpeg|png|webp)_sum\.jpg(\?.*)?$/i, ".$1");
}

function extOf(u, def) {
  const m = u.match(/\.(jpg|jpeg|png|webp|mp4|mov|webm|m3u8)(\?|$)/i);
  return m ? "." + m[1].toLowerCase().replace("jpeg", "jpg") : def;
}

// referer=null sends NO Referer header — alicdn anti-leech allows blank referer
function download(u, dest, referer = REFERER) {
  try {
    const args = ["-sL", "-m", String(DL_TIMEOUT_S), "-o", dest, "-A", UA];
    if (referer) args.push("-H", `Referer: ${referer}`);
    args.push(u);
    cp.execFileSync("curl.exe", args, { stdio: "pipe" });
    return fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  } catch { return 0; }
}

// ---- Main ----
(async () => {
  console.log(`[1/4] 打开商品页 offerId=${offerId}`);
  wbCall("navigate", { url, newTab: true, group_title: `1688 素材抓取 ${offerId}` });
  await sleep(4000);

  console.log(`[2/4] 慢速滚动触发懒加载（到底后回顶）`);
  try { wbCall("evaluate", { code: SCROLL_CODE }); } catch { /* best effort */ }
  await sleep(4000);

  console.log(`[3/4] 提取标题/价格/规格/图/视频（含 background-image/srcset/HTML 视频扫描）`);
  const data = JSON.parse(wbCall("evaluate", { code: EXTRACT_CODE }).value);
  console.log(`     标题: ${data.title.slice(0, 50)}`);
  console.log(`     图 ${data.imgs.length} 张 | 视频 ${data.vids.length} 个 | 规格 ${data.specs.length} 条`);

  console.log(`[4/4] 下载到 ${OUT_DIR}`);
  const imgDir = path.join(OUT_DIR, "images");
  const vidDir = path.join(OUT_DIR, "videos");
  fs.mkdirSync(imgDir, { recursive: true });
  fs.mkdirSync(vidDir, { recursive: true });

  const manifest = {
    offerId, url, title: data.title, priceText: data.priceText, specs: data.specs,
    capturedAt: new Date().toISOString(), images: [], videos: [], failures: [],
  };

  let okImg = 0, failImg = 0;
  data.imgs.forEach((u, i) => {
    const src = upgradeUrl(u);
    const dest = path.join(imgDir, `img_${String(i + 1).padStart(2, "0")}${extOf(src, ".jpg")}`);
    let size = download(src, dest);
    if (size <= MIN_IMG_BYTES && src !== u) size = download(u, dest); // upgrade failed -> raw thumbnail URL
    if (size <= MIN_IMG_BYTES) size = download(src, dest, null); // no-referer fallback (alicdn allows blank referer)
    if (size > MIN_IMG_BYTES) { okImg++; manifest.images.push({ url: u, file: path.relative(OUT_DIR, dest), bytes: size }); }
    else { failImg++; manifest.failures.push({ url: u }); fs.existsSync(dest) && fs.unlinkSync(dest); }
  });

  let okVid = 0;
  data.vids.forEach((u, i) => {
    const dest = path.join(vidDir, `video_${i + 1}${extOf(u, ".mp4")}`);
    let size = download(u, dest);
    if (size <= MIN_VID_BYTES) size = download(u, dest, null);
    if (size > MIN_VID_BYTES) { okVid++; manifest.videos.push({ url: u, file: path.relative(OUT_DIR, dest), bytes: size }); }
    else { manifest.failures.push({ url: u, type: "video" }); fs.existsSync(dest) && fs.unlinkSync(dest); }
  });

  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`\n✅ 完成`);
  console.log(`   图: ${okImg}/${data.imgs.length} 成功 (${failImg} 失效，详见 manifest.failures)`);
  console.log(`   视频: ${okVid}/${data.vids.length} 成功`);
  console.log(`   采购清单: ${path.join(OUT_DIR, "manifest.json")}`);
})().catch((e) => { console.error("❌ 失败:", e.message); process.exit(1); });
