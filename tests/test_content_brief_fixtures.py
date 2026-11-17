import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "tests" / "fixtures" / "content_briefs"


class ContentBriefFixtureSchemaTests(unittest.TestCase):
    def test_every_regression_fixture_matches_the_current_content_brief_schema(self):
        schema = json.loads((ROOT / "content_brief_schema.json").read_text())
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema)
        expected = {
            "mongolia-rave.json",
            "source-account-not-work.json",
            "star-wars-wedding.json",
            "no-subtitle.json",
        }
        fixtures = sorted(FIXTURE_DIR.glob("*.json"))
        self.assertTrue(expected.issubset({path.name for path in fixtures}))
        for path in fixtures:
            with self.subTest(fixture=path.name):
                value = json.loads(path.read_text())
                validator.validate(value)

    def test_star_wars_fixture_links_frame_05_to_the_visible_balcony_action(self):
        fixture = json.loads((FIXTURE_DIR / "star-wars-wedding.json").read_text())
        frame_05 = next(item for item in fixture["timeline"] if item["time"] == 15.621)
        evidence_05 = next(item for item in fixture["evidence"] if item["id"] == "frame-05")

        self.assertEqual(frame_05["summary_zh"], "阳台上的男子手持或举起一台黑色收录机")
        self.assertEqual(frame_05["evidence_ids"], ["frame-05"])
        self.assertEqual(evidence_05["summary_zh"], "阳台上的男子手持或举起黑色收录机")
        self.assertEqual(fixture["core_event"], "花园婚礼镜头切到阳台上举着收录机的男子")
        self.assertEqual(fixture["core_event_evidence_ids"], ["frame-05", "frame-08", "frame-10"])
        self.assertEqual(fixture["turning_point"], "镜头从花园婚礼场景切到阳台上举着收录机的男子")
        self.assertEqual(fixture["turning_point_evidence_ids"], ["frame-03", "frame-05"])
        unsupported_guest_action = json.dumps(fixture, ensure_ascii=False)
        self.assertNotIn("宾客抬头", unsupported_guest_action)
        self.assertNotIn("宾客转头", unsupported_guest_action)


if __name__ == "__main__":
    unittest.main()
