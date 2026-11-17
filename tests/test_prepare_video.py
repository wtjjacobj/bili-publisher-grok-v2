import unittest
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from prepare_video import (
    comments_as_text,
    DEFAULT_VIDEO_FORMAT,
    LONG_VIDEO_FORMAT,
    choose_ytdlp_binary,
    clear_incomplete_video_downloads,
    humanize_download_error,
    is_twitter_url,
    is_youtube_url,
    normalize_comments,
    parse_ytdlp_version,
    pick_fxtwitter_video_url,
    prepare,
    probe_video,
    sanitize_source_info,
    screenshot_times,
    twitter_proxy_urls,
    twitter_status_id,
    youtube_format_selector,
    youtube_retry_plan,
    ytdlp_base_args,
)


class PrepareVideoTests(unittest.TestCase):
    def test_newer_ytdlp_is_preferred_and_youtube_403_is_readable(self):
        self.assertEqual(parse_ytdlp_version("2026.08.19"), (2026, 8, 19))
        self.assertEqual(parse_ytdlp_version("2026.03.17"), (2026, 3, 17))
        chosen = choose_ytdlp_binary([
            ("/old/yt-dlp", "2026.03.17"),
            ("/mid/yt-dlp", "2026.06.09"),
            ("/new/yt-dlp", "2026.08.19"),
        ])
        self.assertEqual(chosen, "/new/yt-dlp")
        args = ytdlp_base_args("/new/yt-dlp", "video.%(ext)s", DEFAULT_VIDEO_FORMAT)
        self.assertIn("--no-update", args)
        self.assertNotIn("--cookies-from-browser", args)
        raw = (
            "WARNING: Your yt-dlp version (2026.03.17) is older than 90 days!\n"
            "ERROR: unable to download video data: HTTP Error 403: Forbidden"
        )
        message = humanize_download_error(raw)
        self.assertIn("403", message)
        self.assertNotIn("WARNING", message)
        self.assertNotIn("older than 90 days", message)
        self.assertEqual(youtube_retry_plan(raw), ["android"])
        self.assertEqual(
            youtube_retry_plan("ERROR: Sign in to confirm you’re not a bot"),
            ["chrome-cookies"],
        )
        self.assertEqual(youtube_retry_plan("ERROR: Video unavailable"), [])

    def test_long_videos_cap_youtube_height_at_720(self):
        self.assertEqual(youtube_format_selector(60), DEFAULT_VIDEO_FORMAT)
        self.assertEqual(youtube_format_selector(19 * 60), DEFAULT_VIDEO_FORMAT)
        self.assertEqual(youtube_format_selector(20 * 60), LONG_VIDEO_FORMAT)
        self.assertEqual(youtube_format_selector(10710), LONG_VIDEO_FORMAT)
        self.assertIn("height<=720", LONG_VIDEO_FORMAT)

    def test_clear_incomplete_video_downloads_keeps_finished_file(self):
        with TemporaryDirectory() as temp_dir:
            job_dir = Path(temp_dir)
            finished = job_dir / "video.mp4"
            part = job_dir / "video.mp4.part"
            frag = job_dir / "video.mp4.part-Frag1.part"
            finished.write_bytes(b"ok")
            part.write_bytes(b"partial")
            frag.write_bytes(b"frag")
            clear_incomplete_video_downloads(job_dir)
            self.assertTrue(finished.is_file())
            self.assertFalse(part.exists())
            self.assertFalse(frag.exists())

    def test_youtube_detection(self):
        self.assertTrue(is_youtube_url("https://www.youtube.com/watch?v=abc"))
        self.assertTrue(is_youtube_url("https://youtu.be/abc"))
        self.assertFalse(is_youtube_url("https://x.com/user/status/1"))
        self.assertTrue(is_twitter_url("https://x.com/user/status/1"))
        self.assertEqual(twitter_status_id("https://x.com/tinksillie/status/2089552751726592510?s=20"), "2089552751726592510")
        self.assertEqual(
            twitter_proxy_urls("https://x.com/user/status/2092803742466728097?s=20"),
            [
                "https://vxtwitter.com/i/status/2092803742466728097",
                "https://fxtwitter.com/i/status/2092803742466728097",
            ],
        )
        self.assertEqual(
            pick_fxtwitter_video_url({
                "tweet": {"media": {"videos": [
                    {"url": "https://video.twimg.com/amplify_video/1/vid.mp4?tag=21"},
                    {"url": "https://video.twimg.com/amplify_video/1/vid.m3u8"},
                ]}},
            }),
            "https://video.twimg.com/amplify_video/1/vid.mp4?tag=21",
        )

    def test_screenshot_times_stay_inside_video(self):
        self.assertEqual(screenshot_times(10), [2.0, 5.0, 8.0])
        self.assertTrue(all(0 <= value < 0.1 for value in screenshot_times(0.05)))

    def test_source_info_is_small_and_safe(self):
        source = sanitize_source_info({
            "title": "A" * 700,
            "description": "B" * 5_000,
            "tags": [str(index) for index in range(50)],
            "url": "https://signed-media.example/secret",
        })
        self.assertEqual(len(source["title"]), 500)
        self.assertEqual(len(source["description"]), 4_000)
        self.assertEqual(len(source["tags"]), 30)
        self.assertNotIn("url", source)
        self.assertEqual(source["comments"], [])
        self.assertEqual(source["comment_status"], "empty")

    def test_comments_are_trimmed_and_rendered_as_text(self):
        comments = normalize_comments([
            {"author": "a", "text": "kurtina scene", "like_count": 12},
            {"text": ""},
            {"user": "b", "content": "donny and belle"},
        ])
        self.assertEqual(len(comments), 2)
        self.assertIn("kurtina scene", comments_as_text(comments))
        source = sanitize_source_info({"title": "t", "comments": [{"author": "a", "text": "hello"}]})
        self.assertEqual(source["comment_status"], "from_info")
        self.assertEqual(source["comments_text"], "a: hello")

    def test_prepare_records_visual_and_speech_evidence(self):
        with TemporaryDirectory() as temp_dir:
            job_dir = Path(temp_dir)
            video_path = job_dir / "video.mp4"
            video_path.touch()
            transcript = {
                "status": "ready", "has_speech": True, "language": "zh",
                "segments": [{"start": 0.0, "end": 1.0, "text": "测试"}], "error": "",
            }
            frames = [{"id": "frame-01", "time": 0.5, "path": str(job_dir / "analysis_frames/frame01.jpg")}]
            with (
                patch("prepare_video.download_video", return_value=(video_path, {})),
                patch("prepare_video.probe_video", return_value=({"streams": [{"codec_type": "audio"}]}, 5.0)),
                patch("prepare_video.capture_screenshots", return_value=["cover-1", "cover-2", "cover-3"]),
                patch("prepare_video.capture_analysis_frames", return_value=frames),
                patch("prepare_video.transcribe_video", return_value=transcript),
            ):
                prepare("https://example.com/video", job_dir)

            result = json.loads((job_dir / "prepare_result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["analysis_frames"], frames)
            self.assertEqual(result["transcript_status"], "ready")
            self.assertTrue(result["has_speech"])
            self.assertEqual(json.loads((job_dir / "visual_timeline.json").read_text(encoding="utf-8")), {"frames": frames})
            self.assertEqual(json.loads((job_dir / "transcript.json").read_text(encoding="utf-8")), transcript)

    def test_probe_video_uses_video_stream_duration_when_format_duration_is_invalid(self):
        cases = (
            {},
            {"duration": "0"},
            {"duration": "nan"},
            {"duration": "inf"},
        )
        for format_data in cases:
            with self.subTest(format_data=format_data), TemporaryDirectory() as temp_dir:
                probe = {
                    "format": format_data,
                    "streams": [
                        {"codec_type": "video", "duration": "12.5"},
                        {"codec_type": "audio", "duration": "99.0"},
                    ],
                }
                with patch("prepare_video.run_command", return_value=json.dumps(probe)):
                    returned_probe, duration = probe_video(Path("movie.mp4"), Path(temp_dir))

                self.assertEqual(returned_probe, probe)
                self.assertEqual(duration, 12.5)

    def test_prepare_rejects_unknown_duration_before_analysis_capture(self):
        with TemporaryDirectory() as temp_dir:
            job_dir = Path(temp_dir)
            video_path = job_dir / "video.mp4"
            video_path.touch()
            with (
                patch("prepare_video.download_video", return_value=(video_path, {})),
                patch("prepare_video.probe_video", return_value=({"streams": [{"codec_type": "video"}]}, 0.0)),
                patch("prepare_video.capture_screenshots", return_value=["cover-1", "cover-2", "cover-3"]),
                patch("content_evidence._run_ffmpeg") as run_ffmpeg,
            ):
                with self.assertRaisesRegex(ValueError, "视频时长必须为有限正数"):
                    prepare("https://example.com/video", job_dir)

            run_ffmpeg.assert_not_called()


if __name__ == "__main__":
    unittest.main()
