#!/usr/bin/env python3
"""
查询B站分区可参加的投稿活动(topic)。
使用bilibili-api-python库（已处理WBI签名等认证问题）。
输出JSON到stdout，供server.ts调用。
"""
import json
import sys
import asyncio
from bilibili_api import Credential, video_uploader
from bili_upload_v2 import load_cookies


def format_activities(topics):
    rewarded = [topic for topic in topics if topic.get("activity_text") == "有奖活动"]
    rewarded.sort(key=lambda topic: topic.get("arc_play_vv", 0), reverse=True)
    result = []
    for topic in rewarded[:20]:
        name = topic.get("topic_name") or "未命名活动"
        description = (topic.get("description") or "")[:200]
        reward = topic.get("activity_description") or ""
        result.append({
            "name": name,
            "topic_id": topic.get("topic_id"),
            "mission_id": topic.get("mission_id"),
            "description": description,
            "threshold": description,
            "reward": reward,
            "recommended": True,
            "arc_play_vv": topic.get("arc_play_vv", 0),
        })
    return result

def main():
    if len(sys.argv) < 2:
        raise SystemExit("用法: bili_activities.py <tid> [cookie_file]")
    tid = int(sys.argv[1])
    if tid < 1 or tid > 9999:
        raise ValueError("tid必须是1到9999之间的整数")
    cookie_path = sys.argv[2] if len(sys.argv) > 2 else "/Users/wangtangjie/.bili_cookie.json"
    c = load_cookies(cookie_path)
    
    sd = c.get('sessdata', '')
    if isinstance(sd, list): sd = sd[0]
    bj = c.get('bili_jct', '')
    if isinstance(bj, list): bj = bj[0]
    buvid3 = c.get('buvid3', '')
    if isinstance(buvid3, list): buvid3 = buvid3[0]
    
    credential = Credential(sessdata=sd, bili_jct=bj, buvid3=buvid3)
    
    async def get_activities():
        topics = await video_uploader.get_available_topics(tid=tid, credential=credential)
        
        return format_activities(topics)
    
    result = asyncio.run(get_activities())
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
