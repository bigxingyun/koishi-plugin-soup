"""把「版面规划（LayoutPlan）」渲染成可直接截图的 HTML。

这是插件运行时的真实形态：**AI 只产出 JSON，排版由本脚本确定性地算**。
任何字段缺失、越界、类型不对，都回退到默认值并在 stderr 提示 —— 绝不让 AI 的自由发挥决定 CSS。

用法：
    python build.py plans/01-additive-harm.json
    python build.py plans/01-additive-harm.json --out _build-01.html
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "template", "newspaper.tpl.html")

WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]

# 唯一的色彩白名单：AI 只能选名字，不能给色值
ACCENTS = {
    "rust":  dict(hex="#8c2318", deep="#6d1a12", tint="rgba(140,35,24,.16)", shadow="rgba(140,35,24,.55)"),
    "blood": dict(hex="#7a1010", deep="#5c0b0b", tint="rgba(122,16,16,.18)", shadow="rgba(122,16,16,.6)"),
    "ink":   dict(hex="#2f2a22", deep="#241f19", tint="rgba(47,42,34,.14)", shadow="rgba(47,42,34,.5)"),
    "steel": dict(hex="#2f4858", deep="#22343f", tint="rgba(47,72,88,.15)", shadow="rgba(47,72,88,.5)"),
}

DEFAULTS = dict(
    columns=2, fontPx=14.5, lineHeight=1.95, dropCap=True,
    accent="rust", grain=0.9, stamp="本报独家", stampAngle=-8, stampOpacity=0.6,
)

warnings: list[str] = []


def warn(msg: str) -> None:
    warnings.append(msg)
    print(f"[warn] {msg}", file=sys.stderr)


def clamp(value, lo, hi, name):
    """越界就夹紧并告警——这是防 AI 交付垃圾的关键一步。"""
    try:
        v = float(value)
    except (TypeError, ValueError):
        warn(f"{name}={value!r} 不是数字，用默认值")
        return None
    if v < lo or v > hi:
        warn(f"{name}={v} 超出 [{lo}, {hi}]，已夹紧")
        v = min(max(v, lo), hi)
    return v


def pick_enum(value, allowed, name, default):
    if value not in allowed:
        warn(f"{name}={value!r} 不在 {sorted(allowed)}，用 {default!r}")
        return default
    return value


def esc(text: str) -> str:
    return html.escape(str(text), quote=True)


def rich(text: str) -> str:
    """允许极小的行内标记：`反引号` -> <kbd>，其余全部转义。"""
    parts = esc(text).split("`")
    out = []
    for i, part in enumerate(parts):
        out.append(f"<kbd>{part}</kbd>" if i % 2 else part)
    return "".join(out)


# ------------------------------------------------------------------ 自动排版
def masthead_size(name: str) -> tuple[int, int]:
    n = len(name)
    px = 54 if n <= 3 else 46 if n == 4 else 40 if n == 5 else 34
    return px, max(4, round(px * 0.15))


def title_size(title: str) -> int:
    n = len(title)
    return 44 if n <= 4 else 40 if n <= 6 else 34 if n <= 8 else 29


def resolve_style(plan: dict, body_len: int) -> dict:
    raw = plan.get("style") or {}
    style = dict(DEFAULTS)

    if "columns" in raw:
        style["columns"] = int(pick_enum(raw["columns"], {1, 2}, "style.columns", DEFAULTS["columns"]))
    for key, lo, hi in (("fontPx", 12.0, 16.5), ("lineHeight", 1.65, 2.1)):
        if key in raw:
            v = clamp(raw[key], lo, hi, f"style.{key}")
            if v is not None:
                style[key] = round(v, 2)
    if "dropCap" in raw:
        style["dropCap"] = bool(raw["dropCap"])
    if "accent" in raw:
        style["accent"] = pick_enum(raw["accent"], set(ACCENTS), "style.accent", DEFAULTS["accent"])

    # 按篇幅自动定字号：短稿放大填版，长稿缩小保版。阈值只是近似，
    # 插件里应改为「渲染后量高度、超限再缩一档」（见 README 的 TODO）。
    if body_len < 280:
        style["fontPx"] = round(style["fontPx"] + 1.3, 2)
        style["lineHeight"] = round(style["lineHeight"] + 0.05, 2)
        warn(f"正文仅 {body_len} 字，放大到 {style['fontPx']}px 以填满版面")
    elif body_len > 800:
        style["fontPx"] = round(style["fontPx"] - 1.4, 2)
        style["lineHeight"] = round(style["lineHeight"] - 0.12, 2)
        warn(f"正文 {body_len} 字，自动降字号到 {style['fontPx']}px")
    if body_len > 1500:
        style["fontPx"] = round(max(12.0, style["fontPx"] - 2.4), 2)
        style["lineHeight"] = 1.75
        warn(f"正文 {body_len} 字：已压到 {style['fontPx']}px，仍建议把汤面拆成多版")

    stamp = plan.get("stamp") or {}
    style["stamp"] = str(stamp.get("text") or DEFAULTS["stamp"])[:4]
    style["stampAngle"] = clamp(stamp.get("angle", DEFAULTS["stampAngle"]), -12, 0, "stamp.angle") or DEFAULTS["stampAngle"]
    style["stampOpacity"] = clamp(stamp.get("opacity", DEFAULTS["stampOpacity"]), 0.35, 0.75, "stamp.opacity") or DEFAULTS["stampOpacity"]
    style["grain"] = clamp(raw.get("grain", DEFAULTS["grain"]), 0.3, 1.0, "style.grain") or DEFAULTS["grain"]
    return style


def build_body(plan: dict, drop_cap: bool) -> tuple[str, int]:
    body = plan.get("body")
    if isinstance(body, str):
        body = re.split(r"\n\s*\n", body.strip())
    if not isinstance(body, list) or not body:
        raise SystemExit("plan.body 为空：没有正文就没什么可排的")

    paras: list[str] = []
    drop_char = ""
    for i, raw in enumerate(body):
        text = str(raw).strip()
        if not text:
            continue
        # 报纸小标题：以「第一周：」这类开头时把标记加粗
        text = re.sub(r"^(第[一二三四五六七八九十百]+周|第[一二三四五六七八九十百]+天)([：:])",
                      r"<b>\1</b>\2", esc(text))
        if i == 0 and drop_cap:
            drop_char = text[0]
        paras.append(text)

    if not paras:
        raise SystemExit("plan.body 全是空段落")

    if drop_cap and drop_char:
        paras[0] = f'<span class="drop">{esc(drop_char)}</span>' + paras[0][len(drop_char):]

    total = sum(len(p) for p in paras)
    html_body = "\n".join(f"        <p>{p}</p>" for p in paras)
    return html_body, total


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("plan")
    ap.add_argument("--out")
    args = ap.parse_args()

    with open(args.plan, encoding="utf-8") as f:
        plan = json.load(f)

    body_html, body_len = build_body(plan, DEFAULTS["dropCap"] if "dropCap" not in (plan.get("style") or {}) else bool(plan["style"]["dropCap"]))
    style = resolve_style(plan, body_len)
    accent = ACCENTS[style["accent"]]

    name = str(plan.get("masthead", {}).get("name") or "海龟汤")
    en = str(plan.get("masthead", {}).get("en") or "Situation Puzzle Post")
    mast_px, mast_ls = masthead_size(name)

    date_raw = str(plan.get("date") or dt.date.today().isoformat())
    try:
        date = dt.date.fromisoformat(date_raw)
    except ValueError:
        warn(f"date={date_raw!r} 不是 YYYY-MM-DD，用今天")
        date = dt.date.today()

    issue = int(plan.get("issue") or 1)
    pages = int(plan.get("pages") or 1)

    difficulty = str(plan.get("difficulty") or "普通")
    tags = plan.get("tags") or []
    dateline_right = "难度 " + difficulty + ("　·　" + " / ".join(map(str, tags)) if tags else "")

    notice = plan.get("notice") or {}
    howto = plan.get("howto") or {}
    footer = plan.get("footer") or {}

    stamp_cells = "".join(f"<span>{esc(c)}</span>" for c in style["stamp"])

    subs = {
        "MASTHEAD": esc(name),
        "MASTHEAD_EN": esc(en),
        "MASTHEAD_PX": str(mast_px),
        "MASTHEAD_LS": str(mast_ls),
        "ISSUE_LINE": f"第 {issue:04d} 期<br>共 {pages} 版",
        "DATE_LINE": f"{date:%Y.%m.%d}<br>{WEEKDAYS[date.weekday()]}",
        "DATELINE_LEFT": rich(plan.get("dateline") or "本报讯　·　本报编辑部"),
        "DATELINE_RIGHT": esc(dateline_right),
        "KICKER": esc(plan.get("kicker") or ""),
        "TITLE": esc(plan.get("title") or "无题"),
        "DECK": esc(plan.get("deck") or ""),
        "BODY_HTML": body_html,
        "COLUMNS": str(style["columns"]),
        "FONT_PX": str(style["fontPx"]),
        "LINE_HEIGHT": str(style["lineHeight"]),
        "DROP_PX": str(round(style["fontPx"] * 3.05)),
        "TITLE_PX": str(title_size(str(plan.get("title") or ""))),
        "ACCENT_HEX": accent["hex"],
        "ACCENT_DEEP": accent["deep"],
        "ACCENT_TINT": accent["tint"],
        "ACCENT_SHADOW": accent["shadow"],
        "GRAIN_OPACITY": str(style["grain"]),
        "STAMP_CELLS": stamp_cells,
        "STAMP_ANGLE": str(style["stampAngle"]),
        "STAMP_OPACITY": str(style["stampOpacity"]),
        "BYLINE": esc(plan.get("byline") or "本文仅据当事人口述整理，真相待解。"),
        "NOTICE_TITLE": esc(notice.get("title") or "本版须知"),
        "NOTICE_LINES": "<br>".join(rich(x) for x in (notice.get("lines") or [])),
        "HOWTO_TITLE": esc(howto.get("title") or "提问方式"),
        "HOWTO_LINES": "<br>".join(rich(x) for x in (howto.get("lines") or [])),
        "FOOTER_LEFT": esc(footer.get("left") or f"汤号 No.{issue:04d}"),
        "FOOTER_RIGHT": esc(footer.get("right") or f"第 {1} 版"),
        "PAD_TOP": str(30),
        "HEAD_PAD": str(14),
        "BODY_MT": str(14),
    }

    with open(TEMPLATE, encoding="utf-8") as f:
        tpl = f.read()

    out_html = tpl
    for key, value in subs.items():
        out_html = out_html.replace("{{" + key + "}}", value)

    leftover = re.findall(r"\{\{[A-Z_]+\}\}", out_html)
    if leftover:
        raise SystemExit(f"模板还有未替换的占位符：{sorted(set(leftover))}")

    slug = os.path.splitext(os.path.basename(args.plan))[0]
    out = args.out or os.path.join(HERE, f"_build-{slug}.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(out_html)

    print(f"built {os.path.basename(out)}  body={body_len}字 columns={style['columns']} "
          f"font={style['fontPx']}px accent={style['accent']} warns={len(warnings)}")


if __name__ == "__main__":
    main()
