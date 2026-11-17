#!/usr/bin/env python3
"""
B站视频投稿脚本v2 - 适配2025新上传协议(ugcupos/bup)
用法: python3 bili_upload_v2.py --video video.mp4 --title "标题" --tag "标签1,标签2" --desc "描述" [--cover cover.jpg] [--tid 171]
"""
import argparse
import json
import hashlib
import math
import os
import re
import sys
import time
import httpx


def parse_tid(value):
    try:
        tid = int(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError("分区ID必须是整数") from exc
    if tid < 1 or tid > 9999:
        raise argparse.ArgumentTypeError("分区ID必须是1到9999之间的整数")
    return tid


def load_cookies(path="~/.bili_cookie.json"):
    if path is None:
        path = "~/.bili_cookie.json"
    expanded_path = os.path.expanduser(path)
    if not os.path.isfile(expanded_path):
        raise FileNotFoundError(f"Cookie文件不存在: {expanded_path}")
    # Cookie等同于账号凭证，禁止同组或其他用户读取。
    if os.name == "posix" and os.stat(expanded_path).st_mode & 0o077:
        os.chmod(expanded_path, 0o600)
    with open(expanded_path, encoding="utf-8") as f:
        cookies = json.load(f)
    required = {"sessdata", "bili_jct", "buvid3"}
    missing = sorted(required - cookies.keys())
    if missing:
        raise ValueError(f"Cookie文件缺少字段: {', '.join(missing)}")
    return cookies


def probe_lines(client):
    """Step 1: Probe available upload lines"""
    resp = client.get("https://member.bilibili.com/preupload", params={"r": "probe"})
    resp.raise_for_status()
    return resp.json()


def preupload(client, video_name, video_size, line_query):
    """Step 2: Preupload - get upload credentials"""
    query = {
        "r": "upos",
        "profile": "ugcupos/bup",
        "ssl": 0,
        "version": "2.8.12",
        "build": 2081200,
        "name": video_name,
        "size": video_size,
    }
    resp = client.get(
        f"https://member.bilibili.com/preupload?{line_query}",
        params=query,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("OK") != 1:
        raise Exception(f"Preupload failed: {data}")
    return data


def upload_upos(client, video_path, ret):
    """Step 3: Upload video via UPOS protocol"""
    auth = ret["auth"]
    endpoint = ret["endpoint"]
    biz_id = ret["biz_id"]
    upos_uri = ret["upos_uri"]
    chunk_size = ret["chunk_size"]

    # Override endpoint to bda2 CDN
    endpoint = re.sub(r"upcdn(bda2|ws|qn)", "upcdnbda2", endpoint)

    url = f"https:{endpoint}/{upos_uri.replace('upos://', '')}"
    headers = {
        "X-Upos-Auth": auth,
    }

    video_size = os.path.getsize(video_path)
    total_chunks = math.ceil(video_size / chunk_size)

    print(f"  上传地址: {url[:60]}...")
    print(f"  分片数: {total_chunks}, 分片大小: {chunk_size // 1024 // 1024}MB")

    # Step 3a: Initiate multipart upload
    print("  初始化上传...")
    init_resp = client.post(f"{url}?uploads&output=json", headers=headers, timeout=15)
    init_resp.raise_for_status()
    init_data = init_resp.json()
    upload_id = init_data.get("upload_id")
    if not upload_id:
        raise Exception(f"Failed to get upload_id: {init_data}")
    print(f"  upload_id: {upload_id[:20]}...")

    # Step 3b: Upload chunks
    parts = []
    start_time = time.time()
    with open(video_path, "rb") as f:
        for i in range(total_chunks):
            chunk_data = f.read(chunk_size)
            if not chunk_data:
                break
            chunk_size_actual = len(chunk_data)

            chunk_resp = None
            for chunk_attempt in range(1, 4):
                try:
                    chunk_resp = client.put(
                        url,
                        params={
                            "partNumber": i + 1,
                            "uploadId": upload_id,
                            "chunk_size": chunk_size_actual,
                            "size": chunk_size_actual,
                            "start": i * chunk_size,
                            "end": i * chunk_size + chunk_size_actual,
                        },
                        content=chunk_data,
                        headers=headers,
                        timeout=300,
                    )
                    if chunk_resp.status_code in (200, 201, 202, 204):
                        break
                except httpx.HTTPError:
                    chunk_resp = None
                if chunk_attempt < 3:
                    print(f"  分片 {i + 1} 上传失败，重试 {chunk_attempt}/3...")
                    time.sleep(2 * chunk_attempt)
            if chunk_resp is None or chunk_resp.status_code not in (200, 201, 202, 204):
                status = chunk_resp.status_code if chunk_resp is not None else "network"
                body = chunk_resp.text[:300] if chunk_resp is not None else ""
                raise Exception(f"Chunk {i} failed after retries: status={status}, body={body}")

            parts.append({"partNumber": i + 1, "eTag": "etag"})
            progress = int(((i + 1) / total_chunks) * 100)
            elapsed = time.time() - start_time
            speed = (video_size / elapsed / 1024 / 1024) if elapsed > 0 else 0
            print(f"  [{progress}%] 分片 {i + 1}/{total_chunks} ({chunk_size_actual // 1024 // 1024}MB) {speed:.1f}MB/s")

    # Step 3c: Complete multipart upload
    print("  合并分片...")
    filename = os.path.basename(video_path)
    bili_filename = os.path.splitext(os.path.basename(upos_uri))[0]
    last_error = None
    for attempt in range(1, 6):
        try:
            complete_resp = client.post(
                url,
                params={
                    "name": filename,
                    "uploadId": upload_id,
                    "biz_id": biz_id,
                    "output": "json",
                    "profile": "ugcupos/bup",
                },
                json={"parts": parts},
                headers=headers,
                timeout=15,
            )
            complete_resp.raise_for_status()
            complete_data = complete_resp.json()
            if complete_data.get("OK") == 1:
                elapsed = time.time() - start_time
                print(f"  ✅ 上传完成 ({video_size / 1024 / 1024:.1f}MB, {elapsed:.1f}s)")
                video_title = os.path.splitext(filename)[0]
                return {
                    "title": video_title,
                    "filename": bili_filename,
                    "desc": "",
                }
            raise IOError(f"Complete failed: {complete_data}")
        except (IOError, httpx.HTTPError, ValueError) as exc:
            last_error = exc
            if attempt < 5:
                print(f"  合并失败，重试 {attempt}/5...")
                time.sleep(5)

    raise Exception(f"合并分片失败，超过最大重试次数: {last_error}")
def upload_cover(client, cover_path, bili_jct):
    """Step 4: Upload cover image (base64 data URL format)"""
    if not cover_path or not os.path.exists(cover_path):
        print("  跳过封面")
        return ""

    import base64
    from PIL import Image
    from io import BytesIO

    # Resize to 16:10 aspect ratio
    with Image.open(cover_path) as im:
        xsize, ysize = im.size
        if xsize / ysize > 1.6:
            delta = xsize - ysize * 1.6
            region = im.crop((delta / 2, 0, xsize - delta / 2, ysize))
        else:
            delta = ysize - xsize * 10 / 16
            region = im.crop((0, delta / 2, xsize, ysize - delta / 2))
        buffered = BytesIO()
        region.save(buffered, format=im.format or "JPEG")
        img_data = base64.b64encode(buffered.getvalue())
    buffered.close()

    cover_resp = client.post(
        "https://member.bilibili.com/x/vu/web/cover/up",
        data={
            "cover": f"data:image/jpeg;base64,{img_data.decode()}",
            "csrf": bili_jct,
        },
        timeout=30,
    )
    cover_resp.raise_for_status()
    try:
        cover_data = cover_resp.json()
    except Exception:
        print(f"  ⚠️ 封面响应解析失败: status={cover_resp.status_code}, body={cover_resp.text[:200]}")
        return ""

    if cover_data.get("code") == 0 and cover_data.get("data"):
        url = cover_data["data"]["url"]
        print(f"  ✅ 封面: {url[:50]}...")
        return url
    else:
        print(f"  ⚠️ 封面失败: {cover_data}")
        return ""


def submit_video(client, title, tags, description, cover_url, tid, bili_jct, video_info=None, topic_id=None, mission_id=None, draft=False):
    """Step 5: Submit the video metadata (JSON body) — v3 API
    
    video_info can be:
    - None: no videos
    - dict: single video (legacy)
    - list[dict]: multiple videos (multi-P)
    """
    tag_list = [{"name": t.strip()} for t in tags.split(",") if t.strip()]
    # 活动topic占用1个标签位，所以用户标签最多9个
    max_tags = 9 if topic_id else 10
    if len(tag_list) < max_tags:
        extras = ["搞笑", "热门", "推荐", "精选", "涨知识", "万物皆可", "挑战", "生活", "日常", "热门视频"]
        for t in extras:
            if len(tag_list) >= max_tags:
                break
            if not any(x["name"] == t for x in tag_list):
                tag_list.append({"name": t})
    while len(tag_list) < max_tags:
        tag_list.append({"name": f"标签{len(tag_list) + 1}"})

    # Normalize video_info to list
    if video_info is None:
        videos_list = []
    elif isinstance(video_info, list):
        videos_list = video_info
    else:
        videos_list = [video_info]

    # B站v3提交格式: /x/vu/web/add/v3
    payload = {
        "videos": videos_list,
        "cover": cover_url.replace("http:", "") if cover_url else "",
        "cover43": "",
        "title": title[:80],
        "copyright": 1,
        "tid": tid,
        "tag": ",".join([t["name"] for t in tag_list[:10]]),
        "desc_format_id": 9999,
        "desc": description,
        "desc_v2": [{"raw_text": description, "biz_id": "", "type": 1}],
        "recreate": -1,
        "dynamic": "",
        "interactive": 0,
        "act_reserve_create": 0,
        "no_disturbance": 0,
        "no_reprint": 1,
        "subtitle": {"open": 0, "lan": ""},
        "dolby": 0,
        "lossless_music": 0,
        "up_selection_reply": False,
        "up_close_reply": False,
        "up_close_danmu": False,
        "web_os": 3,
    }

    # 草稿模式: readystate=0(草稿), 默认不传(=直接投稿)
    if draft:
        payload["readystate"] = 0
        print("📝 草稿模式: 保存后需手动发布")

    # 🔴 活动关联 — v3 API顶层字段 topic_id + mission_id
    if topic_id:
        payload["topic_id"] = int(topic_id)
        payload["topic_detail"] = {
            "from_topic_id": int(topic_id),
            "from_source": "arc.web.recommend",
        }
    if mission_id:
        payload["mission_id"] = int(mission_id)
    if topic_id or mission_id:
        print(f"🎁 参加活动: topic_id={topic_id}, mission_id={mission_id}")

    submit_resp = client.post(
        f"https://member.bilibili.com/x/vu/web/add/v3?csrf={bili_jct}",
        json=payload,
        timeout=30,
    )
    submit_resp.raise_for_status()
    try:
        return submit_resp.json()
    except Exception:
        raise Exception(f"Submit response parse error: status={submit_resp.status_code}, body={submit_resp.text[:500]}")


def upload_single_video(client, video_path, line_query, part_label=""):
    """Upload a single video file via UPOS protocol. Returns video_info dict."""
    video_path = os.path.expanduser(video_path)
    video_size = os.path.getsize(video_path)
    label = f"P{part_label}" if part_label else os.path.basename(video_path)
    
    print(f"\n📹 上传 {label}: {os.path.basename(video_path)}")
    print(f"📏 大小: {video_size / 1024 / 1024:.1f} MB")

    # Preupload
    ret = preupload(client, os.path.basename(video_path), video_size, line_query)
    print(f"  biz_id={ret['biz_id']}, chunk_size={ret['chunk_size'] // 1024 // 1024}MB")

    # Upload via UPOS
    video_info = upload_upos(client, video_path, ret)
    # Override title with part label if multi-P
    if part_label:
        video_info["title"] = f"P{part_label}"
    return video_info


def upload_video(video_path, title, tags, description, cover_path=None, tid=171, cookie_file=None, topic_id=None, mission_id=None, draft=False, video_paths=None):
    """Upload video(s) to Bilibili.
    
    For multi-P upload, pass video_paths as a list of file paths.
    For single video, pass video_path as before (backward compatible).
    """
    # Kill proxy
    for k in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"]:
        os.environ.pop(k, None)

    cookies = load_cookies(cookie_file)
    buvid3 = cookies["buvid3"]
    if isinstance(buvid3, list):
        buvid3 = buvid3[0]

    # Determine video list
    if video_paths and len(video_paths) > 0:
        # Multi-P mode
        all_paths = [os.path.expanduser(p) for p in video_paths]
        is_multi = len(all_paths) > 1
    else:
        # Single video mode (backward compatible)
        if not video_path:
            raise ValueError("单视频模式缺少--video参数")
        all_paths = [os.path.expanduser(video_path)]
        is_multi = False

    missing_paths = [path for path in all_paths if not os.path.isfile(path)]
    if missing_paths:
        raise FileNotFoundError(f"视频文件不存在: {', '.join(missing_paths)}")
    if len(set(map(os.path.realpath, all_paths))) != len(all_paths):
        raise ValueError("多P视频列表包含重复文件")

    total_size = sum(os.path.getsize(p) for p in all_paths)
    print(f"🏷️ 标题: {title}")
    print(f"🏷️ 标签: {tags}")
    print(f"📂 分区: {tid}")
    print(f"📹 视频: {'多P(' + str(len(all_paths)) + '个)' if is_multi else os.path.basename(all_paths[0])}")
    print(f"📏 总大小: {total_size / 1024 / 1024:.1f} MB")

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Referer": "https://member.bilibili.com/platform/upload/video/frame",
    }

    client = httpx.Client(
        headers=headers,
        cookies={
            "SESSDATA": cookies["sessdata"],
            "bili_jct": cookies["bili_jct"],
            "buvid3": buvid3,
            "b_nut": str(int(time.time())),
        },
        timeout=120,
        follow_redirects=True,
    )

    # Step 1: Probe
    print("\n[1/5] 获取上传线路...")
    probe = probe_lines(client)
    if "lines" not in probe:
        raise Exception(f"Probe failed: {probe}")
    line = None
    for l in probe["lines"]:
        if "bda2" in l.get("query", ""):
            line = l
            break
    if not line:
        line = probe["lines"][0]
    print(f"  线路: {line['query'][:40]}")

    # Step 2-3: Upload all video parts
    video_infos = []
    for i, vp in enumerate(all_paths):
        part_label = str(i + 1) if is_multi else ""
        print(f"\n[{i+1}/{len(all_paths)}] 上传视频{'P' + str(i+1) if is_multi else ''}...")
        vi = upload_single_video(client, vp, line["query"], part_label)
        video_infos.append(vi)

    # Step 4: Upload cover
    print("\n[4/5] 上传封面...")
    cover_url = upload_cover(client, cover_path, cookies["bili_jct"])

    # Step 5: Submit
    print("\n[5/5] 提交投稿...")
    # Pass list for multi-P, single dict for single video
    video_info_arg = video_infos if is_multi else (video_infos[0] if video_infos else None)
    result = submit_video(
        client, title, tags, description, cover_url, tid, cookies["bili_jct"], video_info_arg, topic_id, mission_id, draft
    )

    if result.get("code") == 0:
        bvid = result["data"].get("bvid", "unknown")
        aid = result["data"].get("aid", "unknown")
        if draft:
            print(f"\n📝 草稿保存成功!")
            print(f"AID: {aid}")
            print(f"请到B站创作中心手动发布")
            print(f"AID:{aid}")
            return aid
        else:
            print(f"\n🎉 投稿成功!")
            print(f"BV号: {bvid}")
            print(f"标题: {title}")
            print(f"BV:{bvid}")
            return bvid
    else:
        print(f"\n❌ 投稿失败: {json.dumps(result, indent=2, ensure_ascii=False)}")
        return False


SOURCE_LINE = re.compile(
    r"https?://|x\.com|twitter\.com|原片发在|作者\s*@|@[A-Za-z0-9_.\-]+|^曲子是\s",
    re.I,
)


def strip_source(desc):
    """简介只留画面。去掉作者、外链、平台和配乐署名。"""
    kept = []
    for line in (desc or "").splitlines():
        if SOURCE_LINE.search(line.strip()):
            continue
        if line.strip():
            kept.append(line.rstrip())
    return "\n".join(kept).strip()


def member_client(cookie_file=None):
    for key in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"]:
        os.environ.pop(key, None)
    cookies = load_cookies(cookie_file)
    buvid3 = cookies["buvid3"]
    if isinstance(buvid3, list):
        buvid3 = buvid3[0]
    client = httpx.Client(
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": "https://member.bilibili.com/platform/upload-manager/article",
        },
        cookies={
            "SESSDATA": cookies["sessdata"],
            "bili_jct": cookies["bili_jct"],
            "buvid3": buvid3,
            "b_nut": str(int(time.time())),
        },
        timeout=30,
        follow_redirects=True,
    )
    return client, cookies["bili_jct"]


def redact(text):
    text = re.sub(r"(SESSDATA|bili_jct|csrf|DedeUserID)=[^&\s\"']+", r"\1=***", text or "", flags=re.I)
    return text[:500]


def view_archive(client, bvid):
    resp = client.get(
        "https://member.bilibili.com/x/vupre/web/archive/view",
        params={"bvid": bvid},
    )
    if resp.status_code != 200:
        raise Exception(f"读取稿件失败 {bvid}: http {resp.status_code}")
    body = resp.json()
    if body.get("code") != 0:
        raise Exception(f"读取稿件失败 {bvid}: code={body.get('code')} message={body.get('message')}")
    return body["data"]


def recent_bvids(client):
    found = []
    for status in ("pubed", "is_pubbing"):
        resp = client.get(
            "https://member.bilibili.com/x/web/archives",
            params={"status": status, "pn": 1, "ps": 20, "coop": 1, "interactive": 1},
        )
        body = resp.json()
        if body.get("code") != 0:
            print(f"列表 {status}: code={body.get('code')} message={body.get('message')}")
            continue
        for item in body.get("data", {}).get("arc_audits") or []:
            arc = item.get("Archive") or item.get("archive") or {}
            bvid = arc.get("bvid")
            if bvid and bvid not in found:
                found.append(bvid)
    return found


def edit_description(client, bili_jct, bvid, new_desc, data, new_title=None, new_tag=None):
    archive = data.get("archive") or data
    old_title = archive.get("title") or ""
    videos = []
    for video in data.get("videos") or []:
        part_title = video.get("title") or old_title
        if new_title and part_title == old_title:
            part_title = new_title
        videos.append({
            "filename": video.get("filename") or "",
            "title": part_title,
            "desc": video.get("desc") or "",
            "cid": int(video["cid"]),
        })
    cover = archive.get("cover") or ""
    cover = re.sub(r"^https?:", "", cover)
    payload = {
        "aid": int(archive["aid"]),
        "copyright": int(archive.get("copyright") or 1),
        "videos": videos,
        "tid": int(archive.get("tid") or 0),
        "cover": cover,
        "title": new_title or old_title,
        "tag": new_tag if new_tag else (archive.get("tag") or ""),
        "desc_format_id": 9999,
        "desc": new_desc,
        "desc_v2": [{"raw_text": new_desc, "biz_id": "", "type": 1}],
        "recreate": -1,
        "dynamic": archive.get("dynamic") or "",
        "interactive": 0,
        "no_reprint": 1 if archive.get("no_reprint") in (None, "") else int(archive.get("no_reprint")),
        "subtitle": {"open": 0, "lan": ""},
        "web_os": 1,
        "new_web_edit": 1,
        "csrf": bili_jct,
    }
    for key in ("topic_id", "mission_id"):
        value = archive.get(key) or data.get(key)
        if value:
            payload[key] = int(value)
    resp = client.post(
        "https://member.bilibili.com/x/vu/web/edit",
        params={"csrf": bili_jct, "t": int(time.time() * 1000)},
        json=payload,
    )
    try:
        result = resp.json()
    except Exception:
        raise Exception(f"编辑响应无法解析: status={resp.status_code} body={redact(resp.text)}")
    if result.get("code") != 0:
        raise Exception(f"编辑失败 {bvid}: code={result.get('code')} message={result.get('message')} body={redact(json.dumps(result, ensure_ascii=False))}")
    return view_archive(client, bvid)


def show_archive(data):
    archive = data.get("archive") or data
    fields = {
        key: archive.get(key)
        for key in archive
        if re.search(r"tid|topic|mission|copyright|human|type", key, re.I)
    }
    print(f"BV:{archive.get('bvid')}")
    print(f"标题:{archive.get('title')}")
    print(f"标签:{archive.get('tag')}")
    print(f"分区字段:{json.dumps(fields, ensure_ascii=False)}")
    videos = data.get("videos") or []
    print(f"分P:{len(videos)} 有文件名:{bool(videos and videos[0].get('filename'))}")
    print("简介:")
    print(archive.get("desc") or "")


def run_desc_edit(bvids, new_desc, cookie_file, apply, new_title=None, new_tag=None):
    client, bili_jct = member_client(cookie_file)
    targets = recent_bvids(client) if bvids == ["recent"] else bvids
    if not targets:
        print("没有读到稿件")
        return False
    changed = False
    named = bvids != ["recent"]
    for bvid in targets:
        data = view_archive(client, bvid)
        archive = data.get("archive") or data
        old = archive.get("desc") or ""
        explicit = named and (new_desc is not None or new_title or new_tag)
        proposed = new_desc if new_desc is not None and named else strip_source(old)
        print("---")
        show_archive(data)
        same_desc = proposed.strip() == old.strip()
        same_title = not new_title or new_title == (archive.get("title") or "")
        same_tag = not new_tag or new_tag == (archive.get("tag") or "")
        if not explicit and not SOURCE_LINE.search(old):
            print("简介不用改")
            continue
        if same_desc and same_title and same_tag:
            print("简介不用改")
            continue
        time.sleep(1.2)
        if new_title:
            print(f"标题改成:{new_title}")
        if new_tag:
            print(f"标签改成:{new_tag}")
        print("改成:")
        print(proposed)
        changed = True
        if not apply:
            continue
        time.sleep(1.5)
        updated = edit_description(client, bili_jct, bvid, proposed, data, new_title, new_tag)
        updated_archive = updated.get("archive") or updated
        print(f"已改 {bvid} code=0")
        print("现简介:")
        print(updated_archive.get("desc") or "")
        print(f"活动仍是:{updated_archive.get('topic_id')}/{updated_archive.get('mission_id')}")
    if not apply and changed:
        print("未提交。确认后加 --apply")
    return True


def replace_archive_video(bvid, video_path, cookie_file):
    """把已发布稿件的视频换成新文件，标题、简介、标签和活动不动。"""
    video_path = os.path.expanduser(video_path)
    if not os.path.isfile(video_path):
        raise FileNotFoundError(video_path)
    client, bili_jct = member_client(cookie_file)
    data = view_archive(client, bvid)
    archive = data.get("archive") or data
    show_archive(data)
    print("\n[1/3] 获取上传线路...")
    probe = probe_lines(client)
    if "lines" not in probe:
        raise Exception(f"Probe failed: {probe}")
    line = None
    for item in probe["lines"]:
        if "bda2" in item.get("query", ""):
            line = item
            break
    if not line:
        line = probe["lines"][0]
    print(f"  线路: {line['query'][:40]}")
    print("\n[2/3] 上传新视频...")
    ret = preupload(client, os.path.basename(video_path), os.path.getsize(video_path), line["query"])
    info = upload_upos(client, video_path, ret)
    new_cid = int(ret["biz_id"])
    print(f"  新文件:{info['filename']} cid:{new_cid}")
    old_desc = archive.get("desc") or ""
    cover = re.sub(r"^https?:", "", archive.get("cover") or "")
    payload = {
        "aid": int(archive["aid"]),
        "copyright": int(archive.get("copyright") or 1),
        "videos": [{
            "filename": info["filename"],
            "title": archive.get("title") or "",
            "desc": "",
            "cid": new_cid,
        }],
        "tid": int(archive.get("tid") or 0),
        "cover": cover,
        "title": archive.get("title") or "",
        "tag": archive.get("tag") or "",
        "desc_format_id": 9999,
        "desc": old_desc,
        "desc_v2": [{"raw_text": old_desc, "biz_id": "", "type": 1}],
        "recreate": -1,
        "dynamic": archive.get("dynamic") or "",
        "interactive": 0,
        "no_reprint": 1 if archive.get("no_reprint") in (None, "") else int(archive.get("no_reprint")),
        "subtitle": {"open": 0, "lan": ""},
        "web_os": 1,
        "new_web_edit": 1,
        "csrf": bili_jct,
    }
    for key in ("topic_id", "mission_id"):
        value = archive.get(key) or data.get(key)
        if value:
            payload[key] = int(value)
    print("\n[3/3] 换片...")
    resp = client.post(
        "https://member.bilibili.com/x/vu/web/edit",
        params={"csrf": bili_jct, "t": int(time.time() * 1000)},
        json=payload,
    )
    try:
        result = resp.json()
    except Exception:
        raise Exception(f"换片响应无法解析: status={resp.status_code} body={redact(resp.text)}")
    if result.get("code") != 0:
        raise Exception(f"换片失败 {bvid}: code={result.get('code')} message={result.get('message')} body={redact(json.dumps(result, ensure_ascii=False))}")
    updated = view_archive(client, bvid)
    updated_archive = updated.get("archive") or updated
    print(f"已换片 {bvid} code=0")
    print(f"标题:{updated_archive.get('title')}")
    print(f"活动仍是:{updated_archive.get('topic_id')}/{updated_archive.get('mission_id')}")
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="B站视频投稿v2")
    video_group = parser.add_mutually_exclusive_group(required=False)
    video_group.add_argument("--video", help="视频文件路径（单视频模式）")
    video_group.add_argument("--videos", nargs="+", help="多P视频文件路径列表")
    parser.add_argument("--edit-bvid", action="append", default=None, help="只改这条稿件的简介。可重复。写 recent 时扫最近稿件")
    parser.add_argument("--apply", action="store_true", help="配合 --edit-bvid，提交简介修改")
    parser.add_argument("--title", default=None, help="视频标题")
    parser.add_argument("--tag", default=None, help="标签(逗号分隔)")
    parser.add_argument("--desc", default=None, help="视频描述。编辑时不写就自动删掉作者和外链")
    parser.add_argument("--cover", default=None, help="封面图片路径")
    parser.add_argument("--tid", type=parse_tid, default=None, help="投稿分区ID")
    parser.add_argument("--cookie", default=None, help="Cookie文件路径")
    parser.add_argument("--topic", default=None, help="活动topic_id")
    parser.add_argument("--mission", default=None, help="活动mission_id")
    parser.add_argument("--draft", action="store_true", help="保存为草稿(不直接投稿)")
    parser.add_argument("--replace-video", default=None, help="配合一个 --edit-bvid，只换视频文件")
    args = parser.parse_args()

    if args.replace_video:
        if not args.edit_bvid or len(args.edit_bvid) != 1:
            print("换片需要正好一个 --edit-bvid")
            sys.exit(1)
        ok = replace_archive_video(args.edit_bvid[0], args.replace_video, args.cookie)
        sys.exit(0 if ok else 1)

    if args.edit_bvid:
        ok = run_desc_edit(args.edit_bvid, args.desc, args.cookie, args.apply, args.title, args.tag)
        sys.exit(0 if ok else 1)

    if not (args.video or args.videos):
        parser.error("投稿需要 --video 或 --videos；改简介用 --edit-bvid")
    if not args.title or not args.tag or args.tid is None:
        parser.error("投稿需要 --title --tag --tid")

    topic_id = args.topic if args.topic else None
    mission_id = args.mission if args.mission else None

    result = upload_video(
        video_path=args.video,
        title=args.title,
        tags=args.tag,
        description=args.desc or "",
        cover_path=args.cover,
        tid=args.tid,
        cookie_file=args.cookie,
        topic_id=topic_id,
        mission_id=mission_id,
        draft=args.draft,
        video_paths=args.videos,
    )

    sys.exit(0 if result else 1)
