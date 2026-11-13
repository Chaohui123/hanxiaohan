import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import make_vo_edge
import make_vo_yandex
import media_common
import process_vo
import run_one
from media_common import run_process
from offline_fixtures import make_tone_wav
from pipeline_errors import MediaError


class VoicePipelineOfflineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.voice = {"provider": "edge", "model": "edge-tts",
                      "name": "ru-RU-SvetlanaNeural", "rate": "+0%"}

    def _make_mp3(self, name="valid"):
        source = self.root / f"{name}.wav"
        output = self.root / f"{name}.mp3"
        make_tone_wav(source, 1.0)
        run_process(["ffmpeg", "-y", "-v", "error", "-i", str(source),
                     "-c:a", "libmp3lame", "-b:a", "128k", str(output)])
        return output

    def test_edge_command_preserves_original_speed_and_saves_real_boundaries(self):
        def fake_run(command, **kwargs):
            media = Path(command[command.index("--write-media") + 1])
            subtitles = Path(command[command.index("--write-subtitles") + 1])
            media.write_bytes(b"fresh-mp3")
            subtitles.write_text("WEBVTT\n\n00:00.000 --> 00:01.000\nОдна фраза.\n", encoding="utf-8")
            return SimpleNamespace(returncode=0)

        with mock.patch.object(make_vo_edge, "VENV_PY", Path(__file__)), \
                mock.patch.object(make_vo_edge.subprocess, "run", side_effect=fake_run) as run, \
                mock.patch.object(make_vo_edge, "valid_mp3", return_value=True):
            outputs = make_vo_edge.generate_sentences(["Одна фраза."], self.root, self.voice)
        self.assertEqual(len(outputs), 1)
        self.assertEqual(outputs[0].read_bytes(), b"fresh-mp3")
        self.assertIn("Одна фраза.", outputs[0].with_suffix(".vtt").read_text(encoding="utf-8"))
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("--text") + 1], "Одна фраза.")
        self.assertIn("--write-subtitles", command)
        self.assertNotIn("--rate", command)
        self.assertNotIn("atempo", command)
        temporary_media = Path(command[command.index("--write-media") + 1])
        self.assertNotEqual(temporary_media, outputs[0])
        self.assertFalse(temporary_media.parent.exists())

    def test_edge_relative_output_is_absolute_for_child_in_another_cwd(self):
        out_dir = Path("temp") / f"edge-relative-{os.getpid()}"
        self.addCleanup(shutil.rmtree, out_dir, True)

        def fake_run(command, **kwargs):
            media = Path(command[command.index("--write-media") + 1])
            subtitles = Path(command[command.index("--write-subtitles") + 1])
            self.assertTrue(media.is_absolute())
            self.assertTrue(subtitles.is_absolute())
            self.assertNotEqual(media.parent, Path(kwargs["cwd"]))
            media.write_bytes(b"fresh-mp3")
            subtitles.write_text("WEBVTT\n", encoding="utf-8")
            return SimpleNamespace(returncode=0)

        with mock.patch.object(make_vo_edge, "VENV_PY", Path(__file__)), \
                mock.patch.object(make_vo_edge.os.path, "expanduser", return_value=str(self.root)), \
                mock.patch.object(make_vo_edge.subprocess, "run", side_effect=fake_run), \
                mock.patch.object(make_vo_edge, "valid_mp3", return_value=True):
            outputs = make_vo_edge.generate_sentences(["Одна фраза."], out_dir, self.voice)
        self.assertEqual(outputs[0].read_bytes(), b"fresh-mp3")
        self.assertEqual(outputs, [out_dir / "vo1.mp3"])

    def test_edge_rejects_non_original_rate_before_any_call(self):
        self.voice["rate"] = "+15%"
        with mock.patch.object(make_vo_edge.subprocess, "run") as run:
            with self.assertRaisesRegex(MediaError, "禁止 rate/变速"):
                make_vo_edge.generate_sentences(["Текст."], self.root, self.voice)
        run.assert_not_called()

    def test_edge_failure_is_nonzero_after_real_attempts(self):
        with mock.patch.object(make_vo_edge, "VENV_PY", Path(__file__)), \
                mock.patch.object(make_vo_edge.subprocess, "run", return_value=SimpleNamespace(returncode=1)) as run:
            with self.assertRaisesRegex(MediaError, "Edge 配音失败"):
                make_vo_edge.generate_sentences(["Текст."], self.root, self.voice)
        self.assertEqual(run.call_count, 3)

    def test_valid_mp3_requires_strict_decode_and_rejects_incomplete_file(self):
        valid = self._make_mp3()
        with mock.patch.object(make_vo_edge, "run_process", wraps=make_vo_edge.run_process) as decode:
            self.assertTrue(make_vo_edge.valid_mp3(valid))
        command = decode.call_args.args[0]
        self.assertIn("-xerror", command)
        self.assertEqual(command[command.index("-err_detect") + 1], "explode")
        self.assertIn("astats=metadata=0", command)
        incomplete = self.root / "incomplete.mp3"
        payload = valid.read_bytes()
        incomplete.write_bytes(payload[:len(payload) // 2])
        self.assertFalse(make_vo_edge.valid_mp3(incomplete))

    def test_valid_mp3_rejects_nonfinite_or_nonpositive_duration(self):
        path = self.root / "duration.mp3"
        path.write_bytes(b"mp3")
        for duration in ("NaN", "inf", "-inf", "0", "-1", "not-a-number"):
            with self.subTest(duration=duration), \
                    mock.patch.object(make_vo_edge, "probe_media", return_value={
                        "format": {"duration": duration},
                        "streams": [{"codec_type": "audio", "codec_name": "mp3", "sample_rate": "24000"}],
                    }), \
                    mock.patch.object(make_vo_edge, "_decoded_mp3_duration") as decode:
                self.assertFalse(make_vo_edge.valid_mp3(path))
                decode.assert_not_called()

    def test_edge_retries_into_unique_temp_files_then_atomically_replaces(self):
        valid = self._make_mp3()
        out_dir = self.root / "edge-output"
        out_dir.mkdir()
        final = out_dir / "vo1.mp3"
        final_vtt = out_dir / "vo1.vtt"
        final.write_bytes(b"old-audio")
        final_vtt.write_text("old-subtitles", encoding="utf-8")
        temporary_media = []

        def fake_run(command, **kwargs):
            media = Path(command[command.index("--write-media") + 1])
            subtitles = Path(command[command.index("--write-subtitles") + 1])
            temporary_media.append(media)
            if len(temporary_media) == 1:
                media.write_bytes(b"incomplete")
            else:
                shutil.copyfile(valid, media)
            subtitles.write_text(f"WEBVTT\nattempt-{len(temporary_media)}\n", encoding="utf-8")
            return SimpleNamespace(returncode=0)

        runner = mock.Mock(side_effect=fake_run)
        edge_subprocess = SimpleNamespace(
            run=runner, TimeoutExpired=make_vo_edge.subprocess.TimeoutExpired)
        with mock.patch.object(make_vo_edge, "VENV_PY", Path(__file__)), \
                mock.patch.object(make_vo_edge, "subprocess", edge_subprocess):
            outputs = make_vo_edge.generate_sentences(["Текст."], out_dir, self.voice)
        self.assertEqual(runner.call_count, 2)
        self.assertEqual(outputs, [final])
        self.assertEqual(final.read_bytes(), valid.read_bytes())
        self.assertIn("attempt-2", final_vtt.read_text(encoding="utf-8"))
        self.assertEqual(len(set(temporary_media)), 2)
        self.assertTrue(all(path != final and not path.parent.exists() for path in temporary_media))

    def test_edge_zero_exit_with_incomplete_outputs_never_reuses_old_files(self):
        out_dir = self.root / "edge-output"
        out_dir.mkdir()
        final = out_dir / "vo1.mp3"
        final_vtt = out_dir / "vo1.vtt"
        final.write_bytes(b"old-audio")
        final_vtt.write_text("old-subtitles", encoding="utf-8")
        temporary_media = []

        def fake_run(command, **kwargs):
            media = Path(command[command.index("--write-media") + 1])
            subtitles = Path(command[command.index("--write-subtitles") + 1])
            temporary_media.append(media)
            media.write_bytes(b"still-incomplete")
            subtitles.write_text("WEBVTT\nnew-but-invalid\n", encoding="utf-8")
            return SimpleNamespace(returncode=0)

        runner = mock.Mock(side_effect=fake_run)
        edge_subprocess = SimpleNamespace(
            run=runner, TimeoutExpired=make_vo_edge.subprocess.TimeoutExpired)
        with mock.patch.object(make_vo_edge, "VENV_PY", Path(__file__)), \
                mock.patch.object(make_vo_edge, "subprocess", edge_subprocess):
            with self.assertRaisesRegex(MediaError, "本次完整 MP3/VTT"):
                make_vo_edge.generate_sentences(["Текст."], out_dir, self.voice)
        self.assertEqual(runner.call_count, 3)
        self.assertEqual(len(set(temporary_media)), 3)
        self.assertEqual(final.read_bytes(), b"old-audio")
        self.assertEqual(final_vtt.read_text(encoding="utf-8"), "old-subtitles")
        self.assertTrue(all(not path.parent.exists() for path in temporary_media))

    def test_yandex_generates_fresh_wav_with_marina_friendly_receipt(self):
        voice = {"provider": "yandex", "model": "speechkit-v3",
                 "name": "marina", "role": "friendly", "rate": "+0%"}

        def fake_run(command, **kwargs):
            request_path = Path(command[2])
            request = json.loads(request_path.read_text(encoding="utf-8"))
            self.assertEqual(request["text"], "Проверка русской речи.")
            self.assertNotIn("speed", request)
            make_tone_wav(request["output"], 1.0)
            return SimpleNamespace(returncode=0, stdout=json.dumps({
                "provider": "yandex", "model": "speechkit-v3", "voice": "marina",
                "role": "friendly", "chunks": 1, "bytes": 48044,
            }), stderr="")

        with mock.patch.object(make_vo_yandex, "SPEECHKIT_CLI", Path(__file__)), \
                mock.patch.object(make_vo_yandex.subprocess, "run", side_effect=fake_run) as run, \
                mock.patch.object(make_vo_yandex, "valid_wav", return_value=True):
            outputs = make_vo_yandex.generate_sentences(["Проверка русской речи."], self.root, voice)
        self.assertEqual(len(outputs), 1)
        self.assertEqual(outputs[0].suffix, ".wav")
        self.assertTrue(outputs[0].is_file())
        receipt = json.loads(outputs[0].with_suffix(".speechkit.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["voice"], "marina")
        self.assertEqual(receipt["role"], "friendly")
        self.assertEqual(receipt["rate"], "+0%")
        command = run.call_args.args[0]
        self.assertNotIn("--rate", command)
        self.assertNotIn("atempo", command)

    def test_yandex_paid_failure_is_not_retried(self):
        voice = {"provider": "yandex", "model": "speechkit-v3",
                 "name": "marina", "role": "friendly", "rate": "+0%"}
        with mock.patch.object(make_vo_yandex, "SPEECHKIT_CLI", Path(__file__)), \
                mock.patch.object(make_vo_yandex.subprocess, "run",
                                  return_value=SimpleNamespace(returncode=1, stdout="", stderr="HTTP 500")) as run:
            with self.assertRaisesRegex(MediaError, "不自动重发"):
                make_vo_yandex.generate_sentences(["Текст."], self.root, voice)
        self.assertEqual(run.call_count, 1)

    def test_yandex_rejects_voice_or_rate_change_before_paid_call(self):
        voice = {"provider": "yandex", "model": "speechkit-v3",
                 "name": "marina", "role": "friendly", "rate": "+0%"}
        for key, value in (("name", "alena"), ("role", "strict"), ("rate", "+10%")):
            with self.subTest(key=key), mock.patch.object(make_vo_yandex.subprocess, "run") as run:
                voice[key] = value
                with self.assertRaises(MediaError):
                    make_vo_yandex.generate_sentences(["Текст."], self.root, voice)
                run.assert_not_called()

    def test_yandex_optional_stt_verification_is_saved_in_receipt(self):
        voice = {"provider": "yandex", "model": "speechkit-v3",
                 "name": "marina", "role": "friendly", "rate": "+0%", "stt_verify": True}

        def fake_run(command, **kwargs):
            request = json.loads(Path(command[2]).read_text(encoding="utf-8"))
            make_tone_wav(request["output"], 1.0)
            return SimpleNamespace(returncode=0, stdout=json.dumps({
                "provider": "yandex", "model": "speechkit-v3", "voice": "marina",
                "role": "friendly", "chunks": 1, "bytes": 48044,
            }), stderr="")

        with mock.patch.object(make_vo_yandex, "SPEECHKIT_CLI", Path(__file__)), \
                mock.patch.object(make_vo_yandex.subprocess, "run", side_effect=fake_run), \
                mock.patch.object(make_vo_yandex, "valid_wav", return_value=True), \
                mock.patch.object(make_vo_yandex, "verify_stt", return_value={
                    "status": "PASS", "format": "oggopus", "transcript": "Проверка русской речи",
                }) as verify:
            outputs = make_vo_yandex.generate_sentences(["Проверка русской речи."], self.root, voice)
        verify.assert_called_once()
        receipt = json.loads(outputs[0].with_suffix(".speechkit.json").read_text(encoding="utf-8"))
        self.assertTrue(receipt["stt_verify_requested"])
        self.assertEqual(receipt["stt_verification"]["status"], "PASS")

    def test_yandex_stt_mismatch_does_not_replace_previous_audio(self):
        voice = {"provider": "yandex", "model": "speechkit-v3",
                 "name": "marina", "role": "friendly", "rate": "+0%", "stt_verify": True}
        final = self.root / "vo1.wav"
        final.write_bytes(b"previous-audio")

        def fake_run(command, **kwargs):
            request = json.loads(Path(command[2]).read_text(encoding="utf-8"))
            make_tone_wav(request["output"], 1.0)
            return SimpleNamespace(returncode=0, stdout=json.dumps({
                "provider": "yandex", "model": "speechkit-v3", "voice": "marina",
                "role": "friendly", "chunks": 1, "bytes": 48044,
            }), stderr="")

        with mock.patch.object(make_vo_yandex, "SPEECHKIT_CLI", Path(__file__)), \
                mock.patch.object(make_vo_yandex.subprocess, "run", side_effect=fake_run), \
                mock.patch.object(make_vo_yandex, "valid_wav", return_value=True), \
                mock.patch.object(make_vo_yandex, "verify_stt", side_effect=MediaError("STT 回读与原文不一致")):
            with self.assertRaisesRegex(MediaError, "不一致"):
                make_vo_yandex.generate_sentences(["Проверка русской речи."], self.root, voice)
        self.assertEqual(final.read_bytes(), b"previous-audio")

    def test_yandex_stt_normalization_handles_punctuation_and_yo(self):
        self.assertEqual(make_vo_yandex.normalize_speech("Проверка, русской речи!"),
                         make_vo_yandex.normalize_speech("проверка русской речи"))
        self.assertEqual(make_vo_yandex.normalize_speech("Ёлка"), make_vo_yandex.normalize_speech("елка"))

    def test_yandex_valid_wav_rejects_incomplete_file(self):
        valid = self.root / "valid.wav"
        make_tone_wav(valid, 1.0)
        incomplete = self.root / "incomplete.wav"
        payload = valid.read_bytes()
        incomplete.write_bytes(payload[:len(payload) // 2])
        self.assertTrue(make_vo_yandex.valid_wav(valid))
        self.assertFalse(make_vo_yandex.valid_wav(incomplete))

    def test_process_filter_only_trims_head_and_tail_silence(self):
        source = self.root / "source.wav"
        make_tone_wav(source, 1.0)

        def fake_run(command):
            make_tone_wav(command[-1], 1.0)
            return SimpleNamespace(returncode=0)

        with mock.patch.object(process_vo, "run_process", side_effect=fake_run) as run:
            process_vo.process_audio_files([source], self.root / "out")
        command = run.call_args.args[0]
        audio_filter = command[command.index("-af") + 1]
        self.assertEqual(audio_filter, process_vo.SILENCE_FILTER)
        self.assertNotIn("atempo", audio_filter)
        self.assertNotIn("aresample", audio_filter)
        self.assertNotIn("-ar", command)

    def test_process_uses_real_wav_frame_count_for_duration(self):
        source = self.root / "source.wav"
        make_tone_wav(source, 1.25)
        output = process_vo.process_audio_files([source], self.root / "out")[0]
        self.assertAlmostEqual(process_vo.wav_dur(output), 1.25, places=3)

    def test_run_one_rejects_old_slug_and_glm_entries(self):
        for value in ("old-product-slug", "glm_broll"):
            with self.subTest(value=value), contextlib.redirect_stderr(io.StringIO()) as stderr:
                self.assertEqual(run_one.main([value]), 1)
                self.assertIn("旧 slug/GLM 入口已停用", stderr.getvalue())

    def test_run_one_accepts_exactly_one_plan_path(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(run_one.main([]), 2)
            self.assertEqual(run_one.main(["one.json", "two.json"]), 2)

    def test_run_one_propagates_failures_as_nonzero(self):
        with mock.patch.object(run_one, "run_plan", side_effect=MediaError("offline failure")), \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(run_one.main(["plan.json"]), 1)
        self.assertIn("offline failure", stderr.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
