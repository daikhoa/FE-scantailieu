"""Prepare deterministic image-quality benchmark inputs (Pillow is test-only)."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.tmp-quality' / 'samples'
OUT.mkdir(parents=True, exist_ok=True)
samples = []

def save(name, image, corners=None, provenance='synthetic'):
    image = image.convert('RGBA')
    image.save(OUT / f'{name}.png')
    (OUT / f'{name}.rgba').write_bytes(image.tobytes())
    samples.append(dict(name=name, width=image.width, height=image.height,
                        rgba=f'{name}.rgba', image=f'{name}.png', corners=corners,
                        provenance=provenance))

font = ImageFont.load_default(size=26)
paper = Image.new('RGB', (720, 520), (231, 229, 225))
draw = ImageDraw.Draw(paper)
for line in range(12):
    draw.text((28, 20 + line * 40), 'Scan document: small text 0123456789', font=font, fill=(60, 60, 60))
save('soft-text', paper.filter(ImageFilter.GaussianBlur(.8)))
faint = Image.new('RGB', paper.size, (220, 220, 220))
draw = ImageDraw.Draw(faint)
for line in range(12):
    draw.text((28, 20 + line * 40), 'Faint pencil and fine text 012345', font=font, fill=(195, 195, 195))
save('faint-text', faint.filter(ImageFilter.GaussianBlur(.5)))
cover = paper.copy()
draw = ImageDraw.Draw(cover)
draw.rectangle((30, 20, 690, 110), fill=(50, 105, 175))
draw.text((60, 42), 'COLOR DOCUMENT / ORIGINAL COLORS', font=font, fill=(240, 235, 225))
draw.ellipse((500, 220, 650, 370), fill=(185, 55, 70))
save('colored-cover', cover.filter(ImageFilter.GaussianBlur(.65)))
noise = Image.new('RGB', (720, 520))
noise.putdata([(210 + (3 if (x + y) % 2 else -3),) * 3 for y in range(520) for x in range(720)])
save('paper-noise', noise)
for split in ['development', 'holdout']:
    manifest_path = ROOT / 'tests' / 'fixtures' / 'smartdoc15' / split / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    for fixture in manifest['fixtures']:
        save(fixture['id'], Image.open(manifest_path.parent / fixture['image']['path']),
             fixture['label']['corners'], 'ICDAR2015 SmartDoc, CC-BY-4.0; attribution in fixture manifest')
(OUT / 'index.json').write_text(json.dumps(samples, indent=2), encoding='utf-8')
print(f'Prepared {len(samples)} quality samples in {OUT}')
