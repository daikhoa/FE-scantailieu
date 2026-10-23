# Enhanced color preset

The reported comparison shows a pale illustrated cover in the web result and a
stronger contrast filter selected in CamScanner. Screenshots do not establish
equal source resolution or sharpness. The selected review preview already uses
the full final JPEG, not the thumbnail. Capture currently freezes the negotiated
video frame immediately; small subjects therefore retain fewer source pixels
after cropping. The renderer caps the long side at 3000 without upscaling crops.

`enhanced-color` is an explicit, optional preset for covers and color documents.
It applies a shared monotone RGB curve using the existing measured 5th/95th
luminance percentiles. Bounded black/white anchors deepen raised blacks and lift
dim whites. Soft toe and shoulder retain existing 0/255 endpoints without new
clipping. Nearly flat images and fully transparent pixels are untouched. Alpha
is preserved. The curve can compress close tones in deep shadows or highlights;
it is a contrast preference, not a lossless restoration or detail recovery.

The preset runs on the owned perspective output before the final JPEG encode.
It intentionally bypasses auto paper whitening and classifier strength gating.
No model, platform branch, dependency, resampling or extra JPEG pass is added.
Existing auto/original defaults remain unchanged; selecting **Gốc** compares the
same crop without enhancement. The selected image is also used for PDF export.

Regression coverage includes hazy colored patches, neutral ramps, clipping,
nearly flat surfaces, faint marks, alpha, recipe selection and engine forwarding.
Physical Android/iPhone capture quality and a same-source comparison against
CamScanner still require original photo/output files and device testing.
