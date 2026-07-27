#!/usr/bin/env node
// ============================================================
// ONZO Ozon 商品视频上传 — drive the seller console via Kimi WebBridge.
// Flow: product list → click content-rating button → mark mp4 file input
//       → inject video file → wait for upload → click panel 保存 → verify.
//
// Usage:
//   node scripts/upload-ozon-video.cjs <视频文件路径> [评分按钮正则如 "59,5"]
//
// Requires: Kimi WebBridge daemon (127.0.0.1:10086) + extension connected,
// seller.ozon.ru already logged in in the user's browser. Windows-only.
// NOTE: file path MUST use forward slashes (backslashes get mangled).
// ============================================================

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const WB = "http://127.0.0.1:10086/command";
const SESSION = "onzo-assets";

const videoPath = process.argv[2];
const ratingPattern = process.argv[3] || "基础";
if (!videoPath) {
  console.error('用法: node scripts/upload-ozon-video.cjs <视频路径> [评分按钮文本]\n  例: node scripts/upload-ozon-video.cjs D:/Onzo/temp/listing-staging/video-ru/ozon-install-ru.mp4 "59,5"');
  process.exit(1);
}
if (!fs.existsSync(videoPath)) { console.error("文件不存在:", videoPath); process.exit(1); }
const videoFwd = videoPath.replace(/\\/g, "/");

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

(async () => {
  console.log("[1/5] 打开商品列表");
  wbCall("navigate", { url: "https://seller.ozon.ru/app/products", newTab: true, group_title: "Ozon 视频上传" });
  await sleep(12000);

  console.log("[2/5] 点击内容评级按钮打开媒体面板");
  const markBtn = `(function(){var bs=Array.from(document.querySelectorAll("button")).filter(function(x){var t=x.innerText||"";return t.indexOf("${ratingPattern}")>=0;});if(!bs.length)return "no-btn";bs[0].setAttribute("data-onzo-target","rating");return "ok";})()`;
  if (evalJs(markBtn) === "no-btn") throw new Error(`评级按钮未找到（匹配 "${ratingPattern}"）`);
  wbCall("click", { selector: '[data-onzo-target="rating"]' });
  await sleep(9000);

  console.log("[3/5] 定位 mp4 上传输入并注入视频");
  const markInput = `(function(){var els=document.querySelectorAll("input[type=file]");for(var i=0;i<els.length;i++){if((els[i].accept||"").indexOf("mp4")>=0){els[i].setAttribute("data-onzo-video","1");return "ok:"+i;}}return "no-input";})()`;
  const mi = evalJs(markInput);
  if (String(mi).startsWith("no")) throw new Error("mp4 文件输入未找到（面板未打开？）");
  wbCall("upload", { selector: '[data-onzo-video="1"]', files: [videoFwd] }, 180000);

  console.log("[4/5] 等待上传完成");
  await sleep(20000);
  const check = evalJs(`(function(){var t=(document.body.innerText||"").replace(/\\s+/g," ");var v=t.indexOf("商品视频");var err=t.indexOf("Ошибка загрузки");return JSON.stringify({slot:v>=0?t.slice(v,v+20):"无",uploadError:err>=0});})()`);
  const st = JSON.parse(check);
  console.log("     视频槽位:", st.slot, "| 上传错误:", st.uploadError);
  if (st.uploadError || !/1 из 5|[1-9] из 5/.test(st.slot)) throw new Error("视频上传失败或未生效");

  console.log("[5/5] 保存");
  const markSave = `(function(){var bs=Array.from(document.querySelectorAll("button")).filter(function(x){var t=(x.innerText||"").trim();return (/^保存$|^Сохранить/.test(t))&&x.offsetParent!==null;});if(!bs.length)return "no-save";bs[0].setAttribute("data-onzo-save","1");return "ok";})()`;
  if (evalJs(markSave) === "no-save") throw new Error("保存按钮未找到");
  wbCall("click", { selector: '[data-onzo-save="1"]' });
  await sleep(10000);

  const final = JSON.parse(evalJs(`(function(){var t=(document.body.innerText||"").replace(/\\s+/g," ");var v=t.indexOf("商品视频");return JSON.stringify({slot:v>=0?t.slice(v,v+20):"无",saved:t.indexOf("已保存")>=0||t.indexOf("Сохранено")>=0});})()`));
  console.log(`\n✅ 视频上传完成 — 槽位 ${final.slot} | 保存确认: ${final.saved}`);
})().catch((e) => { console.error("❌ 失败:", e.message); process.exit(1); });
