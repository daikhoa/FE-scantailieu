export function paperDocument(
  kind:
    | 'white'
    | 'crease'
    | 'diagonal-crease'
    | 'faint-crease'
    | 'printed-column'
    | 'vertical-crease'
    | 'printed-band'
    | 'warm'
    | 'pastel'
    | 'colored'
    | 'gray-panel'
    | 'gray-sidebar'
    | 'color-panel'
    | 'photo'
    | 'inverse'
    | 'flat'
    | 'noisy' = 'white',
  width = 384,
  height = 512,
) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const px = Math.floor((x * 384) / width),
        py = Math.floor((y * 512) / height);
      const stroke = px % 16 < 2 && py % 24 >= 4 && py % 24 < 18;
      let shade = [
        'flat',
        'crease',
        'vertical-crease',
        'diagonal-crease',
        'faint-crease',
        'printed-band',
        'printed-column',
      ].includes(kind)
        ? 1
        : 0.55 + (0.45 * x) / (width - 1);
      const creaseDistance =
        kind === 'vertical-crease'
          ? Math.abs(px - 190)
          : Math.abs(py - (kind === 'diagonal-crease' ? 210 + px * 0.2 : 250));
      if (
        ['crease', 'vertical-crease', 'diagonal-crease', 'faint-crease'].includes(kind) &&
        creaseDistance < 14
      )
        shade *= 0.6 + (0.4 * creaseDistance) / 14;

      let color =
        kind === 'colored'
          ? [240, 200, 150]
          : kind === 'pastel'
            ? [240, 220, 210]
            : [236, 236, 236];
      if (kind === 'gray-panel' && x > 100 && x < 280 && y > 128 && y < 384)
        color = [135, 135, 135];
      if (kind === 'gray-sidebar' && x < 128) color = [135, 135, 135];
      if (kind === 'color-panel' && x > 100 && x < 280 && y > 128 && y < 384) color = [35, 50, 70];
      if (kind === 'printed-band' && Math.abs(py - 250) < 14) color = [142, 142, 142];
      if (kind === 'printed-column' && Math.abs(px - 190) < 14) color = [142, 142, 142];
      if (stroke) color = kind === 'faint-crease' ? [150, 150, 150] : [40, 40, 40];
      if (kind === 'inverse') color = stroke ? [230, 230, 230] : [40, 40, 40];
      if (kind === 'photo') {
        const v = 60 + ((x * 37 + y * 13) % 150);
        color = [v, v, v];
      }
      if (kind === 'warm')
        color = color.map(
          (v, c) => v * (1 - (1 - ([1, 0.96, 0.88][c] ?? 1)) * (1 - x / (width - 1))),
        );
      if (kind === 'noisy') color = [0, 1, 2].map((c) => 110 + ((x * 37 + y * 13 + c * 19) % 100));
      pixels.set([...color.map((v) => Math.round(v * shade)), 255], (y * width + x) * 4);
    }
  return { dimensions: { width, height }, pixels };
}
