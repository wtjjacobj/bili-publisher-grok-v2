import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

from content_evidence import (
    analysis_frame_times,
    capture_analysis_frames,
    has_audio_stream,
    no_audio_transcript,
    transcribe_video,
)


class ContentEvidenceTests(unittest.TestCase):
    def test_analysis_frames_cover_opening_and_ending(self):
        self.assertEqual(
            analysis_frame_times(100.0),
            [5.0, 15.0, 25.0, 35.0, 45.0, 55.0, 65.0, 75.0, 85.0, 95.0],
        )

    def test_short_video_still_has_ten_ordered_times(self):
        times = analysis_frame_times(0.5)
        self.assertEqual(len(times), 10)
        self.assertEqual(times, sorted(times))
        self.assertEqual(times[0], 0.025)
        self.assertEqual(times[-1], 0.475)

    def test_analysis_frames_reject_non_positive_or_non_finite_duration(self):
        for duration in (0.0, -1.0, float("nan"), float("inf"), float("-inf")):
            with self.subTest(duration=duration):
                with self.assertRaisesRegex(ValueError, "视频时长必须为有限正数"):
                    analysis_frame_times(duration)

    def test_audio_detection_and_no_audio_result(self):
        probe = {"streams": [{"codec_type": "video"}, {"codec_type": "audio"}]}
        self.assertTrue(has_audio_stream(probe))
        self.assertEqual(no_audio_transcript(), {
            "status": "no_audio",
            "has_speech": False,
            "language": "",
            "segments": [],
            "error": "",
        })

    def test_capture_analysis_frames_creates_ten_timestamped_records(self):
        with TemporaryDirectory() as temp_dir:
            job_dir = Path(temp_dir)

            def create_frame(args):
                Path(args[-1]).write_bytes(b"jpeg")

            with patch("content_evidence._run_ffmpeg", side_effect=create_frame) as run_ffmpeg:
                frames = capture_analysis_frames(Path("movie.mp4"), job_dir, 10.0)

            self.assertEqual(len(frames), 10)
            self.assertEqual(frames[0]["id"], "frame-01")
            self.assertEqual(frames[0]["time"], 0.5)
            self.assertEqual(frames[-1]["time"], 9.5)
            self.assertEqual(Path(frames[0]["path"]), (job_dir / "analysis_frames" / "frame01.jpg").resolve())
            self.assertEqual(run_ffmpeg.call_count, 10)

    def test_transcribe_video_without_audio_skips_model_loading(self):
        self.assertEqual(transcribe_video(Path("movie.mp4"), False), no_audio_transcript())

    def test_transcribe_video_returns_ready_segments_from_local_model(self):
        module = ModuleType("faster_whisper")

        class FakeWhisperModel:
            init_args = None
            init_kwargs = None
            transcribe_args = None
            transcribe_kwargs = None

            def __init__(self, *args, **kwargs):
                type(self).init_args = args
                type(self).init_kwargs = kwargs

            def transcribe(self, *args, **kwargs):
                type(self).transcribe_args = args
                type(self).transcribe_kwargs = kwargs
                segment = SimpleNamespace(
                    start=1.0,
                    end=2.5,
                    text=" hello ",
                    avg_logprob=-0.125,
                    no_speech_prob=0.025,
                )
                return iter([segment]), SimpleNamespace(language="zh")

        module.WhisperModel = FakeWhisperModel
        with patch.dict("sys.modules", {"faster_whisper": module}):
            transcript = transcribe_video(Path("movie.mp4"), True)

        self.assertEqual(transcript, {
            "status": "ready",
            "has_speech": True,
            "language": "zh",
            "segments": [{
                "start": 1.0,
                "end": 2.5,
                "text": "hello",
                "avg_logprob": -0.125,
                "no_speech_prob": 0.025,
            }],
            "error": "",
        })
        self.assertEqual(json.loads(json.dumps(transcript)), transcript)
        self.assertEqual(FakeWhisperModel.init_args, ("large-v3-turbo",))
        self.assertEqual(FakeWhisperModel.init_kwargs, {
            "device": "cpu",
            "compute_type": "int8",
            "local_files_only": True,
        })
        self.assertEqual(FakeWhisperModel.transcribe_args, ("movie.mp4",))
        self.assertEqual(FakeWhisperModel.transcribe_kwargs, {"vad_filter": True, "beam_size": 5})

    def test_transcribe_video_reports_no_speech_for_empty_segments(self):
        module = ModuleType("faster_whisper")

        class FakeWhisperModel:
            def __init__(self, *args, **kwargs):
                pass

            def transcribe(self, *args, **kwargs):
                return iter([]), SimpleNamespace(language="zh")

        module.WhisperModel = FakeWhisperModel
        with patch.dict("sys.modules", {"faster_whisper": module}):
            transcript = transcribe_video(Path("movie.mp4"), True)

        self.assertEqual(transcript, {
            "status": "no_speech",
            "has_speech": False,
            "language": "zh",
            "segments": [],
            "error": "",
        })

    def test_transcribe_video_reports_no_speech_for_blank_segments(self):
        module = ModuleType("faster_whisper")

        class FakeWhisperModel:
            def __init__(self, *args, **kwargs):
                pass

            def transcribe(self, *args, **kwargs):
                segment = SimpleNamespace(start=0.0, end=1.0, text=" \n ")
                return iter([segment]), SimpleNamespace(language="en")

        module.WhisperModel = FakeWhisperModel
        with patch.dict("sys.modules", {"faster_whisper": module}):
            transcript = transcribe_video(Path("movie.mp4"), True)

        self.assertEqual(transcript, {
            "status": "no_speech",
            "has_speech": False,
            "language": "en",
            "segments": [],
            "error": "",
        })

    def test_transcribe_video_bounds_model_construction_errors(self):
        module = ModuleType("faster_whisper")
        message = "model unavailable " + ("x" * 800)

        class BrokenWhisperModel:
            def __init__(self, *args, **kwargs):
                raise RuntimeError(message)

        module.WhisperModel = BrokenWhisperModel
        with patch.dict("sys.modules", {"faster_whisper": module}):
            transcript = transcribe_video(Path("movie.mp4"), True)

        self.assertEqual(transcript["status"], "unavailable")
        self.assertIsNone(transcript["has_speech"])
        self.assertEqual(transcript["segments"], [])
        self.assertEqual(transcript["language"], "")
        self.assertEqual(transcript["error"], message[:500])

    def test_transcribe_video_bounds_lazy_segment_iteration_errors(self):
        module = ModuleType("faster_whisper")
        message = "decode failed " + ("y" * 800)

        class BrokenWhisperModel:
            def __init__(self, *args, **kwargs):
                pass

            def transcribe(self, *args, **kwargs):
                def broken_segments():
                    raise RuntimeError(message)
                    yield

                return broken_segments(), SimpleNamespace(language="zh")

        module.WhisperModel = BrokenWhisperModel
        with patch.dict("sys.modules", {"faster_whisper": module}):
            transcript = transcribe_video(Path("movie.mp4"), True)

        self.assertEqual(transcript["status"], "unavailable")
        self.assertIsNone(transcript["has_speech"])
        self.assertEqual(transcript["segments"], [])
        self.assertEqual(transcript["language"], "")
        self.assertEqual(transcript["error"], message[:500])


if __name__ == "__main__":
    unittest.main()
