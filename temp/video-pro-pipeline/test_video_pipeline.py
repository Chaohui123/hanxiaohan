import copy
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock
import wave

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import build_cover
import build_video
import make_vo_yandex
import media_common
import run_one
import validate_media
from build_cover import build_cover as make_cover
from build_video import build_main
from make_overlays import layout_text, make_text_overlay
from media_common import (audio_streams, media_duration, pipeline_fingerprint, probe_media,
                          render_video_shot, run_process, sha256_file, stream_fps, video_duration,
                          video_stream, write_json)
from offline_fixtures import (OfflineVoiceFactory, create_fixture_plan, make_center_subject_clip,
                              make_motion_clip)
from pipeline_errors import MediaError, MediaQCError, PlanError, TextLayoutError
from plan_schema import load_plan
from validate_media import validate_one


class FixturePlanTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base_temporary = tempfile.TemporaryDirectory()
        cls.base_path = create_fixture_plan(Path(cls.base_temporary.name))
        cls.base_data = json.loads(cls.base_path.read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls.base_temporary.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        shutil.copytree(self.base_path.parent / "fixtures", self.root / "fixtures")
        self.data = copy.deepcopy(self.base_data)
        self.plan_path = self.root / "video-plan.json"
        self.save()

    def save(self):
        write_json(self.plan_path, self.data)

    def load(self):
        return load_plan(self.plan_path)


class PlanValidationTests(FixturePlanTestCase):
    def test_valid_plan_loads_shared_clips_and_separate_timelines(self):
        plan = self.load()
        self.assertEqual(plan.sku, "OFFLINE-DUAL-TEST")
        self.assertEqual(len(plan.clips), 4)
        self.assertEqual(len(plan.cover), 4)
        self.assertEqual(len(plan.main), 4)
        self.assertEqual(plan.fps, 24)
        self.assertEqual((plan.spec["width"], plan.spec["height"]), (1080, 1440))

    def test_missing_asset_fails(self):
        self.data["clips"][0]["path"] = "fixtures/missing.mp4"
        self.save()
        with self.assertRaisesRegex(PlanError, "素材不存在"):
            self.load()

    def test_hash_mismatch_fails(self):
        self.data["clips"][0]["sha256"] = "0" * 64
        self.save()
        with self.assertRaisesRegex(PlanError, "SHA256 不匹配"):
            self.load()

    def test_declared_duration_dimensions_and_fps_must_match_source(self):
        cases = [("duration", 2.0, "时长"), ("width", 999, "尺寸"),
                 ("height", 999, "尺寸"), ("fps", 30, "帧率")]
        for key, value, message in cases:
            with self.subTest(key=key):
                self.data = copy.deepcopy(self.base_data)
                self.data["clips"][0][key] = value
                self.save()
                with self.assertRaisesRegex(PlanError, message):
                    self.load()

    def test_output_spec_enforces_aspect_long_edge_and_internal_budget(self):
        for key, value in (("max_bytes", 18_000_001), ("width", 720), ("height", 2000),
                           ("width", 810), ("height", 1080)):
            with self.subTest(key=key):
                self.data = copy.deepcopy(self.base_data)
                self.data["spec"][key] = value
                self.save()
                with self.assertRaises(PlanError):
                    self.load()

    def test_cover_requires_four_ordered_shots_and_target_duration(self):
        self.data["cover"]["shots"] = self.data["cover"]["shots"][:3]
        self.save()
        with self.assertRaisesRegex(PlanError, "恰好 4 段"):
            self.load()
        self.data = copy.deepcopy(self.base_data)
        self.data["cover"]["shots"][0]["purpose"] = "use"
        self.save()
        with self.assertRaisesRegex(PlanError, "purpose"):
            self.load()
        self.data = copy.deepcopy(self.base_data)
        for shot in self.data["cover"]["shots"]:
            shot["duration"] = 2.0
        self.save()
        with self.assertRaisesRegex(PlanError, "12–15"):
            self.load()

    def test_cover_rejects_non_frame_aligned_or_repeated_segments(self):
        self.data["cover"]["shots"][0]["duration"] = 3.2
        self.save()
        with self.assertRaisesRegex(PlanError, "整帧对齐"):
            self.load()
        self.data = copy.deepcopy(self.base_data)
        self.data["cover"]["shots"][1].update(self.data["cover"]["shots"][0])
        self.data["cover"]["shots"][1]["purpose"] = "structure"
        self.save()
        with self.assertRaisesRegex(PlanError, "重复镜头"):
            self.load()

    def test_main_rejects_glm_other_providers_and_speed_change(self):
        for key, value in (("provider", "glm"), ("model", "glm-tts"), ("rate", "+10%"), ("stt_verify", "yes")):
            with self.subTest(key=key):
                self.data = copy.deepcopy(self.base_data)
                self.data["main"]["voice"][key] = value
                self.save()
                with self.assertRaises(PlanError):
                    self.load()

    def test_every_scene_must_have_voice_and_subtitles(self):
        for key in ("voice", "subtitles"):
            with self.subTest(key=key):
                self.data = copy.deepcopy(self.base_data)
                del self.data["main"]["shots"][0][key]
                self.save()
                with self.assertRaisesRegex(PlanError, key):
                    self.load()

    def test_duplicate_main_source_start_and_output_traversal_fail(self):
        self.data["main"]["shots"][1]["clip"] = self.data["main"]["shots"][0]["clip"]
        self.data["main"]["shots"][1]["start"] = self.data["main"]["shots"][0]["start"]
        self.save()
        with self.assertRaisesRegex(PlanError, "重复素材起点"):
            self.load()
        self.data = copy.deepcopy(self.base_data)
        self.data["output_dir"] = "../outside"
        self.save()
        with self.assertRaisesRegex(PlanError, "output_dir"):
            self.load()

    def test_cover_rejects_partial_and_same_start_overlaps(self):
        for start in (0.0, 3.0):
            with self.subTest(start=start):
                self.data = copy.deepcopy(self.base_data)
                second = self.data["cover"]["shots"][1]
                second.update({"clip": "clip1", "start": start, "duration": 3.0})
                self.save()
                with self.assertRaisesRegex(PlanError, "区间重叠"):
                    self.load()

    def test_cover_allows_contiguous_nonoverlapping_intervals(self):
        second = self.data["cover"]["shots"][1]
        second.update({"clip": "clip1", "start": 3.25, "duration": 3.25})
        self.save()
        plan = self.load()
        self.assertEqual(plan.cover[0]["clip"], plan.cover[1]["clip"])
        self.assertEqual(plan.cover[0]["start"] + plan.cover[0]["duration"],
                         plan.cover[1]["start"])

    def _install_five_second_video_with_six_second_audio(self):
        video = self.root / "fixtures" / "five-second-video.mp4"
        make_motion_clip(video, duration=5.0, phase=17)
        path = self.root / "fixtures" / "five-video-six-audio.mp4"
        run_process([
            "ffmpeg", "-y", "-v", "error", "-i", str(video), "-f", "lavfi",
            "-i", "sine=frequency=440:sample_rate=48000", "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-t", "6",
            "-movflags", "+faststart", str(path),
        ])
        probe = probe_media(path, count_frames=True)
        stream = video_stream(probe)
        self.data["clips"][0].update({
            "path": str(path.relative_to(self.root)),
            "sha256": sha256_file(path),
            "duration": video_duration(probe),
            "width": int(stream["width"]),
            "height": int(stream["height"]),
            "fps": stream_fps(stream),
            "allow_source_audio": True,
        })
        self.save()
        return probe

    def test_source_declared_duration_cannot_use_longer_audio_container(self):
        probe = self._install_five_second_video_with_six_second_audio()
        self.assertAlmostEqual(video_duration(probe), 5.0, places=3)
        self.assertGreater(media_duration(probe), 5.9)
        self.data["clips"][0]["duration"] = media_duration(probe)
        self.save()
        with self.assertRaisesRegex(PlanError, "素材时长与清单不一致.*actual=5"):
            self.load()

    def test_source_request_cannot_consume_missing_video_tail_hidden_by_audio(self):
        probe = self._install_five_second_video_with_six_second_audio()
        self.assertAlmostEqual(video_duration(probe), 5.0, places=3)
        self.assertGreater(media_duration(probe), 5.9)
        for shot, duration in zip(self.data["cover"]["shots"], (6.0, 2.0, 2.0, 2.0)):
            shot["duration"] = duration
        self.save()
        with self.assertRaisesRegex(PlanError, "实际画面长度"):
            self.load()

    def test_font_content_change_changes_fingerprint_at_same_path(self):
        font = self.root / "same-path-font.ttf"
        shutil.copyfile(self.data["spec"]["font_path"], font)
        self.data["spec"]["font_path"] = str(font)
        self.save()
        before = pipeline_fingerprint(self.load(), "cover", ())
        with font.open("ab") as handle:
            handle.write(b"same-path-different-font-content")
        after = pipeline_fingerprint(self.load(), "cover", ())
        self.assertNotEqual(before, after)


class ReframeSafetyTests(FixturePlanTestCase):
    def use_centered_source(self, size, reframe=None):
        path = self.root / "fixtures" / f"center-{size[0]}x{size[1]}.mp4"
        make_center_subject_clip(path, size=size)
        probe = probe_media(path)
        stream = video_stream(probe)
        self.data["clips"][0].update({
            "path": str(path.relative_to(self.root)),
            "sha256": sha256_file(path),
            "duration": media_duration(probe),
            "width": int(stream["width"]),
            "height": int(stream["height"]),
            "fps": stream_fps(stream),
        })
        self.data["clips"][0].pop("reframe", None)
        if reframe is not None:
            self.data["clips"][0]["reframe"] = reframe
        self.save()

    def test_9_by_16_without_reframe_is_rejected(self):
        self.use_centered_source((180, 320))
        with self.assertRaises(PlanError) as caught:
            self.load()
        message = str(caught.exception)
        self.assertIn("源片与成品不是同一比例", message)
        self.assertIn("9:16", message)
        self.assertIn("3:4", message)
        self.assertIn("reframe", message)

    def test_mismatched_source_requires_exact_mode_and_explicit_safe_center(self):
        cases = [
            ({"mode": "pad", "safe_center": True}, "center_crop"),
            ({"safe_center": True}, "center_crop"),
            ({"mode": "center_crop"}, "safe_center"),
            ({"mode": "center_crop", "safe_center": False}, "safe_center"),
            ({"mode": "center_crop", "safe_center": 1}, "safe_center"),
        ]
        for reframe, expected in cases:
            with self.subTest(reframe=reframe):
                self.use_centered_source((180, 320), reframe)
                with self.assertRaises(PlanError) as caught:
                    self.load()
                self.assertIn("源片与成品不是同一比例", str(caught.exception))
                self.assertIn(expected, str(caught.exception))

    def test_other_aspect_ratios_also_require_safety_confirmation(self):
        for size in ((320, 180), (180, 180)):
            with self.subTest(size=size):
                self.use_centered_source(size)
                with self.assertRaisesRegex(PlanError, "源片与成品不是同一比例"):
                    self.load()

    def assert_real_center_crop(self, size):
        from PIL import Image
        self.use_centered_source(size, {"mode": "center_crop", "safe_center": True})
        plan = self.load()
        overlay = self.root / "transparent.png"
        Image.new("RGBA", (plan.spec["width"], plan.spec["height"]), (0, 0, 0, 0)).save(overlay)
        output = self.root / f"reframed-{size[0]}x{size[1]}.mp4"
        render_video_shot(plan.clips["clip1"], 0, 1.0, overlay, output, plan.spec, plan.fps)
        probe = probe_media(output)
        stream = video_stream(probe)
        self.assertEqual((int(stream["width"]), int(stream["height"])), (1080, 1440))
        self.assertEqual(stream_fps(stream), 24)
        frame = self.root / f"reframed-{size[0]}x{size[1]}.png"
        run_process(["ffmpeg", "-y", "-v", "error", "-ss", "0", "-i", str(output),
                     "-frames:v", "1", str(frame)])
        image = Image.open(frame).convert("RGB").resize((270, 360), Image.Resampling.BILINEAR)
        raw_pixels = image.tobytes()
        pixels = zip(raw_pixels[0::3], raw_pixels[1::3], raw_pixels[2::3])
        mask = Image.new("L", image.size)
        mask.putdata([255 if red > 200 and green > 200 and blue > 190 else 0
                      for red, green, blue in pixels])
        bbox = mask.getbbox()
        self.assertIsNotNone(bbox)
        center_x = (bbox[0] + bbox[2]) / 2
        center_y = (bbox[1] + bbox[3]) / 2
        self.assertAlmostEqual(center_x, 135, delta=2)
        self.assertAlmostEqual(center_y, 180, delta=2)
        self.assertAlmostEqual(bbox[2] - bbox[0], bbox[3] - bbox[1], delta=2)
        edge_points = ((2, 2), (267, 2), (2, 357), (267, 357), (135, 2), (135, 357))
        for point in edge_points:
            red, green, blue = image.getpixel(point)
            self.assertTrue(green > red + 15 and green > blue + 5,
                            f"检测到疑似 pad/留边: point={point} rgb={(red, green, blue)}")

    def test_safe_9_by_16_produces_real_centered_3_by_4_without_pad(self):
        self.assert_real_center_crop((180, 320))

    def test_safe_16_by_9_produces_real_centered_3_by_4_without_pad(self):
        self.assert_real_center_crop((320, 180))


class MediaContractUnitTests(unittest.TestCase):
    def test_aac_contract_rejects_wrong_codec_profile_rate_channels_and_count(self):
        valid = {"codec_name": "aac", "profile": "LC", "sample_rate": "48000", "channels": 2}
        self.assertTrue(validate_media._main_aac_valid([valid]))
        for key, value in (("codec_name", "mp3"), ("profile", None), ("profile", "HE-AAC"),
                           ("sample_rate", "44100"), ("channels", 1)):
            with self.subTest(key=key, value=value):
                invalid = {**valid, key: value}
                self.assertFalse(validate_media._main_aac_valid([invalid]))
        self.assertFalse(validate_media._main_aac_valid([valid, dict(valid)]))
        self.assertFalse(validate_media._main_aac_valid([]))

    def test_strict_decode_uses_xerror_and_err_detect_explode(self):
        with mock.patch.object(media_common, "run_process") as run:
            media_common.strict_decode("offline.mp4")
        command = run.call_args.args[0]
        self.assertIn("-xerror", command)
        self.assertEqual(command[command.index("-err_detect") + 1], "explode")
        self.assertLess(command.index("-xerror"), command.index("-i"))
        self.assertLess(command.index("-err_detect"), command.index("-i"))

    def test_omni_readme_distinguishes_vertical_only_from_explicit_9_by_16(self):
        readme = (HERE.parent / "omni-gen" / "README.md").read_text(encoding="utf-8")
        self.assertIn("`vertical=True` 只验竖屏", readme)
        self.assertIn('aspect_ratio="9:16"` 才验精确 9:16 比例', readme)
        self.assertIn("统一生成 9:16 Omni 源片", readme)


class DeterministicLayoutTests(unittest.TestCase):
    def test_two_line_layout_preserves_every_word(self):
        text = "Проверьте размеры разъёма и комплектацию перед заказом"
        layout = layout_text(text, 1080)
        self.assertLessEqual(len(layout["lines"]), 2)
        self.assertEqual(" ".join(" ".join(layout["lines"]).split()), text)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "subtitle.png"
            made = make_text_overlay(text, output, 1080, 1440, "main")
            self.assertTrue(output.is_file())
            self.assertEqual(" ".join(made["lines"]), " ".join(layout["lines"]))

    def test_long_copy_fails_instead_of_silent_truncation(self):
        with self.assertRaisesRegex(TextLayoutError, "无法完整排版|超过两行"):
            layout_text("очень длинное описание " * 30, 1080)

    def test_unbreakable_word_fails_instead_of_clipping(self):
        with self.assertRaises(TextLayoutError):
            layout_text("Я" * 500, 1080)


class DualPipelineIntegrationTests(FixturePlanTestCase):
    def test_dual_end_to_end_real_media_and_required_review(self):
        report = run_one.run_plan(self.plan_path, voice_generator=OfflineVoiceFactory(), extract=True)
        self.assertEqual(report["status"], "AUTO_PASS_REVIEW_REQUIRED")
        self.assertTrue(report["auto_ok"])
        self.assertGreaterEqual(len(report["required_review"]), 4)
        cover = report["auto"]["cover"]
        main = report["auto"]["main"]
        self.assertEqual(cover["probe"]["audio"], [])
        self.assertEqual(main["probe"]["audio"][0]["codec"], "aac")
        self.assertEqual(main["probe"]["audio"][0]["profile"], "LC")
        self.assertEqual(main["probe"]["audio"][0]["sample_rate"], "48000")
        self.assertEqual(main["probe"]["audio"][0]["channels"], 2)
        self.assertGreater(main["analysis"]["audio_volume"]["max_volume_db"], -50)
        self.assertEqual(len(main["analysis"]["sentence_wavs"]), 4)
        self.assertTrue(all(item["hash_ok"] and item["non_silent"] and item["timing_ok"]
                            for item in main["analysis"]["sentence_wavs"]))
        for record in (cover, main):
            statuses = {item["name"]: item["status"] for item in record["checks"]}
            self.assertEqual(statuses["metadata_timeline"], "pass")
            self.assertEqual(statuses["video_stream_timeline"], "pass")
        self.assertEqual({item["name"]: item["status"] for item in main["checks"]}["audio_stream_timeline"],
                         "pass")
        for role, record, target in (("cover", cover, (12, 15)), ("main", main, (20, 26))):
            probe = record["probe"]
            self.assertEqual((probe["width"], probe["height"]), (1080, 1440))
            self.assertEqual((probe["codec"], probe["pixel_format"]), ("h264", "yuv420p"))
            self.assertEqual(probe["fps"], 24)
            self.assertTrue(probe["faststart"])
            self.assertLessEqual(probe["bytes"], 18_000_000)
            self.assertGreaterEqual(probe["duration"], target[0])
            self.assertLessEqual(probe["duration"], target[1])
            self.assertGreater(record["analysis"]["review_frames"]["count"], 4)
        metadata = json.loads((self.root / "main" / "build-metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(len(metadata["shots"]), 4)
        self.assertTrue(all(shot["voice_duration_measured"] > 0 for shot in metadata["shots"]))
        self.assertTrue(all("word_timestamps" not in shot for shot in metadata["shots"]))

    def test_cover_branch_never_calls_tts(self):
        with mock.patch.object(make_vo_yandex, "generate_sentences", side_effect=AssertionError("TTS called")) as speech:
            output = make_cover(self.load())
        speech.assert_not_called()
        self.assertEqual(audio_streams(probe_media(output)), [])

    def test_main_over_30_seconds_fails_and_asks_for_copy_change(self):
        with self.assertRaisesRegex(MediaError, "超过 30 秒.*请改短文案"):
            build_main(self.load(), voice_generator=OfflineVoiceFactory((7.6, 7.6, 7.6, 7.6)))

    def test_main_outside_20_26_target_fails(self):
        with self.assertRaisesRegex(MediaError, "20–26"):
            build_main(self.load(), voice_generator=OfflineVoiceFactory((4.0, 4.0, 4.0, 4.0)))

    def test_insufficient_real_motion_fails_without_retiming(self):
        self.data["main"]["shots"][0]["start"] = 4.5
        self.save()
        with self.assertRaisesRegex(MediaError, "剩余不足.*禁止"):
            build_main(self.load(), voice_generator=OfflineVoiceFactory())

    def test_main_rejects_interval_overlap_using_real_voice_durations(self):
        self.data["main"]["shots"][0]["start"] = 0.0
        self.data["main"]["shots"][1].update({"clip": "clip1", "start": 4.25})
        self.save()
        with self.assertRaisesRegex(MediaError, "真实配音句长.*区间重叠"):
            build_main(self.load(), voice_generator=OfflineVoiceFactory((4.49, 4.49, 5.49, 5.49)))

    def test_main_allows_contiguous_nonoverlapping_source_intervals(self):
        self.data["main"]["shots"][0]["start"] = 0.0
        self.data["main"]["shots"][1].update({"clip": "clip1", "start": 4.5})
        self.save()
        output = build_main(self.load(), voice_generator=OfflineVoiceFactory((4.49, 4.49, 5.49, 5.49)))
        self.assertTrue(output.is_file())
        metadata = json.loads((self.root / "main" / "build-metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["shots"][0]["source_start"] + metadata["shots"][0]["source_duration"],
                         metadata["shots"][1]["source_start"])
        self.assertEqual(metadata["timeline_duration"], 20.0)

    def test_scene_audio_count_mismatch_fails_explicitly(self):
        with self.assertRaisesRegex(MediaError, "场景与音频数量不一致"):
            build_main(self.load(), voice_generator=lambda texts, out, voice: [])

    def test_subtitle_too_long_fails_after_real_voice_measurement(self):
        self.data["main"]["shots"][0]["subtitles"] = "очень длинное описание " * 30
        self.save()
        with self.assertRaises(TextLayoutError):
            build_main(self.load(), voice_generator=OfflineVoiceFactory())

    def test_model_and_asset_changes_never_reuse_stale_cover(self):
        plan = self.load()
        make_cover(plan)
        with mock.patch.object(build_cover, "render_video_shot", wraps=build_cover.render_video_shot) as render:
            make_cover(self.load())
        self.assertEqual(render.call_count, 0)
        old_manifest = (self.root / "cover" / "build-manifest.json").read_text(encoding="utf-8")
        self.data["clips"][0]["generator"]["model"] = "offline-motion-fixture-v2"
        self.save()
        with mock.patch.object(build_cover, "render_video_shot", wraps=build_cover.render_video_shot) as render:
            make_cover(self.load())
        self.assertEqual(render.call_count, 4)
        model_manifest = (self.root / "cover" / "build-manifest.json").read_text(encoding="utf-8")
        self.assertNotEqual(old_manifest, model_manifest)
        changed = self.root / "fixtures" / "motion-1.mp4"
        make_motion_clip(changed, phase=11)
        from media_common import sha256_file
        self.data["clips"][0]["sha256"] = sha256_file(changed)
        self.save()
        with mock.patch.object(build_cover, "render_video_shot", wraps=build_cover.render_video_shot) as render:
            make_cover(self.load())
        self.assertEqual(render.call_count, 4)
        self.assertNotEqual(model_manifest, (self.root / "cover" / "build-manifest.json").read_text(encoding="utf-8"))

    def test_budget_forces_two_pass_reencode_with_aac(self):
        self.data["spec"]["max_bytes"] = 900_000
        self.save()
        output = build_main(self.load(), voice_generator=OfflineVoiceFactory())
        self.assertLessEqual(output.stat().st_size, 900_000)
        metadata = json.loads((self.root / "main" / "build-metadata.json").read_text(encoding="utf-8"))
        self.assertTrue(metadata["encoding"]["reencoded"])
        self.assertGreaterEqual(metadata["encoding"]["passes"], 2)
        record = validate_one(self.load(), "main")
        self.assertFalse(record["hard_failures"], record["hard_failures"])
        self.assertEqual(record["probe"]["audio"][0]["codec"], "aac")

    def test_freeze_is_hard_qc_failure_and_run_is_nonzero(self):
        other = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, other, True)
        plan_path = create_fixture_plan(other, static_clips=(1,))
        with self.assertRaises(MediaQCError):
            run_one.run_plan(plan_path, voice_generator=OfflineVoiceFactory(), extract=False)
        report = json.loads((other / "media-qc.json").read_text(encoding="utf-8"))
        self.assertEqual(report["status"], "AUTO_FAIL")
        self.assertTrue(any("freezedetect" in failure for failure in report["auto"]["cover"]["hard_failures"]))

    def test_qc_rejects_silent_aac_and_cover_audio(self):
        run_one.run_plan(self.plan_path, voice_generator=OfflineVoiceFactory(), extract=False)
        main = self.root / "main" / "video-main.mp4"
        cover = self.root / "cover" / "video-cover.mp4"
        main_backup = self.root / "main-backup.mp4"
        cover_backup = self.root / "cover-backup.mp4"
        shutil.copyfile(main, main_backup)
        shutil.copyfile(cover, cover_backup)
        self.addCleanup(shutil.copyfile, main_backup, main)
        self.addCleanup(shutil.copyfile, cover_backup, cover)
        duration = media_duration(probe_media(main))
        silent = self.root / "silent.mp4"
        run_process(["ffmpeg", "-y", "-v", "error", "-i", str(main), "-f", "lavfi",
                     "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", "1:a:0",
                     "-c:v", "copy", "-c:a", "aac", "-t", f"{duration:.6f}",
                     "-movflags", "+faststart", str(silent)])
        shutil.copyfile(silent, main)
        main_record = validate_one(self.load(), "main")
        self.assertTrue(any("main_non_silent" in failure for failure in main_record["hard_failures"]))
        audible_cover = self.root / "audible-cover.mp4"
        run_process(["ffmpeg", "-y", "-v", "error", "-i", str(cover), "-f", "lavfi",
                     "-i", "sine=frequency=1000:sample_rate=48000", "-map", "0:v:0", "-map", "1:a:0",
                     "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart",
                     str(audible_cover)])
        shutil.copyfile(audible_cover, cover)
        cover_record = validate_one(self.load(), "cover")
        self.assertTrue(any("cover_no_audio" in failure for failure in cover_record["hard_failures"]))

    def test_qc_rejects_missing_video_tail_hidden_by_longer_audio_container(self):
        run_one.run_plan(self.plan_path, voice_generator=OfflineVoiceFactory(), extract=False)
        main = self.root / "main" / "video-main.mp4"
        original = self.root / "main-original.mp4"
        shutil.copyfile(main, original)
        metadata = json.loads((self.root / "main" / "build-metadata.json").read_text(encoding="utf-8"))
        planned = metadata["timeline_duration"]
        damaged = self.root / "main-missing-tail.mp4"
        run_process([
            "ffmpeg", "-y", "-v", "error", "-i", str(original), "-i", str(original),
            "-map", "0:v:0", "-map", "1:a:0", "-vf", f"trim=duration={planned - 0.5:.6f}",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "copy", "-movflags", "+faststart", str(damaged),
        ])
        shutil.copyfile(damaged, main)
        probe = probe_media(main, count_frames=True)
        self.assertLess(video_duration(probe), planned - 1.0 / 24)
        self.assertGreater(media_duration(probe), video_duration(probe) + 0.4)
        self.assertGreaterEqual(media_duration(probe), 20.0)
        record = validate_one(self.load(), "main")
        failures = "\n".join(record["hard_failures"])
        self.assertIn("video_stream_timeline", failures)
        self.assertIn("duration_target", failures)
        statuses = {item["name"]: item["status"] for item in record["checks"]}
        self.assertEqual(statuses["full_decode"], "pass")
        self.assertEqual(statuses["audio_stream_timeline"], "pass")

    def test_qc_rejects_wrong_aac_layout_and_overlong_audio_stream(self):
        run_one.run_plan(self.plan_path, voice_generator=OfflineVoiceFactory(), extract=False)
        main = self.root / "main" / "video-main.mp4"
        original = self.root / "main-original.mp4"
        shutil.copyfile(main, original)
        bad_aac = self.root / "main-44100-mono.mp4"
        run_process([
            "ffmpeg", "-y", "-v", "error", "-i", str(original), "-map", "0:v:0", "-map", "0:a:0",
            "-c:v", "copy", "-c:a", "aac", "-profile:a", "aac_low", "-ar", "44100", "-ac", "1",
            "-movflags", "+faststart", str(bad_aac),
        ])
        shutil.copyfile(bad_aac, main)
        record = validate_one(self.load(), "main")
        self.assertIn("main_aac_lc", "\n".join(record["hard_failures"]))
        self.assertEqual(record["probe"]["audio"][0]["sample_rate"], "44100")
        self.assertEqual(record["probe"]["audio"][0]["channels"], 1)

        planned = json.loads((self.root / "main" / "build-metadata.json").read_text(encoding="utf-8"))["timeline_duration"]
        long_audio = self.root / "main-long-audio.mp4"
        run_process([
            "ffmpeg", "-y", "-v", "error", "-i", str(original), "-f", "lavfi",
            "-i", "sine=frequency=660:sample_rate=48000", "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-profile:a", "aac_low", "-ar", "48000", "-ac", "2",
            "-t", f"{planned + 1.25:.6f}", "-movflags", "+faststart", str(long_audio),
        ])
        shutil.copyfile(long_audio, main)
        record = validate_one(self.load(), "main")
        failures = "\n".join(record["hard_failures"])
        self.assertIn("audio_stream_timeline", failures)
        self.assertNotIn("main_aac_lc", failures)
        self.assertNotIn("duration_target", failures)
        statuses = {item["name"]: item["status"] for item in record["checks"]}
        self.assertEqual(statuses["video_stream_timeline"], "pass")
        self.assertEqual(statuses["full_decode"], "pass")

    def test_qc_checks_every_sentence_wav_hash_and_non_silence(self):
        run_one.run_plan(self.plan_path, voice_generator=OfflineVoiceFactory(), extract=False)
        main = self.root / "main" / "video-main.mp4"
        sentence = self.root / "main" / "work" / "voice-processed" / "vo1-f.wav"
        with wave.open(str(sentence), "rb") as source:
            params = source.getparams()
            frames = source.readframes(source.getnframes())
        silent = sentence.with_suffix(".silent.wav")
        with wave.open(str(silent), "wb") as target:
            target.setparams(params)
            target.writeframes(bytes(len(frames)))
        os.replace(silent, sentence)
        record = validate_one(self.load(), "main")
        statuses = {item["name"]: item["status"] for item in record["checks"]}
        self.assertEqual(statuses["main_non_silent"], "pass")
        self.assertEqual(statuses["sentence_wav_1"], "fail")
        item = record["analysis"]["sentence_wavs"][0]
        self.assertFalse(item["hash_ok"])
        self.assertFalse(item["non_silent"])
        self.assertTrue(item["timing_ok"])

        metadata_path = self.root / "main" / "build-metadata.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["shots"][0]["voice_file_sha256"] = sha256_file(sentence)
        write_json(metadata_path, metadata)
        record = validate_one(self.load(), "main")
        item = record["analysis"]["sentence_wavs"][0]
        self.assertTrue(item["hash_ok"])
        self.assertFalse(item["non_silent"])
        self.assertIn("sentence_wav_1", "\n".join(record["hard_failures"]))

    def test_30fps_source_is_preserved_in_both_outputs(self):
        other = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, other, True)
        plan_path = create_fixture_plan(other, fps=30)
        data = json.loads(plan_path.read_text(encoding="utf-8"))
        for shot in data["cover"]["shots"]:
            shot["duration"] = 3.3
        write_json(plan_path, data)
        report = run_one.run_plan(plan_path, voice_generator=OfflineVoiceFactory(), extract=False)
        self.assertEqual(report["auto"]["cover"]["probe"]["fps"], 30)
        self.assertEqual(report["auto"]["main"]["probe"]["fps"], 30)


PYTHON314 = Path("C:/Users/Administrator/AppData/Local/Programs/Python/Python314/python.exe")


@unittest.skipUnless(PYTHON314.is_file(), "项目 Python314/NumPy 环境不可用")
class ImageQCCompatibilityTests(unittest.TestCase):
    def setUp(self):
        import subprocess
        from PIL import Image, ImageDraw
        self.subprocess = subprocess
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.script = HERE.parents[1] / "scripts" / "image-qc.py"
        image = Image.new("RGB", (1200, 1600), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((150, 200, 1050, 1400), fill=(45, 55, 65))
        self.image = self.root / "card.png"
        image.save(self.image)

    def run_qc(self, target, *args):
        return self.subprocess.run([str(PYTHON314), str(self.script), str(target), *args],
                                   capture_output=True, text=True, encoding="utf-8", errors="replace",
                                   cwd=HERE.parents[1])

    def test_empty_directory_fails(self):
        empty = self.root / "empty"
        empty.mkdir()
        result = self.run_qc(empty)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("0/0", result.stdout)

    def test_card_requires_exact_1200_by_1600(self):
        valid = self.run_qc(self.image, "--role", "card")
        self.assertEqual(valid.returncode, 0, valid.stdout + valid.stderr)
        from PIL import Image
        wrong = self.root / "wrong.png"
        Image.new("RGB", (1080, 1440), "white").save(wrong)
        invalid = self.run_qc(wrong, "--role", "card")
        self.assertNotEqual(invalid.returncode, 0)
        self.assertIn("1200x1600", invalid.stdout)

    def test_legacy_default_detail_role_still_passes(self):
        result = self.run_qc(self.image)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
