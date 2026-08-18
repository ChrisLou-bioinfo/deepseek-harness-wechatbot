#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Render a WeChat-publishable inline-styled HTML from a Markdown promo draft.

Follows the report_v3 playbook:
  - bm.md render API (markdownStyle=green-simple, platform=wechat, customCss)
  - Browser UA required (default urllib UA -> 403)
  - Wrap output in a charset-declared skeleton (bm.md returns a bare <section>)
  - Base64-inline local images if any (script keeps the capability)

Output: <input base>-wechat.html  -> open in browser -> select-all -> paste.
"""

import base64
import json
import re
import sys
import urllib.request
from pathlib import Path

RENDER_API = "https://bm.md/api/markdown/render"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36")
CUSTOM_CSS = "/tmp/wechat-custom.css"  # from ystherr skill; re-fetch if missing
MARKDOWN_STYLE = "green-simple"


def load_custom_css() -> str:
    p = Path(CUSTOM_CSS)
    if p.exists():
        return p.read_text(encoding="utf-8")
    # fetch on demand (needs `gh` and network)
    import subprocess
    out = subprocess.run(
        ["gh", "api", "repos/ystherr/wechat-article-formatter-skill/contents/styles/custom.css", "--jq", ".content"],
        capture_output=True, text=True, check=False,
    ).stdout.strip()
    css = base64.b64decode(out).decode("utf-8")
    p.write_text(css, encoding="utf-8")
    return css


def render(markdown: str) -> str:
    payload = {
        "markdown": markdown,
        "markdownStyle": MARKDOWN_STYLE,
        "platform": "wechat",
        "customCss": load_custom_css(),
    }
    req = urllib.request.Request(
        RENDER_API,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": UA},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    html = data.get("result", "")
    if not html:
        raise RuntimeError("bm.md returned no result")
    return html


def inline_local_images(html: str, base_dir: Path) -> str:
    """Replace <img src="local/path"> with a base64 data URI."""

    def repl(m: re.Match):
        src = m.group(1)
        if src.startswith(("http", "data:")):
            return m.group(0)
        img = base_dir.joinpath(src).resolve()
        if not img.exists():
            return m.group(0)
        ext = img.suffix.lstrip(".").lower()
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}.get(ext, "application/octet-stream")
        b64 = base64.b64encode(img.read_bytes()).decode("ascii")
        return f'<img src="data:{mime};base64,{b64}" alt="{img.stem}"/>'

    return re.sub(r'<img[^>]*src="([^"]+)"', repl, html)


def build_doc(html: str, title: str) -> str:
    body = inline_local_images(html, Path(__file__).resolve().parent.parent)
    return (
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n"
        "<meta charset=\"UTF-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        f"<title>{title}</title>\n</head>\n<body>\n" + body + "\n</body>\n</html>\n"
    )


def main() -> None:
    md_path = Path(__file__).resolve().parent.parent / "promo.md"
    title = "把 DeepSeek Harness 装进你的微信"
    md = md_path.read_text(encoding="utf-8")
    print("rendering via bm.md ...", file=sys.stderr)
    html = render(md)
    doc = build_doc(html, title)
    out = md_path.with_name(f"{md_path.stem}-wechat.html")
    out.write_text(doc, encoding="utf-8")
    print(f"OK -> {out}  ({len(doc)} bytes, style count={doc.count('style=')})", file=sys.stderr)


if __name__ == "__main__":
    main()
