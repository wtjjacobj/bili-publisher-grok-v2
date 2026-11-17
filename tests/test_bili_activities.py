import unittest

from bili_activities import format_activities


class ActivityFormattingTests(unittest.TestCase):
    def test_formats_frontend_fields_and_sorts_by_popularity(self) -> None:
        topics = [
            {"topic_id": 1, "topic_name": "普通话题", "activity_text": "", "arc_play_vv": 999},
            {"topic_id": 2, "topic_name": "活动A", "activity_text": "有奖活动", "activity_description": "奖品A", "mission_id": 20, "arc_play_vv": 10},
            {"topic_id": 3, "topic_name": "活动B", "activity_text": "有奖活动", "activity_description": "奖品B", "mission_id": 30, "arc_play_vv": 100},
        ]
        result = format_activities(topics)
        self.assertEqual([activity["name"] for activity in result], ["活动B", "活动A"])
        self.assertEqual(result[0]["reward"], "奖品B")
        self.assertEqual(result[0]["mission_id"], 30)


if __name__ == "__main__":
    unittest.main()

