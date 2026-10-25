"""Deterministic test-only inputs/masks; requires Pillow and NumPy, no user photos."""
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.tmp-opencv-tune/samples'
OUT.mkdir(parents=True, exist_ok=True)
manifest = []
for split, width, height, seed in [('development', 960, 720, 7251), ('holdout', 832, 1136, 9817)]:
    rng = np.random.default_rng(seed)
    font = ImageFont.load_default(size=24 if split == 'development' else 30)
    mask = Image.new('L', (width, height))
    draw = ImageDraw.Draw(mask)
    for y in range(35, height - 35, 46 if split == 'development' else 58):
        draw.text((30, y), 'Document 0123456789 / Fine print and pencil', font=font, fill=255)
    alpha = np.asarray(mask, dtype=np.float32) / 255
    yy, xx = np.mgrid[0:height, 0:width]
    u, v = xx / (width - 1), yy / (height - 1)
    for kind in ['faint', 'shadow', 'uneven', 'noisy', 'crisp', 'color', 'underexposed']:
        background, ink = (236., 210.) if kind == 'faint' else (236., 55.)
        if kind == 'crisp':
            background, ink = 245., 20.
        clean = np.repeat((background + (ink - background) * alpha)[..., None], 3, axis=2)
        if kind == 'color':
            # Fixed swatches exercise chroma preservation independently of luminance.
            for top, rgb in [(height//4, (45, 110, 190)), (height//2, (185, 60, 80))]:
                clean[top:top+height//7, width*2//3:width-20] = rgb
        if kind == 'shadow':
            exposure = .44 + .56 * (u if split == 'development' else v)
        elif kind == 'uneven':
            exposure = .55 + .45 * np.clip(np.hypot(u-.25, v-.35), 0, 1)
        elif kind == 'underexposed':
            exposure = np.full((height, width), .65)
        else:
            exposure = np.ones((height, width))
        pixels = clean * exposure[..., None]
        if kind == 'noisy':
            pixels += rng.normal(0, 5, (height, width, 1))
        image = Image.fromarray(np.uint8(np.clip(np.rint(pixels), 0, 255)))
        if kind == 'faint':
            image = image.filter(ImageFilter.GaussianBlur(.5))
        name = f'{split}-{kind}'
        image.save(OUT / f'{name}.png')
        rgba = image.convert('RGBA').tobytes()
        (OUT / f'{name}.rgba').write_bytes(rgba)
        # Use interiors, away from antialiasing and the color swatches.
        paper = (alpha == 0) & (xx < width*.6) & (xx > 25) & (yy > 25) & (yy < height-25)
        strokes = (alpha > .95) & (xx < width*.6)
        labels = np.zeros((height, width), dtype=np.uint8)
        labels[paper] = 1
        labels[strokes] = 2
        (OUT / f'{name}.mask').write_bytes(labels.tobytes())
        manifest.append(dict(name=name, split=split, kind=kind, width=width, height=height,
                             rgba=f'{name}.rgba', mask=f'{name}.mask', cleanPaper=background))
(OUT / 'index.json').write_text(json.dumps(manifest, indent=2), encoding='utf8')
print(f'Prepared {len(manifest)} synthetic cases with independent paper/ink masks.')
