(function () {
  let handLandmarker = null;
  let mpReady = false;
  let mpInitPromise = null;

  const MODEL_SERVICE_URL = (typeof CONFIG !== "undefined" && CONFIG?.MODEL_SERVICE_URL)
    ? String(CONFIG.MODEL_SERVICE_URL).replace(/\/+$/, "")
    : "";

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  async function ensureMediaPipe() {
    if (mpReady) return;
    if (!mpInitPromise) {
      mpInitPromise = (async () => {
        const { HandLandmarker, FilesetResolver } = await import(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs"
        );
        const fs = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
        );
        const baseOptions = {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU",
        };
        try {
          handLandmarker = await HandLandmarker.createFromOptions(fs, {
            baseOptions,
            runningMode: "VIDEO",
            numHands: 2,
          });
        } catch (_) {
          handLandmarker = await HandLandmarker.createFromOptions(fs, {
            baseOptions: { ...baseOptions, delegate: "CPU" },
            runningMode: "VIDEO",
            numHands: 2,
          });
        }
        mpReady = true;
      })();
    }
    return mpInitPromise;
  }

  function cropCanvasForVideo(video, bbox) {
    const vw = video?.videoWidth || 0;
    const vh = video?.videoHeight || 0;
    if (!vw || !vh || !bbox) return null;

    const x = Math.floor(bbox.xMin * vw);
    const y = Math.floor(bbox.yMin * vh);
    const w = Math.max(1, Math.floor((bbox.xMax - bbox.xMin) * vw));
    const h = Math.max(1, Math.floor((bbox.yMax - bbox.yMin) * vh));

    const canvas = document.createElement("canvas");
    canvas.width = 224;
    canvas.height = 224;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    try {
      ctx.drawImage(video, x, y, w, h, 0, 0, 224, 224);
      return canvas.toDataURL("image/jpeg", 0.92);
    } catch (_) {
      return null;
    }
  }

  function frameHands(video) {
    if (!video || video.readyState < 2 || !handLandmarker) return [];
    const result = handLandmarker.detectForVideo(video, performance.now());
    const landmarks = result?.landmarks || [];
    return landmarks.map((lm, index) => {
      const xs = lm.map((p) => p.x);
      const ys = lm.map((p) => p.y);
      const xMin = Math.min(...xs);
      const xMax = Math.max(...xs);
      const yMin = Math.min(...ys);
      const yMax = Math.max(...ys);
      const pad = Math.max(xMax - xMin, yMax - yMin) * 0.28;
      const bbox = {
        xMin: clamp(xMin - pad, 0, 1),
        yMin: clamp(yMin - pad, 0, 1),
        xMax: clamp(xMax + pad, 0, 1),
        yMax: clamp(yMax + pad, 0, 1),
      };
      return {
        lm,
        bbox,
        handedness: result?.handednesses?.[index]?.[0]?.categoryName || null,
        area: (bbox.xMax - bbox.xMin) * (bbox.yMax - bbox.yMin),
      };
    });
  }

  function bestHand(hands) {
    if (!hands.length) return null;
    return hands.reduce((best, hand) => (hand.area > (best?.area ?? -1) ? hand : best), null);
  }

  const LABEL_EMOJI = {
    A: "✊", B: "🖐️", C: "🫳", D: "☝️", E: "✋", F: "👌", G: "👉", H: "🤞", I: "🤙",
    J: "🫱", K: "🖖", L: "👆", M: "✊", N: "✊", O: "👌", P: "👇", Q: "👇", R: "🤞",
    S: "✊", T: "✊", U: "🤞", V: "✌️", W: "🖖", X: "☝️", Y: "🤙", Z: "✍️",
    1: "☝️", 2: "✌️", 3: "3️⃣", 4: "🖐️", 5: "🖐️",
    HELLO: "👋", YES: "✅", NO: "❌", HELP: "🫶", SORRY: "🫶", PLEASE: "🙏", THANKYOU: "🙏", "THANK-YOU": "🙏",
    STOP: "✋", COME: "🤚", ILY: "🤟", UNKNOWN: "✋",
  };

  function normalizeLabel(label) {
    const value = String(label || "").trim().toUpperCase();
    return value || null;
  }

  function makeSymbol(label, confidence = 0.8, source = "model") {
    const value = normalizeLabel(label);
    if (!value) return null;
    return {
      label: value,
      emoji: LABEL_EMOJI[value] || "✋",
      confidence,
      source,
    };
  }

  function symbolToToken(symbol) {
    const label = normalizeLabel(symbol?.label);
    if (!label) return null;
    return label === "THANK-YOU" || label === "THANKYOU" ? "THANK YOU" : label;
  }

  function buildGlossTokens(symbols) {
    return (Array.isArray(symbols) ? symbols : []).map(symbolToToken).filter(Boolean);
  }

  let modelServiceHealthy = null;
  async function ensureModelService() {
    if (!MODEL_SERVICE_URL) return false;
    if (modelServiceHealthy === true) return true;
    if (modelServiceHealthy === false) return false;
    try {
      const res = await fetch(`${MODEL_SERVICE_URL}/health`);
      modelServiceHealthy = res.ok;
      return modelServiceHealthy;
    } catch (_) {
      modelServiceHealthy = false;
      return false;
    }
  }

  async function predictFromModel(video, hand) {
    if (!hand) return null;
    if (!(await ensureModelService())) return predictFromVision(video, hand);

    const image = cropCanvasForVideo(video, hand.bbox);
    if (!image) return null;

    try {
      const res = await fetch(`${MODEL_SERVICE_URL}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return makeSymbol(data?.label, Number(data?.confidence) || 0.8, "model");
    } catch (error) {
      console.warn("Model service failed:", error.message);
      modelServiceHealthy = false;
      return predictFromVision(video, hand);
    }
  }

  async function predictFromVision(video, hand) {
    const image = cropCanvasForVideo(video, hand?.bbox);
    if (!image || !CONFIG?.OPENAI_API_KEY || CONFIG.OPENAI_API_KEY.startsWith("YOUR_")) return null;

    const prompt = "Return the most likely ASL label for this cropped hand image. Output one label only.";
    for (const model of ["gpt-4o-mini", "gpt-4o"]) {
      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${CONFIG.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model,
            messages: [{
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: image } },
              ],
            }],
            max_tokens: 8,
          }),
        });
        const data = await res.json();
        const raw = String(data?.choices?.[0]?.message?.content || "").trim();
        const label = normalizeLabel(raw.split(/\s+/)[0]);
        return makeSymbol(label, 0.75, "vision");
      } catch (_) {}
    }
    return null;
  }

  async function gatherSymbols(video, frames, delayMs) {
    const symbols = [];
    let last = null;
    let hold = 0;

    for (let i = 0; i < frames; i++) {
      const hands = frameHands(video);
      const hand = bestHand(hands);
      if (hand) {
        const symbol = await predictFromModel(video, hand);
        if (symbol?.label) {
          if (symbol.label === last) {
            hold += 1;
          } else {
            last = symbol.label;
            hold = 1;
          }
          if (hold >= 2 && symbols[symbols.length - 1]?.label !== symbol.label) {
            symbols.push(symbol);
          }
        } else {
          last = null;
          hold = 0;
        }
      } else {
        last = null;
        hold = 0;
      }

      if (i < frames - 1) await wait(delayMs);
    }

    return symbols;
  }

  async function startLiveDetection(onSymbol) {
    await ensureMediaPipe();
    detecting = true;
    onSymbolCb = onSymbol;
    symbolBuf.length = 0;
    liveFrameBusy = false;
    holdCount = 0;
    lastSeenLabel = null;
    lastLivePredictionAt = 0;
    if (detecting) detectFrame();
  }

  async function detectFrame() {
    if (!detecting || liveFrameBusy) return;
    liveFrameBusy = true;

    try {
      const video = document.querySelector("#camera");
      const hand = bestHand(frameHands(video));
      if (hand && Date.now() - lastLivePredictionAt > 150) {
        lastLivePredictionAt = Date.now();
        const symbol = await predictFromModel(video, hand);
        if (symbol?.label) {
          if (symbol.label === lastSeenLabel) {
            holdCount += 1;
          } else {
            lastSeenLabel = symbol.label;
            holdCount = 1;
          }
          if (holdCount >= 2) {
            if (symbolBuf[symbolBuf.length - 1]?.label !== symbol.label) {
              symbolBuf.push(symbol);
              onSymbolCb?.(symbol);
            }
          }
        } else {
          lastSeenLabel = null;
          holdCount = 0;
        }
      }
    } catch (_) {}

    liveFrameBusy = false;
    if (detecting) requestAnimationFrame(detectFrame);
  }

  function stopLiveDetection() {
    detecting = false;
    onSymbolCb = null;
    return [...symbolBuf];
  }

  async function detectGestures() {
    await ensureMediaPipe();
    const video = document.querySelector("#camera");
    if (!video || video.readyState < 2) return { confidence: 0, symbols: [] };
    const frames = Number.isFinite(video.duration) && video.duration > 1.5 ? Math.min(240, Math.max(24, Math.ceil(video.duration * 8))) : 12;
    const delay = Number.isFinite(video.duration) && video.duration > 1.5 ? 110 : 35;
    const symbols = await gatherSymbols(video, frames, delay);
    return {
      confidence: symbols.length ? clamp(0.55 + symbols.length * 0.05, 0, 0.95) : 0,
      symbols,
    };
  }

  async function interpret(symbols, options) {
    if (!CONFIG?.OPENROUTER_API_KEY || CONFIG.OPENROUTER_API_KEY.startsWith("YOUR_")) {
      return { text: "err: add your OPENROUTER_API_KEY to config.js" };
    }

    const glossTokens = buildGlossTokens(symbols);
    if (!glossTokens.length) return { text: "err: no gloss tokens were detected." };

    const prompt =
      `Turn this ASL gloss sequence into one natural English sentence.\n` +
      `Gloss tokens: ${JSON.stringify(glossTokens)}\n` +
      `Tone: ${(options && options.tone) || "warm"}\n` +
      `Return only the sentence.`;

    for (const model of [
      "google/gemma-4-31b-it:free",
      "meta-llama/llama-3.2-3b-instruct:free",
      "deepseek/deepseek-chat:free",
      "openrouter/auto",
    ]) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://127.0.0.1:5500",
            "X-Title": "ASL Interpreter",
          },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
        });
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text) return { text };
      } catch (_) {}
    }

    return { text: "err: all OpenRouter providers failed." };
  }

  async function synthesize(text, options) {
    if (CONFIG?.OPENAI_API_KEY && !CONFIG.OPENAI_API_KEY.startsWith("YOUR_")) {
      const voice = { nova: "nova", rio: "echo", ash: "onyx", june: "shimmer" }[options?.voice] || "nova";
      try {
        const res = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${CONFIG.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: "tts-1", input: text, voice, response_format: "mp3" }),
        });
        if (!res.ok) throw new Error(`OpenAI TTS HTTP ${res.status}`);
        const blob = await res.blob();
        const audioUrl = URL.createObjectURL(blob);
        const duration = await new Promise((resolve) => {
          const audio = new Audio(audioUrl);
          audio.addEventListener("loadedmetadata", () => resolve(audio.duration));
          audio.addEventListener("error", () => resolve(0));
          audio.load();
        });
        return { duration, audioUrl };
      } catch (err) {
        console.warn("OpenAI TTS failed, using browser speech:", err.message);
      }
    }

    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) {
        resolve({ duration: 0, audioUrl: null });
        return;
      }
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      if (options?.voice === "nova") { utter.pitch = 1.2; utter.rate = 1.0; }
      if (options?.voice === "rio") { utter.pitch = 0.8; utter.rate = 0.9; }
      if (options?.voice === "ash") { utter.pitch = 0.9; utter.rate = 0.85; }
      if (options?.voice === "june") { utter.pitch = 1.6; utter.rate = 1.1; }
      let start = 0;
      utter.onstart = () => { start = Date.now(); };
      utter.onend = () => resolve({ duration: (Date.now() - start) / 1000, audioUrl: null });
      utter.onerror = () => resolve({ duration: 0, audioUrl: null });
      window.speechSynthesis.speak(utter);
    });
  }

  let detecting = false;
  let onSymbolCb = null;
  const symbolBuf = [];
  let holdCount = 0;
  let lastSeenLabel = null;
  let lastLivePredictionAt = 0;
  let liveFrameBusy = false;

  window.aslBackend = {
    startLiveDetection,
    stopLiveDetection,
    detectGestures,
    interpret,
    synthesize,
  };

  ensureMediaPipe().catch(() => {});
})();
