#!/usr/bin/env python3
"""Small practical wrapper around the Yoto CLI for Make Your Own workflows.

This intentionally does NOT store credentials in the repo. It reads the public
client id from ~/.yoto-cli/config.json or YOTO_CLIENT_ID, then shells out to a
pinned release of the upstream Yoto CLI.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
from typing import Any

CONFIG = pathlib.Path.home() / ".yoto-cli" / "config.json"
UPSTREAM_PACKAGE = "@lizozom/yoto@0.3.3"


def upstream_command(args: list[str]) -> list[str]:
    return ["npx", "-y", UPSTREAM_PACKAGE, *args]


def status_is_authenticated(returncode: int, output: str) -> bool:
    if returncode != 0:
        return False
    normalized = output.casefold()
    failure_markers = (
        "✗",
        "token may be expired",
        "not authenticated",
        "not logged in",
        "re-authenticate",
    )
    return not any(marker in normalized for marker in failure_markers)


def client_id_source() -> tuple[str | None, bool]:
    if os.environ.get("YOTO_CLIENT_ID"):
        return "env", True
    if CONFIG.exists():
        try:
            data = json.loads(CONFIG.read_text())
        except Exception:
            return "config_invalid", False
        return "config", bool(data.get("clientId"))
    return None, False


def client_id() -> str:
    if os.environ.get("YOTO_CLIENT_ID"):
        return os.environ["YOTO_CLIENT_ID"]
    if not CONFIG.exists():
        raise SystemExit("Missing ~/.yoto-cli/config.json and YOTO_CLIENT_ID")
    data = json.loads(CONFIG.read_text())
    cid = data.get("clientId")
    if not cid:
        raise SystemExit("~/.yoto-cli/config.json has no clientId")
    return cid


def doctor() -> dict[str, Any]:
    source, present = client_id_source()
    result: dict[str, Any] = {
        "ok": False,
        "tool": "yoto-cli",
        "upstream_package": UPSTREAM_PACKAGE,
        "auth": {
            "client_id_present": present,
            "client_id_source": source,
            "config_path": str(CONFIG),
            "config_present": CONFIG.exists(),
        },
        "checks": {},
    }
    if not present:
        result["error"] = {
            "code": "client_id_missing",
            "message": "Set YOTO_CLIENT_ID and run yoto-cli login.",
            "retryable": False,
        }
        return result

    cp = subprocess.run(
        upstream_command(["status"]),
        env={**os.environ, "YOTO_CLIENT_ID": client_id()},
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    authenticated = status_is_authenticated(cp.returncode, cp.stdout)
    result["checks"]["yoto_status"] = {
        "ok": authenticated,
        "message": cp.stdout.strip(),
    }
    result["ok"] = authenticated
    if not authenticated:
        result["error"] = {
            "code": "yoto_auth_required" if cp.returncode == 0 else "yoto_status_failed",
            "message": cp.stdout.strip(),
            "retryable": True,
        }
    return result


def run_yoto(args: list[str], *, json_output: bool = False) -> Any:
    env = os.environ.copy()
    env["YOTO_CLIENT_ID"] = client_id()
    cmd = upstream_command(args)
    cp = subprocess.run(cmd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if cp.returncode != 0:
        print(cp.stdout, file=sys.stderr)
        raise SystemExit(cp.returncode)
    if json_output:
        return json.loads(cp.stdout)
    return cp.stdout


def cmd_status(_: argparse.Namespace) -> None:
    print(run_yoto(["status"]).rstrip())


def cmd_doctor(ns: argparse.Namespace) -> None:
    data = doctor()
    if ns.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print("ok" if data["ok"] else "not ok")
        if "error" in data:
            print(data["error"]["message"], file=sys.stderr)
    if not data["ok"]:
        raise SystemExit(1)


def cmd_login(_: argparse.Namespace) -> None:
    # Interactive: prints browser URL / waits for callback.
    if getattr(_, "no_input", False):
        print("login is interactive; omit --no-input or run @lizozom/yoto login manually", file=sys.stderr)
        raise SystemExit(2)
    env = os.environ.copy()
    env["YOTO_CLIENT_ID"] = client_id()
    raise SystemExit(subprocess.call(upstream_command(["login"]), env=env))


def cmd_cards(_: argparse.Namespace) -> None:
    print(json.dumps(run_yoto(["playlist", "list", "--json"], json_output=True), ensure_ascii=False, indent=2))


def cmd_show(ns: argparse.Namespace) -> None:
    print(json.dumps(run_yoto(["playlist", "show", ns.card_id, "--json"], json_output=True), ensure_ascii=False, indent=2))


def cmd_add_entry(ns: argparse.Namespace) -> None:
    args = ["entry", "add", ns.card_id, ns.title, "--file", ns.file, "--json"]
    print(json.dumps(run_yoto(args, json_output=True), ensure_ascii=False, indent=2))


def cmd_update_icon(ns: argparse.Namespace) -> None:
    icon = ns.icon
    if ns.media_id:
        icon = "yoto:#" + ns.media_id.removeprefix("yoto:#")
    args = ["entry", "update", ns.card_id, str(ns.index), "--icon", icon]
    if ns.dry_run:
        print(json.dumps({"dry_run": True, "command": upstream_command(args)}, ensure_ascii=False))
        return
    print(run_yoto(args).rstrip())


def cmd_list_icons(ns: argparse.Namespace) -> None:
    args = ["icon", "list", "--json"]
    if ns.tag:
        args = ["icon", "list", "--tag", ns.tag, "--json"]
    print(json.dumps(run_yoto(args, json_output=True), ensure_ascii=False, indent=2))


def cmd_upload_icon(ns: argparse.Namespace) -> None:
    args = ["icon", "upload", ns.file, "--no-convert", "--json"]
    print(json.dumps(run_yoto(args, json_output=True), ensure_ascii=False, indent=2))


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="Interact with Yoto via @lizozom/yoto")
    p.add_argument("--json", action="store_true", help="emit machine-readable JSON where supported")
    p.add_argument("--no-input", action="store_true", help="never prompt; fail fast if a command would be interactive")
    sub = p.add_subparsers(required=True)

    sub.add_parser("doctor").set_defaults(func=cmd_doctor)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("login").set_defaults(func=cmd_login)
    sub.add_parser("cards").set_defaults(func=cmd_cards)

    show = sub.add_parser("show")
    show.add_argument("card_id")
    show.set_defaults(func=cmd_show)

    add = sub.add_parser("add-entry")
    add.add_argument("card_id")
    add.add_argument("title")
    add.add_argument("file")
    add.set_defaults(func=cmd_add_entry)

    upd = sub.add_parser("update-icon")
    upd.add_argument("card_id")
    upd.add_argument("index", type=int, help="0-based Yoto entry index")
    upd.add_argument("--dry-run", action="store_true", help="print the underlying command without changing Yoto")
    g = upd.add_mutually_exclusive_group(required=True)
    g.add_argument("--icon", help="icon string, e.g. yoto:#<mediaId>")
    g.add_argument("--media-id", help="bare built-in/custom mediaId; yoto:# prefix added")
    upd.set_defaults(func=cmd_update_icon)

    icons = sub.add_parser("icons")
    icons.add_argument("--tag")
    icons.set_defaults(func=cmd_list_icons)

    upicon = sub.add_parser("upload-icon")
    upicon.add_argument("file")
    upicon.set_defaults(func=cmd_upload_icon)

    ns = p.parse_args(argv)
    ns.func(ns)


if __name__ == "__main__":
    main()
