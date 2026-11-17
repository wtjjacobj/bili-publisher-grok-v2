import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from bili_upload_v2 import load_cookies, submit_video


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "bili_upload_v2.py"


class UploadCliTests(unittest.TestCase):
    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_multi_part_mode_does_not_require_video_flag(self) -> None:
        result = self.run_cli(
            "--videos",
            "/definitely/missing-p1.mp4",
            "/definitely/missing-p2.mp4",
            "--title",
            "test",
            "--tag",
            "test",
            "--tid",
            "188",
        )
        self.assertNotIn("the following arguments are required: --video", result.stderr)

    def test_video_and_videos_are_mutually_exclusive(self) -> None:
        result = self.run_cli(
            "--video",
            "/definitely/missing.mp4",
            "--videos",
            "/definitely/missing-p1.mp4",
            "--title",
            "test",
            "--tag",
            "test",
            "--tid",
            "188",
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("not allowed with argument", result.stderr)

    def test_tid_is_required(self) -> None:
        result = self.run_cli("--video", "/missing.mp4", "--title", "test", "--tag", "test")
        self.assertEqual(result.returncode, 2)
        self.assertIn("--tid", result.stderr)

    def test_tid_must_be_in_valid_range(self) -> None:
        result = self.run_cli("--video", "/missing.mp4", "--title", "test", "--tag", "test", "--tid", "0")
        self.assertEqual(result.returncode, 2)
        self.assertIn("1到9999", result.stderr)

    def test_cookie_file_requires_upload_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cookie_path = Path(directory) / "cookies.json"
            cookie_path.write_text('{"sessdata":"only-one-key"}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "缺少字段"):
                load_cookies(str(cookie_path))

    def test_activity_submission_includes_topic_detail(self) -> None:
        class Response:
            def raise_for_status(self) -> None:
                return None

            def json(self) -> dict:
                return {"code": 0, "data": {"aid": 123}}

        class Client:
            submitted_json = None

            def post(self, _url: str, *, json: dict, timeout: int) -> Response:
                self.submitted_json = json
                return Response()

        client = Client()
        submit_video(
            client=client,
            title="测试标题",
            tags="标签一,标签二",
            description="测试简介",
            cover_url="",
            tid=130,
            bili_jct="csrf-token",
            video_info={"title": "P1", "filename": "uploaded-file", "desc": ""},
            topic_id=1343077,
            mission_id=4067894,
            draft=True,
        )

        self.assertEqual(
            client.submitted_json.get("topic_detail"),
            {"from_topic_id": 1343077, "from_source": "arc.web.recommend"},
        )


if __name__ == "__main__":
    unittest.main()
