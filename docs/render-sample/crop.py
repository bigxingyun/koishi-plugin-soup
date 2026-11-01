"""把 Chrome 截图里的留白裁掉：按页面底色找内容外接框，再加一圈边距。

用法：python crop.py <raw.png> <out.png>
"""

import sys

import numpy as np
from PIL import Image

BG = (207, 188, 149)  # 与 newspaper.html 中 html/body 的 background 一致
PAD = 30              # 设备像素（dsf=2 时等于 15 CSS px）


def main(src: str, dst: str) -> None:
    img = Image.open(src).convert("RGB")
    a = np.asarray(img, dtype=np.int16)

    diff = np.abs(a - np.array(BG, dtype=np.int16)).max(axis=2)
    mask = diff > 6  # 容差：纸张、阴影、噪点都算内容

    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    if rows.size == 0:
        raise SystemExit("没有找到内容，检查背景色是否与 BG 一致")

    top, bottom = int(rows[0]), int(rows[-1])
    left, right = int(cols[0]), int(cols[-1])

    box = (
        max(left - PAD, 0),
        max(top - PAD, 0),
        min(right + PAD + 1, img.width),
        min(bottom + PAD + 1, img.height),
    )
    out = img.crop(box)
    out.save(dst, optimize=True)
    print(f"{dst}: {out.width}x{out.height}  (crop {box})")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
