"""whisper 服务 /transcribe-youtube 单测：mock yt_dlp，不真下视频（2026-10-11）。
三分支：字幕优先 / 无字幕走 whisper 兜底 / 失败 fail-open 502。
运行：cd docker/whisper && python -m unittest test_app -v
"""
import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

# faster_whisper / yt_dlp 本机未安装：import app 前打桩（容器内为真实模块）
sys.modules.setdefault("faster_whisper", MagicMock())
sys.modules.setdefault("yt_dlp", MagicMock())

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import app  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(app.app)

JSON3_SAMPLE = json.dumps({
    "events": [
        {"segs": [{"utf8": "Привет "}, {"utf8": "мир"}]},
        {"segs": [{"utf8": "Ozon продажи"}]},
        {"segs": []},
    ]
}, ensure_ascii=False)


def make_ydl_cls(meta, on_download=None, raise_on_meta=False):
    """构造假 YoutubeDL 类：extract_info(download=False) 返回 meta；download=True 时回调 on_download(opts) 落文件"""

    class FakeYDL:
        def __init__(self, opts):
            self.opts = opts

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def extract_info(self, url, download=False):
            if not download:
                if raise_on_meta:
                    raise RuntimeError("network unreachable")
                return meta
            if on_download:
                on_download(self.opts)
            return {}

    return FakeYDL


class TranscribeYouTubeTest(unittest.TestCase):
    def setUp(self):
        # whisper 模型换 mock：防真实推理，也可断言是否被调
        app.model = MagicMock()

    def _post(self, ydl_cls):
        with patch.dict(sys.modules, {"yt_dlp": MagicMock(YoutubeDL=ydl_cls)}):
            return client.post("/transcribe-youtube", json={"videoUrl": "https://www.youtube.com/watch?v=test123"})

    # 1) 字幕优先：有人工 ru 字幕 → 直接返回字幕文本，不下载音频、不走 whisper
    def test_subtitle_priority(self):
        test = self

        def write_sub(opts):
            test.assertTrue(opts["skip_download"])  # 只下字幕，不碰视频本体
            test.assertEqual(opts["subtitleslangs"], ["ru"])
            with open(opts["outtmpl"].replace("%(ext)s", "ru.json3"), "w", encoding="utf-8") as f:
                f.write(JSON3_SAMPLE)

        meta = {"duration": 123, "subtitles": {"ru": [{"ext": "json3"}]}, "automatic_captions": {}}
        resp = self._post(make_ydl_cls(meta, on_download=write_sub))
        self.assertEqual(resp.status_code, 200, resp.text)
        data = resp.json()
        self.assertEqual(data["source"], "subtitle")
        self.assertEqual(data["duration"], 123)
        self.assertIn("Привет мир", data["text"])
        self.assertIn("Ozon продажи", data["text"])
        app.model.transcribe.assert_not_called()  # 有字幕不走 whisper

    # 2) 无字幕：subtitles/automatic_captions 均空 → bestaudio 下载 + ffmpeg + whisper 兜底
    def test_no_subtitle_falls_back_to_whisper(self):
        test = self

        def write_audio(opts):
            test.assertEqual(opts["format"], "bestaudio")
            with open(opts["outtmpl"].replace("%(ext)s", "m4a"), "wb") as f:
                f.write(b"fake-audio")

        meta = {"duration": 61, "subtitles": {}, "automatic_captions": {}}
        seg = MagicMock()
        seg.text = "транскрипт один"
        seg.start, seg.end = 0.0, 1.0
        app.model.transcribe.return_value = (iter([seg]), MagicMock(duration=61.2))

        with patch.object(app.subprocess, "run") as mock_run:
            resp = self._post(make_ydl_cls(meta, on_download=write_audio))
        self.assertEqual(resp.status_code, 200, resp.text)
        data = resp.json()
        self.assertEqual(data["source"], "whisper")
        self.assertEqual(data["text"], "транскрипт один")
        self.assertEqual(data["duration"], 61.2)
        mock_run.assert_called_once()  # ffmpeg 被调
        app.model.transcribe.assert_called_once()

    # 3) 失败 fail-open：yt-dlp 元数据拉取抛错 → 502，服务不炸
    def test_failure_returns_502(self):
        resp = self._post(make_ydl_cls({}, raise_on_meta=True))
        self.assertEqual(resp.status_code, 502)
        self.assertIn("network unreachable", resp.json()["detail"])


if __name__ == "__main__":
    unittest.main()
