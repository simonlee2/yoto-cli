import json
import os
import pathlib
import py_compile
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]


class YotoCliPackagingTests(unittest.TestCase):
    def test_pyproject_exposes_agent_commands(self):
        text = (ROOT / "pyproject.toml").read_text()
        self.assertRegex(text, r'(?m)^name\s*=\s*"yoto-cli"')
        for command, target in {
            "yoto-cli": "scripts.yoto_cli:main",
            "yoto-upload-manifest": "scripts.upload_audio_manifest:main",
            "yoto-apply-icons": "scripts.apply_icon_manifest:main",
            "yoto-validate-icon": "scripts.validate_yoto_icon:main",
        }.items():
            self.assertIn(f'{command} = "{target}"', text)

    def test_repository_skill_is_discoverable(self):
        skill = ROOT / ".agents" / "skills" / "yoto" / "SKILL.md"
        self.assertTrue(skill.is_file())
        text = skill.read_text()
        self.assertRegex(text, r"(?m)^name: yoto$")
        self.assertRegex(text, r"(?m)^description: .+Yoto")
        self.assertFalse((ROOT / "references" / "yoto-media-workflows.SKILL.md").exists())
        for reference in ["authentication.md", "cards-and-audio.md", "icons.md", "media-import.md"]:
            self.assertTrue((skill.parent / "references" / reference).is_file())

    def test_cli_modules_compile_and_import_as_package(self):
        for rel in [
            "scripts/__init__.py",
            "scripts/yoto_cli.py",
            "scripts/apply_icon_manifest.py",
            "scripts/upload_audio_manifest.py",
            "scripts/validate_yoto_icon.py",
        ]:
            path = ROOT / rel
            self.assertTrue(path.exists(), rel)
            py_compile.compile(str(path), doraise=True)

        sys.path.insert(0, str(ROOT))
        try:
            import scripts.yoto_cli as yoto_cli
            self.assertTrue(callable(yoto_cli.main))
        finally:
            sys.path.pop(0)

    def test_yoto_cli_status_delegates_to_real_yoto_command_without_printing_tokens(self):
        sys.path.insert(0, str(ROOT))
        old = os.environ.get("YOTO_CLIENT_ID")
        os.environ["YOTO_CLIENT_ID"] = "public-client-id"
        try:
            import scripts.yoto_cli as yoto_cli
            with patch.object(yoto_cli.subprocess, "run") as run:
                run.return_value.returncode = 0
                run.return_value.stdout = "✓ Logged in and token is valid.\n"
                result = yoto_cli.run_yoto(["status"])
            self.assertEqual(result, "✓ Logged in and token is valid.\n")
            args, kwargs = run.call_args
            self.assertEqual(args[0], ["npx", "-y", "@lizozom/yoto@0.3.3", "status"])
            self.assertEqual(kwargs["env"]["YOTO_CLIENT_ID"], "public-client-id")
            self.assertNotIn("accessToken", result)
        finally:
            if old is None:
                os.environ.pop("YOTO_CLIENT_ID", None)
            else:
                os.environ["YOTO_CLIENT_ID"] = old
            sys.path.pop(0)

    def test_doctor_json_reports_auth_source_without_exposing_config_values(self):
        sys.path.insert(0, str(ROOT))
        old = os.environ.get("YOTO_CLIENT_ID")
        os.environ["YOTO_CLIENT_ID"] = "public-client-id"
        try:
            import scripts.yoto_cli as yoto_cli
            with patch.object(yoto_cli.subprocess, "run") as run:
                run.return_value.returncode = 0
                run.return_value.stdout = "✓ Logged in and token is valid.\n"
                data = yoto_cli.doctor()
            self.assertTrue(data["ok"])
            self.assertEqual(data["auth"]["client_id_source"], "env")
            self.assertTrue(data["auth"]["client_id_present"])
            self.assertEqual(data["upstream_package"], "@lizozom/yoto@0.3.3")
            self.assertNotIn("public-client-id", json.dumps(data))
        finally:
            if old is None:
                os.environ.pop("YOTO_CLIENT_ID", None)
            else:
                os.environ["YOTO_CLIENT_ID"] = old
            sys.path.pop(0)

    def test_doctor_rejects_expired_token_message_even_when_upstream_exits_zero(self):
        sys.path.insert(0, str(ROOT))
        old = os.environ.get("YOTO_CLIENT_ID")
        os.environ["YOTO_CLIENT_ID"] = "public-client-id"
        try:
            import scripts.yoto_cli as yoto_cli

            with patch.object(yoto_cli.subprocess, "run") as run:
                run.return_value.returncode = 0
                run.return_value.stdout = "✗ Token may be expired. Try 'yoto login' to re-authenticate.\n"
                data = yoto_cli.doctor()

            self.assertFalse(data["ok"])
            self.assertFalse(data["checks"]["yoto_status"]["ok"])
            self.assertEqual(data["error"]["code"], "yoto_auth_required")
        finally:
            if old is None:
                os.environ.pop("YOTO_CLIENT_ID", None)
            else:
                os.environ["YOTO_CLIENT_ID"] = old
            sys.path.pop(0)

    def test_no_input_login_fails_before_interactive_child_process(self):
        sys.path.insert(0, str(ROOT))
        old = os.environ.get("YOTO_CLIENT_ID")
        os.environ["YOTO_CLIENT_ID"] = "public-client-id"
        try:
            import scripts.yoto_cli as yoto_cli
            with patch.object(yoto_cli.subprocess, "call") as call:
                with self.assertRaises(SystemExit) as raised:
                    yoto_cli.main(["--no-input", "login"])
            self.assertEqual(raised.exception.code, 2)
            call.assert_not_called()
        finally:
            if old is None:
                os.environ.pop("YOTO_CLIENT_ID", None)
            else:
                os.environ["YOTO_CLIENT_ID"] = old
            sys.path.pop(0)

    def test_update_icon_dry_run_prints_command_without_calling_yoto(self):
        sys.path.insert(0, str(ROOT))
        try:
            import scripts.yoto_cli as yoto_cli
            with patch.object(yoto_cli, "run_yoto") as run:
                yoto_cli.main(["update-icon", "example-card-id", "1", "--media-id", "abc", "--dry-run"])
            run.assert_not_called()
        finally:
            sys.path.pop(0)

    def test_icon_validator_accepts_rgba_transparency_and_writes_preview(self):
        sys.path.insert(0, str(ROOT))
        try:
            from scripts.validate_yoto_icon import validate_icon

            with tempfile.TemporaryDirectory() as directory:
                source = pathlib.Path(directory) / "icon.png"
                preview = pathlib.Path(directory) / "preview.png"
                image = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
                image.putpixel((8, 8), (255, 204, 68, 255))
                image.save(source)

                result = validate_icon(source, preview)

                self.assertTrue(result["ok"])
                self.assertTrue(preview.is_file())
                with Image.open(preview) as rendered:
                    self.assertEqual(rendered.size, (256, 256))
        finally:
            sys.path.pop(0)

    def test_icon_validator_rejects_wrong_mode_and_visible_black(self):
        sys.path.insert(0, str(ROOT))
        try:
            from scripts.validate_yoto_icon import validate_icon

            with tempfile.TemporaryDirectory() as directory:
                source = pathlib.Path(directory) / "icon.png"
                preview = pathlib.Path(directory) / "preview.png"
                image = Image.new("RGB", (16, 16), (0, 0, 0))
                image.save(source)

                result = validate_icon(source, preview)

                self.assertFalse(result["ok"])
                self.assertTrue(any("mode" in error for error in result["errors"]))
                self.assertTrue(any("pure-black" in error for error in result["errors"]))
                self.assertTrue(any("transparent" in error for error in result["errors"]))
        finally:
            sys.path.pop(0)

    def test_icon_manifest_plan_rejects_duplicate_indexes_before_writes(self):
        sys.path.insert(0, str(ROOT))
        try:
            from scripts.apply_icon_manifest import build_plan

            rows = [
                {"index": 1, "mediaId": "first"},
                {"idx": 2, "mediaId": "second"},
            ]
            with self.assertRaisesRegex(ValueError, "duplicates entry index 1"):
                build_plan(rows)
        finally:
            sys.path.pop(0)


if __name__ == "__main__":
    unittest.main()
