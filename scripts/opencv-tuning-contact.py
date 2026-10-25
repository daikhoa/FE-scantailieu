"""Render measured outputs for visual review; Pillow is test-only."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.tmp-opencv-tune'
rows = []
for name in ['holdout-shadow', 'holdout-faint', 'holdout-noisy', 'development-color']:
    rows.append((name, [WORK/'samples'/f'{name}.png',
                       WORK/'outputs'/f'{name}-before.ppm',
                       WORK/'outputs'/f'{name}-after.ppm']))
for image in sorted((WORK/'real-after/outputs').glob('smartdoc*-balanced.ppm'))[::5]:
    name = image.name.removesuffix('-balanced.ppm')
    rows.append((name, [WORK/'real-after/outputs'/f'{name}-source.ppm',
                       WORK/'real-before/outputs'/f'{name}-balanced.ppm', image]))
width, height, label = 380, 390, 32
sheet = Image.new('RGB', (width*3, (height+label)*len(rows)), '#202322')
draw = ImageDraw.Draw(sheet)
for row, (name, paths) in enumerate(rows):
    for col, path in enumerate(paths):
        x, y = col*width, row*(height+label)
        draw.text((x+8, y+10), f'{name[:30]} / {['source', 'before', 'after'][col]}', fill='white')
        with Image.open(path) as original:
            fitted = ImageOps.contain(original, (width-12, height-12), Image.Resampling.LANCZOS)
            sheet.paste(fitted, (x+(width-fitted.width)//2, y+label+(height-fitted.height)//2))
sheet.save(WORK/'comparison.png')
