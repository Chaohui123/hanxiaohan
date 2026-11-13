# omni-gen — Gemini 图像、视频、配音与独立 OpenAI 图像适配器

在现有 `temp/omni-gen/` 内统一封装 Gemini API，不改动
`temp/listing-*/` 下的历史 GLM 脚本。Gemini 图像默认使用
**`gemini-nano-banana-2.1` + Interactions API**；视频使用
**`gemini-omni-1.2-flash` + Interactions API**；配音候选使用
**`gemini-3.8-flash-tts` + Interactions API**。`openai_image.py` 是独立的
OpenAI 图像适配器，默认 **`gpt-image-2.6-sunburst`**，不进入 Gemini 模型或回退配置。

> 2026-10-25 验收纠偏：Nano Banana 2.1 生成的 1792×2400 原图含品牌喷雾罐，
> 第一次裁切图又被独立 QC 发现连接器糊化与工具伪文字，**两张均不采用**。
> 已改用真实商品照片制作 `test-out/qc-image/glowplug-real-detail-1200x1600.jpg`，
> 自动 QC 与独立 QC 均通过，仅作实物细节副图，不用于证明针脚定义或电气兼容性。
> Omni 首尾帧视频实测 5.013 秒、720×1280、24fps、H.264/AAC，完整解码、冻结检测与连续抽帧目检通过。
> Gemini TTS 已生成 22.08 秒真实 WAV，规格与完整解码通过；Argon 实际音频评审为
> **preferred=B（Edge），confidence=高**，这是当时的历史结论；当前默认配音见下文 SpeechKit 规则。
> 历史 52 项离线测试全过；当前测试数量见下文。2026-10-26 主 Agent 另完成
> Nano 2.1 同图精修、ChatGPT Images 2.5 应用精修及 1080p 9:16 Omni 真实源片验收；
> 不把 ChatGPT 应用结果写成 OpenAI API 已上线。未上传 Ozon、未修改生产商品。

## 文件

- `omni_gen.py` — Python Gemini 图像/视频/配音入口。
- `omni-gen.cjs` — Node Gemini 图像入口，保持 `temp/glm-image.cjs` 的批量 JSON 调用形态。
- `openai_image.py` — 独立 OpenAI 图像生成/参考图编辑入口，使用现有 `requests`。
- `test.py` — 默认离线 `unittest`；付费 Gemini 图片、视频和配音各有独立显式入口。
- `test-node.cjs` — 无新增依赖的 `node:test` 离线测试。
- `test_openai_image.py` — OpenAI 参数、错误与缓存的全 mock 离线测试。
- `omni-usage.jsonl` — 自动追加成功/失败、请求参数、模型、usage 和实际媒体规格。

## 前置条件

1. **Gemini API key**：真实 Gemini 调用时才读取 `temp/gemini-key.txt`（单行文本）。
   导入模块、构建请求和 mock 测试不会读取该文件。不要把 key 放进命令行、日志或截图。
2. **OpenAI API key**：`openai_image.py` 只读环境变量 `OPENAI_API_KEY`，缺失会明确失败；
   不读取 Gemini key 文件，也不读取 `GEMINI_IMAGE_MODEL`。ChatGPT Plus 订阅不是 API 余额。
3. **代理**：真实 Google API 调用需要 v2rayN 监听 `127.0.0.1:10808`。可检查
   `netstat -ano | grep "10808.*LISTEN"`，未监听时启动
   `D:\Tools\v2rayN\v2rayN-windows-64\v2rayN.exe`。
   - Gemini Python 显式使用 `http://127.0.0.1:10808`。
   - Node 24 通过 `NODE_USE_ENV_PROXY=1` 和 `HTTPS_PROXY` 使用代理；CLI 会在
     缺少配置时自动 re-exec。`require()` 不会 re-exec，也不会自动执行生成。
   - OpenAI 适配器默认同样使用 10808，可用 `OPENAI_PROXY_URL` 覆盖，设为空则直连；
     它不会修改系统代理开关。
4. **本地工具**：Python 需要已有的 `requests`、`Pillow`；视频校验需要
   `ffprobe`。Node 非 JPEG 响应转 JPG、图片完整解码需要 `ffmpeg`，实际图片尺寸读取需要
   `ffprobe`。离线测试均 mock 网络与媒体转换，不触网、不读真实 key。

## 模型配置

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `GEMINI_IMAGE_MODEL` | `gemini-nano-banana-2.1` | Gemini 图像主模型，走 `POST /v1beta/interactions` |
| `GEMINI_IMAGE_FALLBACK_MODEL` | `gemini-3.1-flash-image` | 仅在 Gemini 主模型 429 有限重试耗尽后，走 `generateContent` 回退；设为空字符串可禁用 |
| `GEMINI_VIDEO_MODEL` | `gemini-omni-1.2-flash` | 视频模型，走 Interactions API |
| `GEMINI_TTS_MODEL` | `gemini-3.8-flash-tts` | 配音候选模型，走 Interactions API |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2.6-sunburst` | 仅 `openai_image.py` 使用；OpenAI 官方 Images API，无自动回退 |

`gemini-omni-1.1-flash` 处于过渡窗口；自 2026-12-03 起官方会把 1.1 请求自动路由到
`gemini-omni-1.2-flash` 并按 1.2 费率计费，本项目已提前显式固定 1.2。

`gemini-2.5-flash-image` 已停用，不再出现在自动回退链中。402/403/404
以及其他非 429 的 4xx 不重试、不换模型。默认 Gemini 图像主模型、图像回退模型和视频
模型的 **API 都没有免费档**，不要按历史“图像免费”口径使用。OpenAI 适配器只按
`OPENAI_IMAGE_MODEL` 发请求，不会因限流、权限或服务器错误静默换成其他模型。

## Python 用法

```python
import sys
sys.path.insert(0, "temp/omni-gen")
from omni_gen import gen_image, gen_video

# 旧调用仍兼容：默认 1K，size 仅用于推导画幅比例。
gen_image(
    "frost-window",
    "winter car window frost, no text, no logo",
    "out/",
    size="1024x1024",
)

# 实物参考 + 正式 2K、3:4 场景副图。
gen_image(
    "glowplug-scene",
    "preserve the exact product shape; workshop scene; no text, no logo",
    "out/",
    size="1200x1600",
    reference_images=["temp/listing-glowplug/video-assets/comp/12v-01_main.png"],
    aspect_ratio="3:4",
    image_size="2K",
)

# 旧视频调用仍兼容：默认 vertical=True、resolution="720p"。
gen_video("winter-road", "empty winter highway, 5 seconds", "out/", vertical=True)

# 可选首尾帧插值；只有显式调用才生成视频。
gen_video(
    "road-interpolation",
    "5 seconds, continuous motion between the supplied frames, no text",
    "out/",
    vertical=True,
    first_frame="frames/road-0.jpg",
    last_frame="frames/road-2.jpg",
    resolution="720p",
)

# Ozon 的 Omni 源片显式使用 9:16；成品 3:4 由 video-pro-pipeline 后期中央安全裁切。
# 1080p 只是请求档位，不是任意像素或固定输出宽高保证。
gen_video(
    "ozon-product-source-9x16",
    "5 seconds, continuous product demonstration, no text",
    "out/",
    vertical=True,
    aspect_ratio="9:16",
    resolution="1080p",
)

# Omni 1.2 原生15秒；只有显式 duration 才覆盖旧提示时长。
gen_video(
    "product-15s", "continuous product demonstration, no text", "out/",
    vertical=True, aspect_ratio="9:16", resolution="720p", duration=15,
)

# 使用已完成互动的 ID 扩展视频：请求新增3秒，成片按15+3≈18秒验收。
gen_video(
    "product-extend", "extend this video by 3 seconds; keep everything else the same", "out/",
    vertical=True, aspect_ratio="9:16", resolution="360p", duration=3,
    previous_interaction_id="<completed-interaction-id>",
    previous_duration=15, extend=True,
)
```

### 图像参数

- 原前四个参数 `name, prompt, out_dir, size` 保持不变；新增
  `reference_images=None`、`aspect_ratio=None`、`image_size="1K"`。
- `size` 是兼容参数，可从 `1024x1024`、`720x1280`、`1920x1080`、
  `1200x1600` 等像素比例推导常见画幅；不再是“强制输出任意像素”的承诺。
- 显式 `aspect_ratio` 优先于 `size` 推导。`image_size` 只允许 `1K`、`2K`、
  `4K`，默认 `1K`；正式商品素材才显式使用 `2K`，`4K` 需专项审批。
- `reference_images` 接受一个本地路径或路径列表，最多 14 张。按文件内容检测
  MIME，不信任扩展名；主请求按文本、参考图的顺序放入 `input`。
- 主请求使用：

```json
{
  "model": "gemini-nano-banana-2.1",
  "input": [
    {"type": "text", "text": "..."},
    {"type": "image", "data": "<base64>", "mime_type": "image/png"}
  ],
  "response_format": {
    "type": "image",
    "mime_type": "image/jpeg",
    "aspect_ratio": "3:4",
    "image_size": "2K"
  }
}
```

- 解析兼容 Interactions `steps[].content[]`、SDK 便利字段和旧
  `generateContent` 的 `candidates[].content.parts[].inline_data`。
- **2K 不等于任意指定像素**。成功日志的 `spec.width`、`spec.height` 和
  `spec.aspect_ratio` 来自实际落盘图片；不要把 prompt 或 `size` 当成实际尺寸。

### 视频参数

- Omni 1.2 官方支持 3–15 秒、最多6张参考图、多轮对话编辑/扩展及
  360p/720p/1080p/4K。当前适配器覆盖首尾帧、显式时长和上一互动 ID；
  上传参考视频等能力尚未接入，不因模型支持就宣称本模块已支持。
- 原前四个参数 `name, prompt, out_dir, vertical` 保持不变；保留
  `first_frame=None`、`last_frame=None`、`resolution="720p"`，可选
  `aspect_ratio=None`、`duration=None`、`previous_interaction_id=None`、
  `previous_duration=None`、`extend=False`。缺省行为不变：`vertical=True` 只验竖屏；
  显式 `aspect_ratio="9:16"` 才验精确 9:16 比例。
- `duration` 只接受3–15的整数秒，显式时写 `response_format.duration="<N>s"` 并覆盖
  文本中的时长。缺省 `None` 仍保留旧调用的5秒提示，不把官方10秒默认误认为旧行为。
  首尾帧同时存在时只允许3–10秒；非法值在读取 Key、HTTP 或备份前失败。
- `previous_interaction_id` 用于续编/编辑已完成互动，写入请求和 manifest 指纹；
  空字符串直接失败。续编已有视频时输出时长必须与源片一致，不能把15秒源片缩成3秒。
- `extend=True` 用于扩展上一互动，必须同时提供 `previous_interaction_id`、正数
  `previous_duration` 和显式 `duration`；每次扩展3–10秒、累计不超过30秒。
  请求写新增秒数，校验则按 `previous_duration + duration` 的总时长，容差0.25秒。
  例如15秒基片扩展3秒，实际成片应约18秒，而不是3秒。
- **Omni 视频的 `aspect_ratio` 只允许 `None`、`16:9`、`9:16`**。`3:4` 及其他值会在
  读取 Key、发起 HTTP 或备份旧产物之前直接报错，不再把官方不支持的比例发送到 API。
- `resolution` 只允许 `360p`、`720p`、`1080p`、`4K`。720p 是默认档；1080p/4K 是
  放大档，不是任意像素或固定输出宽高的保证，必须以真实文件探测结果为准。
- 首尾帧可单独或同时提供。请求 `input` 按第一帧、最后帧、文本的顺序排列；
  旧调用的 `response_format` 仍为 `{"type":"video","resolution":"720p"}`。
  显式 `aspect_ratio="9:16"` 或 `"16:9"` 时才增加同名字段，并按该比例补充提示。
- `vertical=True` 与显式 `16:9` 冲突会在付费请求前报错，横屏调用须显式
  `vertical=False`。显式比例还会核对**实际像素宽高比**，比例不符同样失败。
- **Ozon 成品 3:4 不是 Omni 原生输出**。统一生成 9:16 Omni 源片，再由
  `video-pro-pipeline` 后期做中央安全裁切得到 3:4 成品；不得向 Omni 请求 3:4，
  也不得把源片虚标为 3:4。后期裁切和最终规格必须按真实源片与成品文件验收。
- `ffprobe` 记录实际宽高、时长、画幅、视频编码、是否有音轨、音频编码和声道数。
  提示词里的时长、比例或清晰度不能替代这些实测值。
- Interactions 创建与轮询共用终止处理：`failed`、`cancelled`/`canceled` 等立即
  报错；无轮询 ID 的非完成响应不会空转；默认轮询上限 5 分钟。

### 配音（TTS）

- `gen_speech(name, text, out_dir, voice="Sulafat", style=DEFAULT_SPEECH_STYLE)`：
  逐字生成单说话人俄语 WAV，不改变朗读文本，不提供变速、音调拉伸、克隆或多人对话。
- 官方请求结构为 `user_input → content → text`，风格只放在
  `annotations.speech_metadata.style`；`generation_config.speech_config` 指定音色，
  `response_format` 为 `{"type":"audio","mime_type":"audio/wav","sample_rate":24000}`。
  解析兼容 `steps[].content[]` 与 `output_audio`。
- 使用 `wave` 全量读取和 ffprobe 校验 24kHz、单声道、16-bit PCM、非零时长及完整性；
  失败删除无效文件，成功/失败日志均含 interaction ID、usage 和实际音频规格。
- `temp/video-pro-pipeline/run_one.py <path/to/video-plan.json>` 的正片自 2026-11-14 起只接受
  `main.voice.provider="yandex"`、`model="speechkit-v3"`、`name="marina"`、`role="friendly"`、
  `rate="+0%"`，旧 Edge/GLM 配置必须显式迁移。SpeechKit 返回真实 WAV，`process_vo.py`
  仅修剪首尾静音并解码 WAV，最终统一 48kHz、双声道，不调整语速。Gemini `gen_speech`
  仍只作独立候选，不进入默认正片通道。
- **防旧音源串用**：`gen_speech` 为模型、音色、风格和逐字文本保存指纹；只有 manifest
  完全一致才复用 WAV，复用时不读 Key、不发 HTTP。缺失或不匹配先保留旧文件备份，
  再按当前参数生成；新音频通过规格校验后才原子写入 manifest。
- 真实样音 `temp/omni-gen/test-out/tts/ru-sulafat.wav` 为 22.08 秒、24kHz、mono、
  16-bit PCM，552 output audio tokens / 646 total tokens；同文本 Edge 为 22.44 秒。
  Argon 当时实际音频评审 **preferred=B（Edge），confidence=高**：A=55 分，B=73 分。
  这是历史 A/B 证据，不是当前默认路由；2026-11-14 起正片默认 Yandex SpeechKit v3
  `marina+friendly`，其真实音频盲评为 PASS 96 分。历史证据见
  `temp/omni-gen/test-out/tts/argon-ab-review.json`，当前证据见
  `temp/ops-exec/yandex-cloud-20261114/marina-blind-review.json`。

### 重试、幂等与日志

- Gemini 仅 429 最多 3 次 POST 尝试，退避等待 10 秒、20 秒；仍失败时，图像才使用
  已配置的回退模型。402/403/404/5xx 立即停止，不重试、不回退，先核对原互动和
  usage，避免结果不明确的重复扣费。网络异常也不自动重发付费 POST。
- 创建响应后写入脱敏 `started` 日志并记录 `interaction_id`；轮询失败保留该 ID，
  不重新 POST。只有成功终态才提取媒体，pending 即使带媒体也继续轮询。
- **图像、视频和 OpenAI 图像不再按“同名非空”复用**。每个正式产物都有
  `<文件名>.manifest.json`：图像记录主/回退模型、prompt、兼容 size、参考图文件名/
  大小/MIME/SHA-256、aspect_ratio、image_size；视频记录模型、原/实际提示、vertical、
  resolution、aspect_ratio 和首尾帧哈希。manifest 同时记录实际产物的文件名、大小、
  SHA-256 与实测规格，只有请求指纹、逐字段内容、实际文件和规格全部匹配才跳过。
  缓存命中仍会读取/探测实际文件，但不读 Key、不发 HTTP。
- manifest 缺失、JSON 损坏、指纹变化、参考素材变化、文件哈希/大小/名称或实测规格
  不符时，先把旧产物和旧 manifest 移到带 UTC 时间与纳秒唯一后缀的备份，再生成。
  旧版本无 manifest 的 JPG/MP4/WAV 不会静默复用。新媒体先写临时文件并完成校验，
  再替换正式文件并原子写 manifest；原子写或后续任一步失败都会删除本次正式产物，
  不留下可在下次被误判为成功的文件，旧备份保留。
- TTS 仍按原有模型、音色、风格、逐字文本和 WAV 文件名/大小/SHA-256 严格复用，
  语音指纹行为未改。需要新结果时也可使用新名称，避免覆盖历史产物。
- started、成功和失败均写入 `omni-usage.jsonl`。图像记录比例/清晰度档/参考图
  数量/实际尺寸；视频记录分辨率档/画幅/首尾帧/实际流规格；TTS 记录音色、实际 WAV
  规格和 usage。URL 查询参数和错误文本中的 key 均脱敏；usage 日志不写 prompt 或
  参考图 base64，本地 manifest 则保存防串用所需的 prompt 与素材哈希。

## Node 用法

```bash
node temp/omni-gen/omni-gen.cjs '[{"name":"s1","prompt":"winter scene, no text","size":"1024x1024"}]'

node temp/omni-gen/omni-gen.cjs '[{"name":"glowplug","prompt":"preserve exact shape, no text, no logo","size":"1200x1600","reference_images":["temp/listing-glowplug/video-assets/comp/12v-01_main.png"],"aspect_ratio":"3:4","image_size":"2K"}]'
```

输出为 `temp/omni-scenes/<name>.jpg` 及对应 manifest。每项支持 `size`、
`reference_images`、`aspect_ratio`、`image_size`，模型、重试、回退、严格缓存和日志语义与
Python 图像一致。批量处理会继续尝试后续项，但**任一项失败都会设置非零退出码**，避免假成功。

也可在测试中 `require("./temp/omni-gen/omni-gen.cjs")`；此时不自动执行 `main`，
不 re-exec，不读取 key。`gen()` 只有在缓存未命中、准备真实生成时才通过 `loadApiKey()` 读取 key。

## 独立 OpenAI 图像适配器

```python
from openai_image import gen_image as gen_openai_image

gen_openai_image(
    "product-detail",
    "preserve the exact reference product; clean background; no text or logo",
    "out/",
    reference_images=["assets/product.png"],
    size="1200x1600",
    quality="high",
    complexity="low",
    output_format="png",
    background="transparent",
)
```

- 默认模型准确为 `gpt-image-2.6-sunburst`，只能由 `OPENAI_IMAGE_MODEL` 覆盖；
  `GEMINI_IMAGE_MODEL` 不参与读取或回退。无参考图走 `/v1/images/generations`，有参考图
  或 mask 走 `/v1/images/edits`，编辑使用 multipart 官方字段。
- `complexity` 可选 `low`/`medium`/`high`，省略时官方默认 high；局部编辑优先 low。
  它控制渲染前的规划量，与 quality 的画面细节控制分开。2.6 编辑请求必须省略
  `input_fidelity`，传入会在 HTTP 前明确失败。官方 SVG/GIF 能力尚未接入本适配器。
- 默认 `size="1200x1600"`、`quality="high"`，质量档允许 `high`/`xhigh`/`max`。
  `output_format="png"` 支持请求透明背景并检查真实 PNG 有 alpha 通道；JPEG 使用
  `output_format="jpeg"`（兼容传入 `jpg`），可选 0–100 的 `output_compression`。
  透明背景与 JPEG 不兼容，会在请求前报错；`mask` 仅用于参考图编辑。
- 从 `data[0].b64_json` 取图，完整解码后记录真实宽高、比例、格式、色彩模式、alpha、
  文件 SHA-256 和响应 `usage`；不会把请求的 1200×1600 写成未经实测的输出尺寸。
- 429 按 `Retry-After` 做最多 3 次总尝试；402/403/404/5xx、超时及其他网络结果不明
  均不自动重发。不会静默切换模型，也不会把 ChatGPT Plus 当作 API 余额。
- 产物使用同样的严格 manifest 防串用与原子写规则。**目前只完成全 mock 适配测试，
  未做真实 OpenAI API/付费 smoke**；尺寸、质量、透明和编辑参数是请求适配能力，
  不代表账号权限、计费或真实输出已验收上线，真实 smoke 由主 Agent 后续执行。

## 离线测试与显式付费验收

从仓库根目录运行：

```bash
# Gemini 离线 unittest，不生成真实图片、视频或音频。
python temp/omni-gen/test.py

# Node 离线测试，无新增依赖。
node --test temp/omni-gen/test-node.cjs

# OpenAI 适配器离线测试，网络、Key 与媒体规格全部 mock。
python temp/omni-gen/test_openai_image.py

# 配音编排离线测试，由主 Agent 另行复核。
python temp/video-pro-pipeline/test_voice_pipeline.py
```

原 52 项基线的真实构成为 Python 28 + Node 15 + 编排 9。保留原用例并新增覆盖后，
**2026-11-06 本目录实测 69 项全过：Python 39 + Node 19 + OpenAI 11**；另跑
配音编排 **13 项全过**，不混入本目录的 69 项，四组合计 82 项。以下命令会产生真实 Gemini API 调用，图片和视频
按官方费率计费；TTS 在 2026 年促销期免费但配额有限，不能视为无限额度。首轮已由主
Agent 在 $1 预算内完成。后续只有在确认预算、参考图和新输出名后才能执行；已有文件
只有 manifest 严格匹配才跳过，旧无 manifest 文件会先备份再生成，不能把旧文件当作
本次验收产物：

```bash
# 一张 2K、3:4 Nano Banana 2.1 场景副图。
python temp/omni-gen/test.py --live-image
# 参考：temp/listing-glowplug/video-assets/comp/12v-01_main.png
# 输出：temp/omni-gen/test-out/nano-banana-2.1-glowplug-scene.jpg

# 一条 5 秒、720p Omni 首尾帧插值视频；不会因图片测试而自动运行。
python temp/omni-gen/test.py --live-video
# 首尾帧：temp/listing-glowplug/vidcheck-v3/omni/seg8-road-0.jpg、seg8-road-2.jpg
# 输出：temp/omni-gen/test-out/omni-interpolation-road.mp4

# Omni 1.2：一条15秒720p视频 + 复用基片做3秒360p多轮扩展。
python temp/omni-gen/test.py --live-omni-1-2
# 输出：temp/omni-gen/test-out/omni-1.2-winter-road-15s.mp4
# 以及 temp/omni-gen/test-out/omni-1.2-winter-road-extend-3s.mp4

# 一段 Sulafat 俄语样音；不会自动进行 A/B 评审或批量生产。
python temp/omni-gen/test.py --live-tts
# 输出：temp/omni-gen/test-out/tts/ru-sulafat.wav
```

真实验收仍需核对商品形状、文字/logo/水印、实际尺寸、usage、全片解码、连续运动
和抽帧目检；不能只凭 HTTP 200 或文件存在判定通过。首轮 2K 原图及第一次裁切图均
未通过内容验收，未采用。后续独立 QC 通过的实物细节副图为
`temp/omni-gen/test-out/qc-image/glowplug-real-detail-1200x1600.jpg`。
视频抽帧与冻结日志均在 `temp/omni-gen/test-out/`。A/B 音频评审见
`temp/omni-gen/test-out/tts/argon-ab-review.json`，当时 Edge 优先；当前 SpeechKit 验收见 `temp/ops-exec/yandex-cloud-20261114/`。

## API 成本与订阅边界

以下为官方约价，实际以 Billing/Usage 为准：

| 模型/输出 | 输出费用约价 | 备注 |
|---|---:|---|
| Nano Banana 2.1，1K 图 | $0.0336/张 | 输入、思考、搜索另计 |
| Nano Banana 2.1，2K 图 | $0.0504/张 | 输入、思考、搜索另计 |
| Nano Banana 2.1，4K 图 | $0.113/张 | 输入、思考、搜索另计；仅专项审批 |
| Omni 1.2 视频，360p | $0.023/秒 | 输出视频 tokens 按官方费率折算 |
| Omni 1.2 视频，720p | $0.07/秒 | 15秒约 $1.04；输入等其他费用另计 |
| Omni 1.2 视频，1080p | $0.104/秒 | 放大档，输入等其他费用另计 |
| Omni 1.2 视频，4K | $0.209/秒 | 放大档，输入等其他费用另计 |
| Gemini 3.8 Flash TTS | 2026 年促销期免费（有配额） | 2027-01-01 起 $18/百万 output audio tokens，25 tokens/秒；输入另计 |

既有 Omni 样本的 5.013 秒视频为 28,960 output video tokens、29,165 total tokens，
不是“5.8 万 token”。本轮首尾帧视频为 28,960 output video tokens、31,482 total
tokens，实出 5.013 秒、720×1280、24fps、H.264/AAC，未检出冻结。
本轮 1 张 2K 图与 1 段 720p 5 秒视频按实际 token 和官方费率估算约 $0.57，**不是账单**。
2026-10-26 的 1080p 9:16 空工作台和 12V 实物参考源片各为 5.013 秒、43,440 output
video tokens；按 $17.50/M 估算每段视频输出费约 $0.7602，另有输入与思考。
`temp/media-sop-20261026/real-product/omni-source/` 的 12V 首条源片只完成技术验证，
目检发现密封件相对位置与连接器呈现不一致，不采用，不能据此宣称实物一致性验收通过。
Billing/Usage 可能延迟。模块未启用搜索接地，避免来源图片风险和额外搜索费用。

- **Google AI Pro 应用订阅**、**Flow 积分**、**Gemini API 预付余额**是不同权益/
  账户口径。AI Pro 的应用额度和 Flow 积分不能直接当作 API 余额。
- **符合条件的 Cloud 赠金**与 API 预付也不能混同；赠金能否抵 API、账号关联及
  有效预付条件以 Billing 页面为准。不要根据订阅页面推断 API 一定有可用额度。
- **赠金实证（2026-10-25）**：加入免费 Google 开发者计划（资料私密、不订阅营销），
  进入 `me.developers.google.com/benefits`，选择既有结算账号并应用，AI Studio
  Billing 回读“付费1 + US$10 符合条件的 GCP 赠金”。未改自动充值、未开启固定
  结算账号关联；用量与扣费展示可能延迟。
- 本模块不代充值、不改自动充值、不切换付费账户。真实批量生成前先核对预算和
  `omni-usage.jsonl`；成本约价不是费用封顶承诺。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `ProxyError` / Node `fetch failed` | 先查 v2rayN 与 10808 监听。POST 网络失败结果不明确，不会自动重发；不要立即盲目重跑。 |
| 429 重试耗尽 | 付费 API 速率或配额受限，不是“免费档耗尽”。图像可按配置回退；持续失败应停止批量任务并核对 Usage/配额。 |
| 5xx | 立即停止，不重试、不回退。保留 interaction ID，先查询原互动与 usage 对账，避免重复付费。 |
| 402/403 | 计费、权限或访问限制。不会重试或换模型；由主 Agent 核查 Billing/权限，不代充值。 |
| 404 | 模型 ID、接口或访问权限不匹配。不会自动换模型；先核对官方模型目录和账号权限。 |
| `failed` / `cancelled` | 互动已终止，轮询立即停止。检查安全拦截和输入，不要无效轮询。 |
| 长时间 pending | 默认 5 分钟超时且不自动重新生成。保留 interaction ID，先查询原互动状态。 |
| `no image` / `no video` | 本次已实测 Interactions `steps` 与 `output_image`/`output_video` 解析。仍失败时先在脱敏条件下核对响应与安全拦截，不要盲目重发付费请求。 |
| `vertical=True but actual output...` | 实际输出不是竖屏；本次文件删除。不能用 prompt 中的 9:16 代替实测。 |
| `ffprobe` / `ffmpeg` 失败 | 检查工具是否在 PATH、文件是否完整。视频校验失败或本次图像处理失败不会留下可被幂等跳过的最终空壳文件。 |
| Node 批量退出码非零 | 至少一项失败；查看同批次 `FAIL` 与失败日志。后续项仍会尝试，不能把部分成功当全批成功。 |

俄语后期配音自 2026-11-14 起使用 Yandex SpeechKit v3 `marina+friendly` 原速，
禁止 GLM TTS、静默换音色或变速。本模块也不会因图像调用或离线测试而默认生成视频。
