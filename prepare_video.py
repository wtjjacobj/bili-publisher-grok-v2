#!/usr/bin/env python3
"""Deterministic, local preparation for the simplified Bilibili workflow."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from content_evidence import capture_analysis_frames, has_audio_stream, transcribe_video


FFMPEG = "/opt/homebrew/Caskroom/miniforge/base/bin/ffmpeg"
FFPROBE = "/opt/homebrew/Caskroom/miniforge/base/bin/ffprobe"
MAX_LOG_CHARS = 20_000
_YT_DLP_BIN = ""
PROXY_ENV_KEYS = ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy")


def parse_ytdlp_version(text: str) -> tuple[int, ...]:
    match = re.search(r"(\d{4})\.(\d{1,2})\.(\d{1,2})", text or "")
    if not match:
        return ()
    return tuple(int(part) for part in match.groups())


def choose_ytdlp_binary(candidates: list[tuple[str, str]]) -> str:
    usable = [(path, version) for path, version in candidates if path]
    if not usable:
        raise RuntimeError("未找到 yt-dlp")
    return max(usable, key=lambda item: parse_ytdlp_version(item[1]) or (0,))[0]


def ytdlp_bin() -> str:
    global _YT_DLP_BIN
    if _YT_DLP_BIN:
        return _YT_DLP_BIN
    candidates: list[str] = []
    override = os.environ.get("BILI_YT_DLP", "").strip()
    if override:
        candidates.append(override)
    candidates.extend([
        "/opt/homebrew/bin/yt-dlp",
        "/opt/homebrew/Caskroom/miniforge/base/bin/yt-dlp",
        "/usr/local/bin/yt-dlp",
    ])
    discovered = shutil.which("yt-dlp")
    if discovered:
        candidates.append(discovered)
    scored: list[tuple[str, str]] = []
    seen: set[str] = set()
    for path in candidates:
        if not path or path in seen:
            continue
        seen.add(path)
        if not os.path.isfile(path) or not os.access(path, os.X_OK):
            continue
        version = ""
        try:
            completed = subprocess.run(
                [path, "--version"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=15,
                check=False,
            )
            lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
            version = lines[-1] if lines else ""
        except Exception:
            version = ""
        scored.append((path, version))
    if not scored:
        raise RuntimeError("未找到 yt-dlp，请先安装")
    _YT_DLP_BIN = choose_ytdlp_binary(scored)
    return _YT_DLP_BIN


def ytdlp_base_args(binary: str, output_template: str, video_format: str) -> list[str]:
    return [
        binary,
        "--no-update",
        "--no-playlist",
        "--no-progress",
        "--newline",
        "--format", video_format,
        "--format-sort", "res,br,size,fps,proto:https",
        "--format-sort-force",
        "--merge-output-format", "mp4",
        "--remux-video", "mp4",
        "--write-info-json",
        "--output", output_template,
    ]


def should_try_alternate_youtube_client(raw: str) -> bool:
    text = raw or ""
    markers = ("403", "Forbidden", "Requested format is not available", "Only images are available", "SABR", "missing a URL")
    return any(marker in text for marker in markers)


def should_try_browser_cookies(raw: str) -> bool:
    text = (raw or "").lower()
    markers = ("sign in to confirm", "not a bot", "login required", "confirm your age", "age-restricted", "age restricted")
    return any(marker in text for marker in markers)


def youtube_retry_plan(error: str) -> list[str]:
    plan: list[str] = []
    if should_try_alternate_youtube_client(error):
        plan.append("android")
    if should_try_browser_cookies(error):
        plan.append("chrome-cookies")
    return plan


def humanize_download_error(raw: str) -> str:
    chunks = [chunk.strip() for chunk in (raw or "").split("\n\n") if chunk.strip()]
    last = chunks[-1] if chunks else (raw or "")
    kind = _download_error_kind(last) or _download_error_kind(raw or "")
    if kind == "403":
        if len(chunks) > 1:
            return "YouTube 拒绝下载（403）。默认线路和备用线路都失败了，过几分钟再试。"
        return "YouTube 拒绝下载（403）。过几分钟再试。"
    if kind == "bot":
        return "YouTube 要求登录验证。请先在 Chrome 打开并登录 YouTube，然后再试。"
    if kind == "format":
        return "YouTube 没有给出可下载的视频流。换一个链接，或过几分钟再试。"
    if kind == "unavailable":
        return "这个视频不可用，可能已删除、设为私密，或当前网络看不了。"
    match = re.search(r"ERROR:\s*(.+)", last)
    if match:
        return f"视频下载失败：{match.group(1).strip()[:180]}"
    lines = [
        line.strip() for line in (raw or "").splitlines()
        if line.strip()
        and not line.strip().startswith("WARNING:")
        and "suppress this warning" not in line
        and not line.strip().startswith("It is strongly")
        and not line.strip().startswith("You installed")
        and not line.strip().startswith("To suppress")
    ]
    text = " ".join(lines).strip()
    return (text[-240:] or "视频下载失败")


def _download_error_kind(text: str) -> str:
    if "HTTP Error 403" in text or "403 Forbidden" in text:
        return "403"
    lowered = text.lower()
    if "sign in to confirm" in lowered or "not a bot" in lowered:
        return "bot"
    if "Requested format is not available" in text or "Only images are available" in text:
        return "format"
    if "Video unavailable" in text or "Private video" in text:
        return "unavailable"
    return ""


def without_proxy(env: dict[str, str]) -> dict[str, str]:
    clean = env.copy()
    for key in PROXY_ENV_KEYS:
        clean.pop(key, None)
    return clean


def env_has_proxy(env: dict[str, str]) -> bool:
    return any(str(env.get(key) or "").strip() for key in PROXY_ENV_KEYS)


def write_json(path: Path, value: object) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def update_progress(job_dir: Path, step: int, message: str, percent: int) -> None:
    write_json(job_dir / "progress.json", {
        "step": step,
        "total": 5,
        "message": message,
        "percent": percent,
    })


def is_youtube_url(url: str) -> bool:
    hostname = (urlparse(url).hostname or "").lower()
    return hostname == "youtu.be" or hostname.endswith("youtube.com")


def is_twitter_url(url: str) -> bool:
    hostname = (urlparse(url).hostname or "").lower()
    return hostname in {"x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "vxtwitter.com", "fxtwitter.com"}


def twitter_status_id(url: str) -> str:
    match = re.search(r"/status/(\d+)", url or "")
    return match.group(1) if match else ""


def normalize_comments(raw: object, limit: int = 25) -> list[dict]:
    if not isinstance(raw, list):
        return []
    comments: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or item.get("content") or item.get("full_text") or "").strip()
        if not text:
            continue
        likes_raw = item.get("like_count", item.get("likes", item.get("favorite_count", 0)))
        try:
            likes = int(likes_raw or 0)
        except (TypeError, ValueError):
            likes = 0
        comments.append({
            "author": str(item.get("author") or item.get("user") or item.get("screen_name") or "")[:80],
            "text": text[:400],
            "likes": max(0, likes),
        })
        if len(comments) >= limit:
            break
    return comments


def comments_as_text(comments: list[dict]) -> str:
    lines = []
    for comment in comments[:25]:
        author = str(comment.get("author") or "匿名").strip() or "匿名"
        text = str(comment.get("text") or "").strip()
        if text:
            lines.append(f"{author}: {text}")
    return "\n".join(lines)[:6_000]


def fetch_youtube_comments(url: str) -> list[dict]:
    from tempfile import TemporaryDirectory
    with TemporaryDirectory(prefix="bili-comments-") as temp_dir:
        output = Path(temp_dir) / "social"
        run_command([
            ytdlp_bin(),
            "--no-update",
            "--skip-download",
            "--write-info-json",
            "--no-playlist",
            "--no-progress",
            "--extractor-args", "youtube:max_comments=30;comment_sort=top",
            "--output", str(output),
            url,
        ], timeout=60)
        info_files = list(Path(temp_dir).glob("*.info.json"))
        if not info_files:
            return []
        info = json.loads(info_files[0].read_text(encoding="utf-8"))
        return normalize_comments(info.get("comments"))


def twitter_proxy_urls(url: str) -> list[str]:
    status_id = twitter_status_id(url)
    if not status_id:
        return []
    return [
        f"https://vxtwitter.com/i/status/{status_id}",
        f"https://fxtwitter.com/i/status/{status_id}",
    ]


def video_quality_rank(url: str, bitrate: int = 0) -> tuple[int, int, int]:
    match = re.search(r"(\d{3,5})x(\d{3,5})", url or "")
    height = int(match.group(2)) if match else 0
    progressive = 1 if ".mp4" in (url or "") and "m3u8" not in (url or "") else 0
    return (height, int(bitrate or 0), progressive)


def pick_fxtwitter_video_url(payload: object) -> str:
    tweet = payload.get("tweet") if isinstance(payload, dict) else None
    if not isinstance(tweet, dict):
        tweet = payload if isinstance(payload, dict) else {}
    media = tweet.get("media") if isinstance(tweet.get("media"), dict) else {}
    videos = media.get("videos") if isinstance(media.get("videos"), list) else []
    ranked: list[tuple[tuple[int, int, int], str]] = []
    for item in videos:
        if not isinstance(item, dict):
            candidate = str(item or "").strip()
            if candidate.startswith("http"):
                ranked.append((video_quality_rank(candidate), candidate))
            continue
        pools = [item]
        for key in ("formats", "variants"):
            nested = item.get(key)
            if isinstance(nested, list):
                pools.extend(entry for entry in nested if isinstance(entry, dict))
        for entry in pools:
            candidate = str(entry.get("url") or entry.get("url_direct") or "").strip()
            if not candidate.startswith("http"):
                continue
            bitrate = entry.get("bitrate") or 0
            try:
                bitrate = int(bitrate)
            except (TypeError, ValueError):
                bitrate = 0
            ranked.append((video_quality_rank(candidate, bitrate), candidate))
    if not ranked:
        return ""
    ranked.sort(key=lambda item: item[0], reverse=True)
    return ranked[0][1]


def download_twitter_via_fxtwitter(url: str, video_path: Path) -> dict:
    status_id = twitter_status_id(url)
    if not status_id:
        raise RuntimeError("无法解析推特状态ID")
    request = Request(
        f"https://api.fxtwitter.com/status/{status_id}",
        headers={"User-Agent": "bili-publisher-grok/1.2", "Accept": "application/json"},
    )
    with urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8", errors="replace"))
    video_url = pick_fxtwitter_video_url(payload)
    if not video_url:
        raise RuntimeError("fxtwitter 没有返回可下载的视频地址")
    tweet = payload.get("tweet") if isinstance(payload, dict) else {}
    if not isinstance(tweet, dict):
        tweet = {}
    author = tweet.get("author") if isinstance(tweet.get("author"), dict) else {}
    video_request = Request(video_url, headers={"User-Agent": "bili-publisher-grok/1.2"})
    with urlopen(video_request, timeout=180) as response:
        data = response.read()
    if len(data) < 10_000:
        raise RuntimeError("fxtwitter 视频下载过短，不像完整视频")
    video_path.write_bytes(data)
    text = str(tweet.get("text") or tweet.get("raw_text") or "").strip()
    uploader = str(author.get("screen_name") or author.get("name") or "").strip()
    return sanitize_source_info({
        "title": text,
        "description": text,
        "uploader": uploader,
        "channel": uploader,
        "webpage_url": str(tweet.get("url") or url),
    })


def fetch_twitter_social_context(url: str) -> list[dict]:
    status_id = twitter_status_id(url)
    if not status_id:
        return []
    request = Request(
        f"https://api.fxtwitter.com/status/{status_id}",
        headers={"User-Agent": "bili-publisher-grok/1.2", "Accept": "application/json"},
    )
    with urlopen(request, timeout=12) as response:
        payload = json.loads(response.read().decode("utf-8", errors="replace"))
    tweet = payload.get("tweet") if isinstance(payload, dict) else None
    if not isinstance(tweet, dict):
        tweet = payload if isinstance(payload, dict) else {}
    raw: list[dict] = []
    for key in ("community_note", "note"):
        note = tweet.get(key)
        if isinstance(note, str) and note.strip():
            raw.append({"author": "community_note", "text": note.strip()})
        elif isinstance(note, dict) and note.get("text"):
            raw.append({"author": "community_note", "text": str(note.get("text"))})
    quote = tweet.get("quote") or tweet.get("quoted_tweet") or {}
    if isinstance(quote, dict) and (quote.get("text") or quote.get("full_text")):
        raw.append({
            "author": str(quote.get("author", {}).get("screen_name") if isinstance(quote.get("author"), dict) else quote.get("author") or "quoted"),
            "text": str(quote.get("text") or quote.get("full_text") or ""),
        })
    replies = tweet.get("replies") or tweet.get("conversation") or []
    if isinstance(replies, list):
        raw.extend(replies)
    return normalize_comments(raw)


def enrich_social_context(url: str, source: dict) -> dict:
    enriched = dict(source)
    comments = list(enriched.get("comments") or [])
    status = str(enriched.get("comment_status") or "empty")
    try:
        if is_youtube_url(url) and not comments:
            comments = fetch_youtube_comments(url)
            status = "ok" if comments else "empty"
        elif is_twitter_url(url):
            extra = fetch_twitter_social_context(url)
            existing_text = {item.get("text") for item in comments}
            for item in extra:
                if item.get("text") not in existing_text:
                    comments.append(item)
            status = "ok" if comments else "empty"
    except Exception as exc:
        status = f"unavailable:{str(exc).strip()[:180]}"
    comments = comments[:25]
    enriched["comments"] = comments
    enriched["comments_text"] = comments_as_text(comments)
    enriched["comment_status"] = status
    return enriched


def screenshot_times(duration: float) -> list[float]:
    if duration <= 0:
        return [0.0, 0.1, 0.2]
    end = max(0.0, duration - 0.05)
    return [round(min(end, max(0.0, duration * ratio)), 3) for ratio in (0.2, 0.5, 0.8)]


def sanitize_source_info(info: dict) -> dict:
    def text(value: object, limit: int) -> str:
        return str(value or "").strip()[:limit]

    def string_list(value: object, limit: int) -> list[str]:
        if not isinstance(value, list):
            return []
        return [text(item, 100) for item in value[:limit] if text(item, 100)]

    comments = normalize_comments(info.get("comments"))
    return {
        "title": text(info.get("title"), 500),
        "description": text(info.get("description"), 4_000),
        "uploader": text(info.get("uploader") or info.get("channel"), 300),
        "channel": text(info.get("channel"), 300),
        "duration": float(info.get("duration") or 0),
        "upload_date": text(info.get("upload_date"), 20),
        "tags": string_list(info.get("tags"), 30),
        "categories": string_list(info.get("categories"), 10),
        "webpage_url": text(info.get("webpage_url") or info.get("original_url"), 2_048),
        "comments": comments,
        "comments_text": comments_as_text(comments),
        "comment_status": "from_info" if comments else "empty",
    }


LONG_VIDEO_SECONDS = 20 * 60
DOWNLOAD_TIMEOUT_SECONDS = 3 * 60 * 60
DEFAULT_VIDEO_FORMAT = "bv*+ba/b"


def youtube_format_selector(duration_seconds: float) -> str:
    return DEFAULT_VIDEO_FORMAT


def cached_source_duration(job_dir: Path) -> float:
    info_path = job_dir / "video.info.json"
    if not info_path.is_file():
        return 0.0
    try:
        info = json.loads(info_path.read_text(encoding="utf-8"))
    except Exception:
        return 0.0
    if not isinstance(info, dict):
        return 0.0
    return positive_duration(info.get("duration"))


def probe_remote_duration(url: str, env: dict[str, str]) -> float:
    try:
        raw = run_command(
            [ytdlp_bin(), "--no-update", "--no-playlist", "--skip-download", "--print", "%(duration)s", url],
            env=env,
            timeout=90,
        )
    except Exception:
        return 0.0
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    return positive_duration(lines[-1] if lines else "")


def clear_incomplete_video_downloads(job_dir: Path) -> None:
    for path in job_dir.glob("video.mp4*"):
        if path.name == "video.mp4":
            continue
        try:
            path.unlink()
        except OSError:
            pass


def run_command(args: list[str], *, env: dict[str, str] | None = None, timeout: int = 1_800) -> str:
    completed = subprocess.run(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        env=env,
        timeout=timeout,
        check=False,
    )
    output = completed.stdout[-MAX_LOG_CHARS:]
    if completed.returncode != 0:
        raise RuntimeError(output.strip()[-1_500:] or f"命令退出({completed.returncode})")
    return output


def clear_failed_download_artifacts(job_dir: Path) -> None:
    clear_incomplete_video_downloads(job_dir)
    info = job_dir / "video.info.json"
    if info.is_file():
        try:
            info.unlink()
        except OSError:
            pass


def download_video(url: str, job_dir: Path) -> tuple[Path, dict]:
    output_template = str(job_dir / "video.%(ext)s")
    normal_env = os.environ.copy()
    clean_proxy_env = without_proxy(normal_env)
    duration = cached_source_duration(job_dir)
    if is_youtube_url(url) and duration <= 0:
        duration = probe_remote_duration(url, normal_env)
    video_format = youtube_format_selector(duration) if is_youtube_url(url) else DEFAULT_VIDEO_FORMAT
    if video_format != DEFAULT_VIDEO_FORMAT:
        clear_incomplete_video_downloads(job_dir)
    base_args = ytdlp_base_args(ytdlp_bin(), output_template, video_format)
    errors: list[str] = []
    used_android = False

    def attempt(extra: list[str], env: dict[str, str], label: str) -> bool:
        update_progress(job_dir, 1, label, 15)
        try:
            run_command(base_args + extra, env=env, timeout=DOWNLOAD_TIMEOUT_SECONDS)
            return True
        except Exception as exc:
            errors.append(str(exc))
            clear_failed_download_artifacts(job_dir)
            return False

    downloaded = False
    source_override: dict | None = None
    if is_youtube_url(url):
        downloaded = attempt([url], normal_env, "正在下载视频")
        retry_plan = youtube_retry_plan(errors[-1]) if errors else []
        if not downloaded and "android" in retry_plan:
            downloaded = attempt(
                ["--extractor-args", "youtube:player_client=android", url],
                normal_env,
                "YouTube 默认线路被拒绝，正在换备用线路",
            )
            used_android = downloaded
        if not downloaded and "chrome-cookies" in retry_plan:
            downloaded = attempt(
                ["--cookies-from-browser", "chrome", url],
                normal_env,
                "YouTube 要求登录，正在使用 Chrome 登录态",
            )
        if not downloaded and env_has_proxy(normal_env):
            downloaded = attempt([url], clean_proxy_env, "正在不走代理重试下载")
    elif is_twitter_url(url):
        downloaded = attempt(["--cookies-from-browser", "chrome", url], normal_env, "正在下载视频")
        if not downloaded:
            downloaded = attempt([url], normal_env, "正在直接下载视频")
        if not downloaded:
            for proxy_url in twitter_proxy_urls(url):
                if attempt([proxy_url], normal_env, "正在通过视频代理下载"):
                    downloaded = True
                    break
        if not downloaded and env_has_proxy(normal_env):
            downloaded = attempt([url], clean_proxy_env, "正在不走代理重试下载")
        if not downloaded:
            try:
                source_override = download_twitter_via_fxtwitter(url, job_dir / "video.mp4")
                downloaded = True
            except Exception as exc:
                errors.append(str(exc))
    else:
        downloaded = attempt([url], normal_env, "正在下载视频")
        if not downloaded and env_has_proxy(normal_env):
            downloaded = attempt([url], clean_proxy_env, "正在不走代理重试下载")

    if not downloaded:
        raw = "\n\n".join(errors)
        try:
            (job_dir / "download_error.txt").write_text(raw[-8000:], encoding="utf-8")
        except OSError:
            pass
        raise RuntimeError(humanize_download_error(raw))

    video_path = job_dir / "video.mp4"
    if not video_path.is_file():
        candidates = sorted(
            path for path in job_dir.glob("video.*")
            if path.suffix.lower() in {".webm", ".mkv", ".mov", ".m4v"}
        )
        if not candidates:
            raise RuntimeError("下载完成但没有找到视频文件")
        try:
            run_command([FFMPEG, "-y", "-i", str(candidates[0]), "-c", "copy", "-movflags", "+faststart", str(video_path)])
        except Exception:
            run_command([
                FFMPEG, "-y", "-i", str(candidates[0]),
                "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                "-c:a", "aac", "-movflags", "+faststart", str(video_path),
            ])

    info_files = sorted(job_dir.glob("video.info.json"))
    info: dict = {}
    if info_files:
        try:
            info = json.loads(info_files[0].read_text(encoding="utf-8"))
        except Exception:
            info = {}
        try:
            info_files[0].unlink()
        except OSError:
            pass
    source = source_override or sanitize_source_info(info)
    if used_android:
        source["download_note"] = "YouTube 备用线路，画质约 360p"
    return video_path, enrich_social_context(url, source)


def probe_video(video_path: Path, job_dir: Path) -> tuple[dict, float]:
    raw = run_command([
        FFPROBE, "-v", "error", "-show_streams", "-show_format",
        "-of", "json", str(video_path),
    ], timeout=60)
    data = json.loads(raw)
    write_json(job_dir / "video_info.json", data)
    duration = positive_duration((data.get("format") or {}).get("duration"))
    if not duration:
        for stream in data.get("streams") or []:
            if isinstance(stream, dict) and stream.get("codec_type") == "video":
                duration = positive_duration(stream.get("duration"))
                if duration:
                    break
    return data, duration


def positive_duration(value: object) -> float:
    try:
        duration = float(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return duration if math.isfinite(duration) and duration > 0 else 0.0


def capture_screenshots(video_path: Path, job_dir: Path, duration: float) -> list[str]:
    screenshot_dir = job_dir / "screenshots"
    screenshot_dir.mkdir(exist_ok=True)
    screenshots: list[str] = []
    for index, timestamp in enumerate(screenshot_times(duration), start=1):
        output = screenshot_dir / f"frame{index}.jpg"
        run_command([
            FFMPEG, "-y", "-ss", str(timestamp), "-i", str(video_path),
            "-frames:v", "1", "-q:v", "2", str(output),
        ], timeout=120)
        if output.is_file() and output.stat().st_size > 0:
            screenshots.append(str(output.resolve()))
    if len(screenshots) != 3:
        raise RuntimeError("未能截取3张有效封面")
    return screenshots


def prepare(url: str, job_dir: Path) -> None:
    job_dir = job_dir.resolve()
    job_dir.mkdir(parents=True, exist_ok=True)
    update_progress(job_dir, 1, "正在下载视频", 15)
    video_path, source_context = download_video(url, job_dir)
    update_progress(job_dir, 2, "正在读取视频信息", 45)
    probe_data, duration = probe_video(video_path, job_dir)
    if not source_context.get("duration"):
        source_context["duration"] = duration
    update_progress(job_dir, 3, "正在读取原视频评论和简介", 52)
    if not source_context.get("comments"):
        source_context = enrich_social_context(url, source_context)
    update_progress(job_dir, 3, "正在截取封面", 60)
    screenshots = capture_screenshots(video_path, job_dir, duration)
    analysis_frames = capture_analysis_frames(video_path, job_dir, duration)
    transcript = transcribe_video(video_path, has_audio_stream(probe_data))
    transcript_file = job_dir / "transcript.json"
    write_json(job_dir / "visual_timeline.json", {"frames": analysis_frames})
    write_json(transcript_file, transcript)
    write_json(job_dir / "prepare_result.json", {
        "video_file": str(video_path.resolve()),
        "screenshots": screenshots,
        "analysis_frames": analysis_frames,
        "transcript_file": str(transcript_file.resolve()),
        "transcript_status": transcript["status"],
        "has_speech": transcript["has_speech"],
        "source": source_context,
    })
    update_progress(job_dir, 4, "正在生成标题和简介", 72)


def main() -> int:
    parser = argparse.ArgumentParser(description="准备B站投稿视频、信息和封面")
    parser.add_argument("--url", required=True)
    parser.add_argument("--job-dir", required=True)
    args = parser.parse_args()
    job_dir = Path(args.job_dir)
    try:
        prepare(args.url, job_dir)
        return 0
    except Exception as exc:
        try:
            update_progress(job_dir, 0, f"视频准备失败：{exc}", 0)
        except Exception:
            pass
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
