#!/usr/bin/env python3
"""
B站视频投稿脚本 - 直接调B站Web API
用法: python3 bili_upload.py --video video.mp4 --title "标题" --tag "标签1,标签2" --desc "描述" [--cover cover.jpg] [--tid 171]
"""
import argparse
import json
import hashlib
import time
import os
import sys
import struct
import httpx
from pathlib import Path

# Cookie文件
COOKIE_FILE = os.path.expanduser("~/.bili_cookie.json")

def load_cookies():
    with open(COOKIE_FILE) as f:
        return json.load(f)

def get_cover_img_size(cover_path):
    """获取图片文件大小(字节)"""
    return os.path.getsize(cover_path)

def build_upload_params(cookie_info):
    """构建B站投稿基础参数"""
    return {
        "build": "0",
        "mobi_app": "web",
        "device": "Mac",
    }

def upload_video(video_path, title, tags, description, cover_path=None, tid=171, cookie_file=None):
    global COOKIE_FILE
    if cookie_file:
        COOKIE_FILE = cookie_file
    
    cookies = load_cookies()
    sessdata = cookies["sessdata"]
    bili_jct = cookies["bili_jct"]
    dedeuserid = cookies["dedeuserid"]
    
    # buvid3处理
    buvid3 = cookies["buvid3"]
    if isinstance(buvid3, list):
        buvid3 = buvid3[0]
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Referer": "https://member.bilibili.com/platform/upload/video/frame",
    }
    
    client = httpx.Client(
        headers=headers,
        cookies={
            "SESSDATA": sessdata,
            "bili_jct": bili_jct,
            "DEDU userid": dedeuserid,
            "buvid3": buvid3,
            "buvid4": buvid3,
            "b_nut": str(int(time.time())),
        },
        timeout=60,
        follow_redirects=True,
    )
    
    video_path = os.path.expanduser(video_path)
    video_size = os.path.getsize(video_path)
    
    print(f"📹 视频文件: {video_path}")
    print(f"📏 文件大小: {video_size / 1024 / 1024:.1f} MB")
    print(f"🏷️ 标题: {title}")
    print(f"📝 标签: {tags}")
    print(f"📂 分区: {tid}")
    
    # Step 1: 预上传 - 获取上传URL
    print("\n[1/4] 获取上传地址...")
    
    # 计算视频md5和分片信息
    video_md5 = hashlib.md5(open(video_path, 'rb').read()).hexdigest()
    
    pre_resp = client.post(
        "https://member.bilibili.com/preupload",
        params={
            "name": os.path.basename(video_path),
            "size": str(video_size),
            "r": "probe",
            "profile": "ugcfx/bup",
        }
    )
    pre_data = pre_resp.json()
    
    if pre_data.get("code") != 0:
        print(f"❌ 预上传失败: {pre_data}")
        return False
    
    up_url = pre_data["data"]["probe"]["upos"]
    print(f"✅ 上传地址: {up_url[:50]}...")
    
    # Step 2: 上传视频
    print("\n[2/4] 上传视频中...")
    
    chunk_size = 16 * 1024 * 1024  # 16MB chunks
    
    with open(video_path, 'rb') as f:
        chunk_idx = 0
        while True:
            chunk_data = f.read(chunk_size)
            if not chunk_data:
                break
            
            chunk_md5 = hashlib.md5(chunk_data).hexdigest()
            chunk_size_actual = len(chunk_data)
            
            upload_resp = client.put(
                f"{up_url}/blk/{chunk_size_actual}/{chunk_idx}",
                content=chunk_data,
                headers={
                    "Content-Type": "application/octet-stream",
                    "Content-MD5": chunk_md5,
                }
            )
            
            chunk_idx += 1
            progress = min(100, int((chunk_idx * chunk_size / video_size) * 100))
            print(f"   上传进度: {progress}% (分片 {chunk_idx})")
    
    print("✅ 视频上传完成")
    
    # Step 3: 上传封面(如果有)
    cover_url = ""
    if cover_path and os.path.exists(cover_path):
        print("\n[3/4] 上传封面...")
        cover_path = os.path.expanduser(cover_path)
        
        cover_resp = client.post(
            "https://member.bilibili.com/x/vu/web/cover/up",
            data={
                "csrf": bili_jct,
            },
            files={
                "cover": (os.path.basename(cover_path), open(cover_path, 'rb'), "image/jpeg"),
            }
        )
        
        cover_data = cover_resp.json()
        if cover_data.get("code") == 0:
            cover_url = cover_data["data"]["url"]
            print(f"✅ 封面上传成功: {cover_url[:50]}...")
        else:
            print(f"⚠️ 封面上传失败: {cover_data}，继续投稿(无封面)")
    else:
        print("\n[3/4] 跳过封面")
    
    # Step 4: 提交投稿
    print("\n[4/4] 提交投稿...")
    
    # 构建标签列表
    tag_list = [{"name": t.strip()} for t in tags.split(",") if t.strip()]
    if len(tag_list) < 10:
        # 补齐到10个标签
        extra_tags = ["搞笑", "热门", "推荐", "精选", "热门视频", "涨知识", "万物皆可", "挑战", "生活", "日常"]
        for t in extra_tags:
            if len(tag_list) >= 10:
                break
            if not any(x["name"] == t for x in tag_list):
                tag_list.append({"name": t})
    
    # 确保至少10个标签
    while len(tag_list) < 10:
        tag_list.append({"name": f"标签{len(tag_list)+1}"})
    
    submit_resp = client.post(
        "https://member.bilibili.com/x/vu/web/add/v2",
        data={
            "csrf": bili_jct,
            "copyright": "1",
            "source": "",
            "title": title,
            "desc": description,
            "tag": json.dumps(tag_list[:10]),
            "vid": video_md5,
            "tid": str(tid),
            "cover": cover_url,
            "no_reprint": "0",
            "recreate": "1",
            "subtitle": json.dumps({
                "lan": "",
                "open": 0,
            }),
            "web_version": "",
        }
    )
    
    submit_data = submit_resp.json()
    
    if submit_data.get("code") == 0:
        bvid = submit_data["data"].get("bvid", "unknown")
        print(f"\n🎉 投稿成功！")
        print(f"BV号: {bvid}")
        print(f"标题: {title}")
        return bvid
    else:
        print(f"\n❌ 投稿失败: {submit_data}")
        return False

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="B站视频投稿")
    parser.add_argument("--video", required=True, help="视频文件路径")
    parser.add_argument("--title", required=True, help="视频标题")
    parser.add_argument("--tag", required=True, help="标签(逗号分隔)")
    parser.add_argument("--desc", default="", help="视频描述")
    parser.add_argument("--cover", default=None, help="封面图片路径")
    parser.add_argument("--tid", type=int, default=171, help="投稿分区ID")
    parser.add_argument("--cookie", default=None, help="Cookie文件路径")
    args = parser.parse_args()
    
    # 需要杀代理直连B站
    os.environ.pop("http_proxy", None)
    os.environ.pop("https_proxy", None)
    os.environ.pop("HTTP_PROXY", None)
    os.environ.pop("HTTPS_PROXY", None)
    os.environ.pop("ALL_PROXY", None)
    os.environ.pop("all_proxy", None)
    
    result = upload_video(
        video_path=args.video,
        title=args.title,
        tags=args.tag,
        description=args.desc,
        cover_path=args.cover,
        tid=args.tid,
        cookie_file=args.cookie,
    )
    
    if result:
        print(f"\nBV:{result}")
        sys.exit(0)
    else:
        sys.exit(1)
