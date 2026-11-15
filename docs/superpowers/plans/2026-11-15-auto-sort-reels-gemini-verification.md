# Gemini auto-sort API verification

Verified 2026-11-15 before implementing Task 4. Sources were fetched from Google's official documentation and the official JavaScript SDK repository; no API requests or real credentials were used.

| Requirement | Verified setting for `models.generateContent` |
| --- | --- |
| Stable model ID | `gemini-3.5-flash-lite` |
| Low media resolution | `config.mediaResolution: 'MEDIA_RESOLUTION_LOW'` (`MediaResolution.MEDIA_RESOLUTION_LOW`) |
| Video sampling | The same content part as `inlineData` or `fileData` carries `videoMetadata: { fps: 1 }`. The SDK documents a valid range of `(0, 24]` and a default of 1 fps. |
| JSON output | `config.responseMimeType: 'application/json'` together with `config.responseJsonSchema` for JSON Schema, or alternatively `config.responseSchema` for the SDK's Schema/OpenAPI subset. These schema settings are mutually exclusive. |
| Lowest supported thinking | `config.thinkingConfig: { thinkingLevel: 'MINIMAL' }` (`ThinkingLevel.MINIMAL`). The model supports minimal/low/medium/high; minimal is its default. |
| Usage | `response.usageMetadata.promptTokenCount` and `response.usageMetadata.candidatesTokenCount`. |

The classification schema requires exactly `type`, `confidence`, `description`, and `suggested_type`. The JavaScript field names use camelCase even where REST documentation uses snake_case. No `temperature`, `topP`, or `topK` setting is needed: Google's migration guide deprecates those parameters starting with this model.

Official sources:

- [Gemini 3.5 Flash-Lite model reference](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite): stable model ID, video input, structured output, and thinking support.
- [Gemini 3.6 / 3.5 Flash-Lite guide](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.6): model table, minimal thinking default, migration guidance for classification, parameter deprecations, and $0.30 input / $2.50 output per million tokens.
- [Thinking guide](https://ai.google.dev/gemini-api/docs/thinking): model support table explicitly lists `gemini-3.5-flash-lite` with minimal, low, medium, and high.
- [Media resolution guide](https://ai.google.dev/gemini-api/docs/media-resolution): low resolution reduces input tokens and cost.
- [Video understanding guide](https://ai.google.dev/gemini-api/docs/video-understanding): static video sampling and frame-rate controls.
- [Official JavaScript SDK README](https://github.com/googleapis/js-genai/blob/main/README.md): package `@google/genai`, `GoogleGenAI`, and `models.generateContent` API.
- [Official JavaScript SDK types](https://github.com/googleapis/js-genai/blob/main/src/types.ts): exact `GenerateContentConfig`, `Part.videoMetadata`, `VideoMetadata.fps`, `MediaResolution`, `ThinkingConfig`, `ThinkingLevel`, schema-output, and usage metadata fields.

The README provides the API entry points; the exported SDK types provide the detailed configuration spellings. Installation resolved `@google/genai` **3.3.0**. The installed `server/node_modules/@google/genai/dist/genai.d.ts` was inspected and confirms the same `GenerateContentConfig`, `Part.videoMetadata`, `VideoMetadata.fps`, `MediaResolution.MEDIA_RESOLUTION_LOW`, and `ThinkingLevel.MINIMAL` fields and values.
