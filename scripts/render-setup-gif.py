#!/usr/bin/env python3
"""Build docs/assets/setup-demo.gif from a captured ./setup --dry-run log."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "assets" / "setup-demo.gif"
BG = (30, 30, 46)
FG = (205, 214, 244)
GREEN = (166, 227, 161)
YELLOW = (249, 226, 175)
CYAN = (137, 220, 235)
FRAME_MS = 120
MAX_LINES = 36
WIDTH, HEIGHT = 1100, 620
PAD = 20
LINE_HEIGHT = 17
FONT_SIZE = 14
CHARS_PER_LINE = 118


def load_font() -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    ):
        path = Path(candidate)
        if path.is_file():
            return ImageFont.truetype(str(path), FONT_SIZE)
    return ImageFont.load_default()


FONT = load_font()


def capture_log() -> list[str]:
    work = Path(tempfile.mkdtemp(prefix="pm-gif-"))
    stubs = work / "stubs"
    home = work / "home"
    stubs.mkdir()
    (home / "src" / "demo-repo").mkdir(parents=True)
    (home / "vault" / ".obsidian").mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=home / "src" / "demo-repo", check=False)
    stubs.joinpath("docker").write_text(
        "#!/usr/bin/env bash\n"
        'case "$1" in info|ps) exit 0 ;; compose) '
        'case "$*" in *" version"*) echo "Docker Compose version v2.29.0" ;; esac ;; esac\n'
        "exit 0\n"
    )
    stubs.joinpath("curl").write_text(
        "#!/usr/bin/env bash\n"
        'case "$*" in */v1/models*) echo \'{"object":"list","data":[{"id":"Gemma-4-E2B-it-GGUF","downloaded":true}]}\' ;; '
        '*) echo "{}" ;; esac\nexit 0\n'
    )
    for name in ("docker", "curl"):
        stubs.joinpath(name).chmod(0o755)
    node = shutil.which("node")
    if not node:
        print("node not found on PATH", file=sys.stderr)
        sys.exit(1)
    env = {
        "PATH": f"{stubs}:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "HOME": str(home),
        "TERM": "dumb",
        "PM_PROJECT": "pm-demo",
        "HINDSIGHT_PORT": "28888",
        "HINDSIGHT_CP_PORT": "29999",
    }
    proc = subprocess.run(
        [node, str(ROOT / "cli" / "personal-memory.mjs"), "setup", "--yes", "--dry-run"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    raw = (proc.stdout or "") + (proc.stderr or "")
    raw = re.sub(r"\x1b\[[0-9;]*m", "", raw)
    lines: list[str] = []
    for line in raw.splitlines():
        line = re.sub(r"/home/[^/]+/personal-memory", "~/personal-memory", line)
        line = re.sub(r"/tmp/pm-gif-[^/]+/home", "~", line)
        line = re.sub(r"^personal-memory:\s*", "", line)
        if line.strip():
            lines.append(line.rstrip())
    return lines[:MAX_LINES]


def color_line(line: str) -> tuple[str, tuple[int, int, int]]:
    if line.startswith("=="):
        return line, CYAN
    if "[dry-run]" in line or line.strip().startswith("ok "):
        return line, GREEN
    if "warn" in line.lower():
        return line, YELLOW
    if line.startswith("$") or line.startswith("git clone"):
        return line, FG
    return line, FG


def render_frame(lines: list[str], prompt: str) -> Image.Image:
    img = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(img)
    y = PAD
    draw.text((PAD, y), prompt, font=FONT, fill=CYAN)
    y += LINE_HEIGHT + 4
    for line in lines:
        text, color = color_line(line)
        draw.text((PAD, y), text[:CHARS_PER_LINE], font=FONT, fill=color)
        y += LINE_HEIGHT
        if y > HEIGHT - PAD:
            break
    return img


def main() -> int:
    lines = capture_log()
    if len(lines) < 8:
        print("capture too short", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    prompt = "$ npx personal-memory setup --dry-run"
    frames: list[Image.Image] = []
    # Typing the command
    for i in range(1, len(prompt) + 1):
        frames.append(render_frame([], prompt[:i]))
    frames.append(render_frame([], prompt))
    # Reveal log progressively
    shown: list[str] = []
    for line in lines:
        shown.append(line)
        frames.append(render_frame(shown, prompt))
    # Hold on final frame
    for _ in range(8):
        frames.append(render_frame(shown, prompt))
    rgb_frames = [f.convert("RGB") for f in frames]
    rgb_frames[0].save(
        OUT,
        save_all=True,
        append_images=rgb_frames[1:],
        duration=FRAME_MS,
        loop=0,
        optimize=True,
    )
    print(f"wrote {OUT} ({len(frames)} frames, {OUT.stat().st_size // 1024} KiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
