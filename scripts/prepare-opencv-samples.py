"""Test-only lossless OpenCV benchmark inputs and aspect-preserving contact sheet.

Run prepare-quality-samples.py first, this script, benchmark-opencv.mjs, then
this script again to create the contact sheet from the measured output pixels.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.tmp-opencv'
SAMPLES = WORK / 'samples'
SAMPLES.mkdir(parents=True, exist_ok=True)
for source in sorted((ROOT / '.tmp-quality/samples').glob('*.png')):
    with Image.open(source) as image:
        image.convert('RGB').save(SAMPLES / (source.stem + '.ppm'))

names = ['soft-text', 'faint-text', 'colored-cover', 'smartdoc-development-0']
outputs = WORK / 'outputs'
# Select one available licensed real page without relying on filesystem order.
real = sorted(outputs.glob('smartdoc*-source.ppm'))
if real:
    names[-1] = real[0].name.removesuffix('-source.ppm')
profiles = ['source', 'custom', 'balanced', 'text']
if all((outputs / f'{name}-{profile}.ppm').is_file()
       for name in names for profile in profiles):
    tile_w, tile_h, label_h = 384, 430, 36
    sheet = Image.new('RGB', (tile_w * 4, (tile_h + label_h) * 4), '#202322')
    draw = ImageDraw.Draw(sheet)
    for row, name in enumerate(names):
        for col, profile in enumerate(profiles):
            x, y = col * tile_w, row * (tile_h + label_h)
            draw.text((x + 8, y + 10), f'{name[:27]} / {profile}', fill='white')
            with Image.open(outputs / f'{name}-{profile}.ppm') as image:
                fitted = ImageOps.contain(image, (tile_w - 12, tile_h - 12),
                                          Image.Resampling.LANCZOS)
                sheet.paste(fitted, (x + (tile_w - fitted.width) // 2,
                                     y + label_h + (tile_h - fitted.height) // 2))
    sheet.save(WORK / 'contact.png')
