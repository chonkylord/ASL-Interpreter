# Deployment Guide

This project is split into two parts:

- **Vercel** hosts the browser app
- **Hugging Face Spaces** hosts the ASL inference service

The browser app keeps the webcam/upload UI, calls the hosted model service, then sends the detected glosses to OpenRouter and OpenAI TTS.

---

## What Runs Where

### Vercel

Deploy the frontend from this repo:

- `index.html`
- `styles.css`
- `app.js`
- `backend.js`

### Hugging Face Spaces

Deploy the model service from:

- `asl_service.py`

The Space should expose:

- `GET /health`
- `POST /predict`

---

## Exact Model Stack

- **Hand tracking:** MediaPipe HandLandmarker
- **ASL classifier:** `huzaifanasirrr/realtime-sign-language-translator`
  - `best_model.pth`
  - `class_mapping.json`
- **Sentence cleanup:** OpenRouter chat models
- **Voice output:** OpenAI `tts-1`

---

## Hugging Face Space Setup

1. Create a new Hugging Face Space.
2. Choose **Docker** as the SDK.
3. Set the app port to `7860`.
4. Add `asl_service.py` to the Space repo.
5. Provide the pretrained model files:
   - `best_model.pth`
   - `class_mapping.json`
6. Choose one of these model-loading options:
   - Set `MODEL_DIR` to a mounted folder containing the model files
   - Or allow the Space machine to fetch the files by keeping `ALLOW_HF_DOWNLOAD=1`
7. Push the Space and confirm the endpoints work:
   - `GET /health`
   - `POST /predict`

---

## Vercel Setup

1. Push this repo to GitHub.
2. Import the GitHub repo into Vercel.
3. Let Vercel deploy the static frontend.
4. In your local `config.js`, set:

```js
const CONFIG = {
  OPENROUTER_API_KEY: "YOUR_OPENROUTER_KEY_HERE",
  OPENAI_API_KEY: "YOUR_OPENAI_KEY_HERE",
  MODEL_SERVICE_URL: "https://your-space-url.hf.space",
};
```

`MODEL_SERVICE_URL` must point to the Hugging Face Space URL.

---

## Local Config

Keep `config.js` out of Git. It should contain:

- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`
- `MODEL_SERVICE_URL`

Do not commit real secrets.

---

## End-to-End Flow

1. User opens the app on Vercel.
2. Browser gets webcam input or uploaded video.
3. MediaPipe finds hand landmarks in the browser.
4. The browser crops the hand region.
5. The crop is sent to the Hugging Face Space.
6. The Space returns a label and confidence.
7. `backend.js` turns the labels into gloss tokens.
8. OpenRouter turns the gloss tokens into a sentence.
9. OpenAI TTS speaks the sentence.

---

## Quick Test Checklist

- Webcam opens
- Upload works
- Space `/health` responds
- Space `/predict` returns a label
- Translation returns a sentence
- TTS plays audio

