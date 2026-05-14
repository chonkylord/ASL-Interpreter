# ASL Interpreter

takes ASL from a webcam or video file, detects the signs, translates them into a sentence, and reads it out loud. the frontend is done. it needs a backend.

---

## pipeline

1. **Record** — webcam or uploaded video
2. **Detect** — fingerpose reads the hand landmarks and returns signs
3. **Translate** — openrouter turns the signs into a natural sentence
4. **Speak** — TTS reads it out

---

## project structure

```
ASL Interpreter/
├── index.html    ← page layout and all the elements
├── styles.css    ← styles, dark theme, animated background blobs
└── app.js        ← handles recording, the pipeline, and all UI state
```

**app.js quick notes:**
- `state` — holds recording status, selected voice, last translated text, etc
- `els` — cached DOM references
- `runPipeline()` — the main function, calls detect → translate → speak in order
- `window.aslBackend` — the object the frontend calls into. you need to provide this

---

## connecting the backend

create a `backend.js` file and add it to `index.html` before `app.js`:

```html
<script src="backend.js"></script>
<script src="app.js"></script>
```

the file needs to set `window.aslBackend` with these 3 methods:

```js
window.aslBackend = {
  detectGestures: async function() {
    // run fingerpose on the video, return detected signs
    return {
      confidence: 0.87,        // 0 to 1
      symbols: [
        { label: "HELLO", emoji: "👋" },
        { label: "WORLD", emoji: "🌍" },
      ]
    };
  },

  interpret: async function(symbols, options) {
    // symbols = array from detectGestures
    // options.tone = "warm" | "neutral" | "formal"
    // call openrouter here
    return {
      text: "Hello world."
    };
  },

  synthesize: async function(text, options) {
    // text = translated sentence
    // options.voice = "nova" | "rio" | "ash" | "june"
    // do TTS here
    return {
      duration: 3.2    // seconds
    };
  }
};
```

if any of those 3 methods are missing, the app will show an error and stop.

---

## fingerpose

fingerpose is a js library that matches hand keypoints to gestures. you need mediapipe hands or tensorflow handpose to get the keypoints first, then pass them into fingerpose.

steps:
1. load mediapipe/tensorflow handpose
2. grab frames from `document.querySelector("#camera")`
3. get keypoints → run through fingerpose → map to ASL label + emoji
4. return from `detectGestures()`

---

## openrouter

openrouter is one API that routes to a bunch of different AI models. use it in `interpret()` to build a sentence from the detected signs.

example prompt:
```
You are an ASL interpreter. Convert these signs into a natural english sentence.
Signs: HELLO, MY, NAME, IS
Tone: warm
```

use `options.tone` to adjust the prompt. don't hardcode your API key — put it in a config file that's gitignored.

---

## setup

1. clone the repo
2. open `index.html` with live server
3. create `backend.js` with the `window.aslBackend` object
4. implement the 3 methods
