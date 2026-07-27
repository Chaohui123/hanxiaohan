#!/usr/bin/env node
// ============================================================
// ONZO Ozon 商品媒体上传 — drive the seller console via Kimi WebBridge.
// Primary path: product list → row pencil → edit page → "媒体" tab →
//   inject file(s) into image/video inputs → 保存商品 → verify.
// Fallback path (--rating): product list → content-rating panel → same.
//
// Usage:
//   node scripts/upload-ozon-video.cjs <媒体文件路径> [选项]
// Options:
//   --offer <offerId>   行定位文本（默认 HS-XP2-MAG-01）
//   --dry-run           只走到"媒体 tab + 输入定位"，不实际上传
//   --rating            用内容评级面板路径（兜底）
//
// Requires: WebBridge daemon (127.0.0.1:10086) + extension connected,
// seller.ozon.ru logged in. Windows-only. Path MUST use forward slashes.
// ============================================================

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const WB = "http://127.0.0.1:10086/command";
const SESSION = "onzo-assets";

const argv = process.argv.slice(2);
const offerIdx = argv.indexOf("--offer");
const productIdx = argv.indexOf("--product");
const OFFER = offerIdx >= 0 ? argv[offerIdx + 1] : "HS-XP2-MAG-01";
const PRODUCT_ID = productIdx >= 0 ? argv[productIdx + 1] : "5683403180";
const skipIdx = [offerIdx, productIdx].filter((i) => i >= 0).map((i) => i + 1);
const mediaPath = argv.find((a, i) => !a.startsWith("--") && !skipIdx.includes(i));
const DRY = argv.includes("--dry-run");
const RATING = argv.includes("--rating");

if (!mediaPath) {
  console.error("用法: node scripts/upload-ozon-video.cjs <媒体文件> [--offer HS-XP2-MAG-01] [--dry-run] [--rating]");
  process.exit(1);
}
if (!fs.existsSync(mediaPath)) { console.error("文件不存在:", mediaPath); process.exit(1); }
const mediaFwd = mediaPath.replace(/\\/g, "/");
const isVideo = /\.(mp4|mov)$/i.test(mediaPath);

function wbCall(action, args = {}, timeoutMs = 90000) {
  const reqFile = path.join("temp", `wb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
  fs.mkdirSync("temp", { recursive: true });
  fs.writeFileSync(reqFile, JSON.stringify({ action, args, session: SESSION }));
  try {
    const winPath = ("D:\\Onzo\\" + reqFile).replace(/\//g, "\\");
    const out = cp.execFileSync("curl.exe", ["-s", "-X", "POST", WB, "-H", "Content-Type: application/json", "--data-binary", `@${winPath}`], { encoding: "utf8", timeout: timeoutMs });
    const resp = JSON.parse(out);
    if (!resp.ok) throw new Error(resp.error?.message || `${action} failed`);
    return resp.data;
  } finally { fs.existsSync(reqFile) && fs.unlinkSync(reqFile); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = (code) => wbCall("evaluate", { code }).value;

async function openMediaTabViaEdit() {
  console.log("[1/6] 打开商品列表");
  wbCall("navigate", { url: "https://seller.ozon.ru/app/products", newTab: true, group_title: "Ozon 媒体上传" });
  // 后台 tab 被 Chrome 节流连骨架都不渲染——必须提到前台（用户实测发现）
  try { wbCall("cdp", { method: "Page.bringToFront", params: {} }); } catch { /* best effort */ }
  await sleep(12000);

  console.log("[2/6] SPA 内跳转编辑页（避免铅笔 target=_blank 开 session 外新 tab）");
  evalJs(`location.assign("/app/products/${PRODUCT_ID}/edit/general-info"), "ok"`);
  // 骨架屏也有"商品编辑"标题——必须等"商品信息"表单字段真正渲染
  let formReady = false;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const h = evalJs(`(document.body.innerText||"").slice(0,500)`);
    if (/名称|类目和类型/.test(String(h))) { formReady = true; break; }
  }
  if (!formReady) throw new Error("编辑页表单未加载（30s 超时）");

  console.log("[3/6] 切换到媒体 tab");
  const markMedia = `(function(){var els=Array.from(document.querySelectorAll("a,button,[role=tab],div,li"));var el=els.find(function(x){var t=(x.innerText||"").trim();return /^3\\s*媒体$/.test(t)||t==="媒体";});if(!el)return "no-media-tab";var clickEl=el.closest("a,button,[role=tab]")||el;clickEl.setAttribute("data-onzo-media","1");return "ok:"+(el.innerText||"").trim().slice(0,8)+"|"+clickEl.tagName;})()`;
  const mm = evalJs(markMedia);
  console.log("     媒体 tab:", mm);
  if (String(mm).startsWith("no")) throw new Error("媒体 tab 未找到");
  wbCall("click", { selector: '[data-onzo-media="1"]' });
  await sleep(2500);
  const u1 = String(evalJs("location.href"));
  if (!/\/edit\/media/.test(u1)) {
    console.log("     点击未切 URL，直达 /edit/media 保底");
    evalJs(`location.assign("/app/products/${PRODUCT_ID}/edit/media"), "ok"`);
  }
  // 媒体区块异步加载：轮询等"添加视频/添加图片"出现，最多 25s
  let ready = false;
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const has = evalJs(`(function(){var t=(document.body.innerText||"").replace(/\\s+/g,"");return t.indexOf("添加视频")>=0||t.indexOf("添加图片")>=0?"yes":"no";})()`);
    if (String(has) === "yes") { ready = true; break; }
  }
  console.log("     媒体内容就绪:", ready);
}

async function openMediaViaRating() {
  console.log("[1/6] 打开商品列表（评级面板路径）");
  wbCall("navigate", { url: "https://seller.ozon.ru/app/products", newTab: true, group_title: "Ozon 媒体上传" });
  try { wbCall("cdp", { method: "Page.bringToFront", params: {} }); } catch { /* best effort */ }
  await sleep(12000);
  console.log("[2/6] 点击内容评级按钮");
  const markBtn = `(function(){var bs=Array.from(document.querySelectorAll("button")).filter(function(x){var t=x.innerText||"";return t.indexOf("基础")>=0||/\\d+[,.]\\d+/.test(t);});if(!bs.length)return "no-btn";bs[0].setAttribute("data-onzo-target","rating");return "ok";})()`;
  if (evalJs(markBtn) === "no-btn") throw new Error("评级按钮未找到");
  wbCall("click", { selector: '[data-onzo-target="rating"]' });
  await sleep(9000);
}

async function injectAndSave() {
  console.log("[4/6] 定位上传输入（媒体 tab 懒渲染：先点添加按钮）");
  if (!RATING) {
    const addLabel = isVideo ? "添加视频" : "添加图片";
    const markAdd = `(function(){var bs=Array.from(document.querySelectorAll("button,a")).filter(function(x){return x.offsetParent!==null;});var hit=bs.find(function(x){return (x.innerText||"").replace(/\\s+/g,"")==="${addLabel}";});if(!hit){var list=bs.map(function(x){return (x.innerText||"").trim().replace(/\\s+/g," ").slice(0,15);}).filter(function(t){return t;}).slice(0,15);return "no-add-btn:"+JSON.stringify(list);}hit.setAttribute("data-onzo-add","1");return "ok";})()`;
    const ma = evalJs(markAdd);
    if (String(ma).startsWith("no")) throw new Error(`"${addLabel}"按钮未找到 ${String(ma).slice(0, 300)}`);
    wbCall("click", { selector: '[data-onzo-add="1"]' });
    await sleep(3000);
  }
  const accept = isVideo ? "mp4" : "jpeg";
  const markInput = `(function(){var els=document.querySelectorAll("input[type=file]");for(var i=0;i<els.length;i++){if((els[i].accept||"").toLowerCase().indexOf("${accept}")>=0){els[i].setAttribute("data-onzo-up","1");return "ok:"+i+"/"+els.length;}}return "no-input";})()`;
  const mi = evalJs(markInput);
  console.log("     输入定位:", mi);
  if (String(mi).startsWith("no")) throw new Error(`${isVideo ? "视频" : "图片"}文件输入未找到`);
  if (DRY) { console.log("\n[dry-run] 路径验证通过，未上传。"); process.exit(0); }

  console.log("[5/6] 注入文件并等待上传");
  wbCall("upload", { selector: '[data-onzo-up="1"]', files: [mediaFwd] }, 180000);
  await sleep(isVideo ? 20000 : 12000);
  const st = JSON.parse(evalJs(`(function(){var t=(document.body.innerText||"").replace(/\\s+/g," ");var err=t.indexOf("Ошибка загрузки");var v=t.indexOf("商品视频");return JSON.stringify({slot:v>=0?t.slice(v,v+20):"-",uploadError:err>=0});})()`));
  console.log("     状态:", st.slot, "| 上传错误:", st.uploadError);
  if (st.uploadError) throw new Error("上传失败（Ошибка загрузки）");

  console.log("[6/6] 保存");
  const markSave = `(function(){var bs=Array.from(document.querySelectorAll("button")).filter(function(x){var t=(x.innerText||"").trim();return (/^保存商品|^保存$|^Сохранить/.test(t))&&x.offsetParent!==null&&!x.disabled;});if(!bs.length)return "no-save";bs[0].setAttribute("data-onzo-save","1");return "ok:"+(bs[0].innerText||"").trim().slice(0,12);})()`;
  const ms = evalJs(markSave);
  if (String(ms).startsWith("no")) throw new Error("保存按钮未找到");
  wbCall("click", { selector: '[data-onzo-save="1"]' });
  await sleep(10000);
  const fin = JSON.parse(evalJs(`(function(){var t=(document.body.innerText||"").replace(/\\s+/g," ");return JSON.stringify({saved:t.indexOf("已保存")>=0||t.indexOf("Сохранено")>=0});})()`));
  console.log(`\n✅ 上传完成 — 保存确认: ${fin.saved}`);
}

(async () => {
  if (RATING) await openMediaViaRating();
  else await openMediaTabViaEdit();
  await injectAndSave();
})().catch((e) => { console.error("❌ 失败:", e.message); process.exit(1); });
