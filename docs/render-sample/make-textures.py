"""生成报纸做旧用的贴图：纸纹噪点 + 污渍斑。

只用 numpy + Pillow，输出到 docs/render-sample/tex/。
真实插件里这些贴图应当内联为 data URI 或随包分发，避免外部请求。
"""

import os

import numpy as np
from PIL import Image, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), "tex")
os.makedirs(OUT, exist_ok=True)

rng = np.random.default_rng(20261101)


def save(img: Image.Image, name: str) -> None:
    path = os.path.join(OUT, name)
    img.save(path)
    print(f"{name}: {img.size[0]}x{img.size[1]} {os.path.getsize(path)} bytes")


# ---------------------------------------------------------------- 纸纹噪点
# 两层：细颗粒（高频）+ 纤维（横向拉伸），叠加后像压过的新闻纸
def grain(size: int = 420) -> Image.Image:
    fine = rng.normal(0.0, 1.0, (size, size))
    fine = np.clip(fine * 26 + 160, 0, 255)

    fiber = rng.normal(0.0, 1.0, (size // 6, size))
    fiber = np.kron(fiber, np.ones((6, 1)))
    fiber = np.clip(fiber * 7 + 164, 0, 255)

    gray = (fine * 0.72 + fiber * 0.28).astype(np.uint8)

    # alpha：整体很淡，但保留少量更深的墨点
    a = rng.random((size, size))
    alpha = np.where(a > 0.985, rng.integers(90, 150, (size, size)), rng.integers(0, 26, (size, size)))
    alpha = alpha.astype(np.uint8)

    rgba = np.dstack([gray, gray, np.clip(gray + 14, 0, 255), alpha])
    img = Image.fromarray(rgba.astype(np.uint8), "RGBA")
    return img


# ---------------------------------------------------------------- 污渍
# 边缘柔和的不规则褐斑：多层不同半径的高斯噪声阈值化再模糊
def blot(size: int = 512, seed: int = 1) -> Image.Image:
    r = np.random.default_rng(seed)
    base = r.normal(0, 1, (size // 8, size // 8))
    base = np.kron(base, np.ones((8, 8)))[:size, :size]

    mask = np.zeros((size, size), dtype=np.float32)
    for radius, weight in ((0.20, 1.0), (0.33, 0.55), (0.46, 0.3)):
        blob = r.normal(0, 1, (size, size))
        blob = Image.fromarray(((blob - blob.min()) / (blob.max() - blob.min()) * 255).astype(np.uint8))
        blob = blob.filter(ImageFilter.GaussianBlur(size * radius))
        blob = np.asarray(blob, dtype=np.float32) / 255.0
        mask += weight * np.clip((blob - 0.5) * 3.2, 0, 1)

    mask = np.clip(mask / 1.85, 0, 1) ** 1.4
    alpha = (mask * 92).astype(np.uint8)

    brown = np.array([120, 84, 38], dtype=np.uint8)
    rgb = np.broadcast_to(brown, (size, size, 3))
    rgba = np.dstack([rgb, alpha])
    return Image.fromarray(rgba.astype(np.uint8), "RGBA")


save(grain(), "grain.png")
save(blot(seed=11), "blot1.png")
save(blot(seed=42), "blot2.png")
