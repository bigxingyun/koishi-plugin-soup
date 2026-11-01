"""把每张样张另存为 JPEG，并打印体积对比。

JPEG 是实际发到群里的格式：PNG 动辄 2MB+，既慢又容易被平台拒收。
"""

import glob
import os

from PIL import Image

D = os.path.dirname(os.path.abspath(__file__))

print(f"{'file':34}{'PNG':>10}{'JPEG q86':>11}  尺寸")
print("-" * 78)

for src in sorted(glob.glob(os.path.join(D, "sample-*.png"))):
    im = Image.open(src).convert("RGB")
    jpg = src[:-4] + ".jpg"
    im.save(jpg, quality=86, optimize=True, progressive=True, subsampling=0)
    png_kb = os.path.getsize(src) / 1024
    jpg_kb = os.path.getsize(jpg) / 1024
    print(f"{os.path.basename(src):34}{png_kb:9.0f}K{jpg_kb:10.0f}K  {im.width}x{im.height}")
