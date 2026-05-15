# ASL Interpreter

A browser-based ASL demo that records webcam or uploaded video, detects signing, translates the detected gloss sequence into English, and speaks the result.

---

## What this repo is for

This repo is set up for a future-proof demo where inference happens on a hosted service, not on the demo PC.

- The browser app handles capture, UI, upload, playback, and TTS orchestration.
- `backend.js` extracts MediaPipe landmarks, builds hand crops, and calls a hosted model endpoint.
- `asl_service.py` is a deployable FastAPI inference service you can host on a VM, container platform, or other server.
- `OpenRouter` is used to turn gloss tokens into a natural English sentence.
- `OpenAI` TTS is used when configured, with browser speech as fallback.

---

## Project Structure

```text
ASL Interpreter/
|-- index.html       page layout and script loading
|-- styles.css       visual styling
|-- app.js           UI state, recording flow, upload flow, playback
|-- backend.js       MediaPipe tracking, model-service calls, translation, TTS
|-- asl_service.py   deployable pretrained ASL inference service
|-- config.example.js
`-- config.js        local secrets and hosted service URL, gitignored
```

---

## Runtime Flow

1. The browser captures webcam video or loads an uploaded clip.
2. MediaPipe tracks hand landmarks in the browser.
3. The browser crops the hand region and sends it to the hosted ASL inference service.
4. The service returns a predicted label and confidence.
5. The browser converts the detected symbols into gloss tokens.
6. OpenRouter rewrites the gloss tokens into a natural English sentence.
7. The app speaks the sentence with OpenAI TTS or browser speech fallback.

---

## Config

Copy `config.example.js` to `config.js` and fill in your values:

```js
const CONFIG = {
  OPENROUTER_API_KEY: "YOUR_OPENROUTER_KEY_HERE",
  OPENAI_API_KEY: "YOUR_OPENAI_KEY_HERE",
  MODEL_SERVICE_URL: "https://asl-model.yourdomain.com",
};
```

`MODEL_SERVICE_URL` should point to the hosted inference service that serves `/health` and `/predict`.

---

## Hosted Inference Service

The repo includes `asl_service.py`, a deployable FastAPI service. It is designed to be hosted remotely so the demo PC does not need to download or run the model locally.

Recommended deployment shape:

- Host `asl_service.py` on a VM, container platform, or GPU-backed server.
- Make sure the service exposes:
  - `GET /health`
  - `POST /predict`
- Set `MODEL_SERVICE_URL` in `config.js` to that public endpoint.
- If you want to avoid any on-demand model download in production, mount a directory containing `best_model.pth` and `class_mapping.json`, then set `MODEL_DIR` for the service.
- If you do allow the service to fetch weights during deploy, keep `ALLOW_HF_DOWNLOAD=1` on the hosted machine, not the demo PC.

For local development only, you can still run the service on your own machine if you want, but the app does not depend on that.

---

## Endpoints

### `detectGestures()`

Returns a detected symbol sequence from the current webcam frame or uploaded video.

### `interpret(symbols, options)`

Uses OpenRouter to convert the detected gloss sequence into one English sentence.

### `synthesize(text, options)`

Uses OpenAI TTS when configured, otherwise falls back to browser speech.

### `startLiveDetection()` / `stopLiveDetection()`

Optional live detection hooks used by the recording UI.

---

## Notes

- This is a no-training pipeline.
- The recognizer is strongest when backed by a real pretrained inference service.
- The browser-side MediaPipe tracking is only used to extract useful hand crops and timing context.
- Keep `config.js` out of version control.
