# Browser restoration models

All three models run locally in the browser through ONNX Runtime Web. The page image is never sent
to a restoration API.

| File                        | Purpose                                          | Source and license                                                                                                    | SHA-256                                                            |
| --------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `document-defects.onnx`     | Seven-label routing classifier                   | Locally trained bootstrap model; training data contains synthetic samples and needs further real-phone validation     | `9D42DD1121652DBC68C21B0CAC13E40F3E7E57A04761ED380C7C99F2E5A6E4F7` |
| `uvdoc.onnx`                | Curved-page unwarping, loaded only when selected | [UVDoc](https://github.com/tanguymagne/UVDoc), MIT; ONNX conversion distributed by `monkt/paddleocr-onnx`, Apache-2.0 | `3F5EC09F1C6C5947AE7CC8DB93ED7DD6DD2D164D3D99A6A70387C98848CFB00C` |
| `rt-focuser-int8-fp16.onnx` | Document deblurring, loaded only when selected   | [RT-Focuser](https://github.com/ReaganWu/RT-Focuser), MIT                                                             | `1943FA1F7DCA041583D237BA66E7C89A272D3582B87F1B71DD143E84FF993D0E` |

The classifier is a routing aid, not a quality guarantee. Finger and moiré detections currently
produce honest retake/limitation warnings; they do not fabricate hidden content.
