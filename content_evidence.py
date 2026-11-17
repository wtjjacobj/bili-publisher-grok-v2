"""Local, deterministic visual and speech evidence helpers."""

from __future__ import annotations

import math
import os
import subprocess
from pathlib import Path


FFMPEG = "/opt/homebrew/Caskroom/miniforge/base/bin/ffmpeg"
MAX_ERROR_CHARS = 500
# Every analysis frame is inlined as base64 in each model request, and a job
# sends all ten of them several times over. Source resolution buys no accuracy
# the vision model can use, so cap the long edge; 1280 still resolves on-screen
# text such as game UI strings and protest banners.
ANALYSIS_FRAME_MAX_EDGE = 1280
ANALYSIS_FRAME_QUALITY = 4
ANALYSIS_FRAME_SCALE_FILTER = (
    f"scale=w='min({ANALYSIS_FRAME_MAX_EDGE},iw)':h='min({ANALYSIS_FRAME_MAX_EDGE},ih)'"
    ":force_original_aspect_ratio=decrease:flags=lanczos"
)


def analysis_frame_times(duration: float, count: int = 10) -> list[float]:
    """Return evenly spaced midpoint timestamps over the video duration."""
    if count <= 0:
        return []
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("视频时长必须为有限正数，无法截取分析帧")
    return [duration * (index + 0.5) / count for index in range(count)]


def _run_ffmpeg(args: list[str]) -> None:
    completed = subprocess.run(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        timeout=120,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stdout.strip()[-1_500:] or "ffmpeg 截帧失败")


def capture_analysis_frames(video_path: Path, job_dir: Path, duration: float) -> list[dict]:
    """Capture one image per analysis timestamp."""
    timestamps = analysis_frame_times(duration)
    frame_dir = job_dir / "analysis_frames"
    frame_dir.mkdir(parents=True, exist_ok=True)
    frames: list[dict] = []
    for index, timestamp in enumerate(timestamps, start=1):
        output = frame_dir / f"frame{index:02d}.jpg"
        _run_ffmpeg([
            FFMPEG, "-y", "-ss", str(timestamp), "-i", str(video_path),
            "-frames:v", "1", "-vf", ANALYSIS_FRAME_SCALE_FILTER,
            "-q:v", str(ANALYSIS_FRAME_QUALITY), str(output),
        ])
        if not output.is_file() or output.stat().st_size == 0:
            raise RuntimeError(f"分析帧未生成：{output.name}")
        frames.append({
            "id": f"frame-{index:02d}",
            "time": timestamp,
            "path": str(output.resolve()),
        })
    return frames


def has_audio_stream(probe_data: dict) -> bool:
    """Return whether ffprobe data contains an audio stream."""
    streams = probe_data.get("streams") if isinstance(probe_data, dict) else None
    return isinstance(streams, list) and any(
        isinstance(stream, dict) and stream.get("codec_type") == "audio"
        for stream in streams
    )


def no_audio_transcript() -> dict:
    return {
        "status": "no_audio",
        "has_speech": False,
        "language": "",
        "segments": [],
        "error": "",
    }


def transcribe_video(video_path: Path, audio_present: bool) -> dict:
    """Use the locally cached Whisper model; transcription errors remain data."""
    if not audio_present:
        return no_audio_transcript()

    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(
            os.environ.get("BILI_TRANSCRIBE_MODEL", "large-v3-turbo"),
            device="cpu",
            compute_type="int8",
            local_files_only=True,
        )
        raw_segments, info = model.transcribe(str(video_path), vad_filter=True, beam_size=5)
        segments = [
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "text": segment.text.strip(),
                "avg_logprob": float(segment.avg_logprob),
                "no_speech_prob": float(segment.no_speech_prob),
            }
            for segment in raw_segments
            if segment.text.strip()
        ]
        if segments:
            return {
                "status": "ready",
                "has_speech": True,
                "language": getattr(info, "language", "") or "",
                "segments": segments,
                "error": "",
            }
        return {
            "status": "no_speech",
            "has_speech": False,
            "language": getattr(info, "language", "") or "",
            "segments": [],
            "error": "",
        }
    except Exception as exc:
        return {
            "status": "unavailable",
            "has_speech": None,
            "language": "",
            "segments": [],
            "error": str(exc).strip()[:MAX_ERROR_CHARS],
        }
