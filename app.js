// Main UI controller for the page.
(function () {
  // Small utilities shared across the UI.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const fmtTime = (seconds) => {
    seconds = Math.max(0, Math.floor(seconds));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));

  // Central UI state.
  const state = {
    cameraStream: null,
    recording: false,
    recStartedAt: 0,
    recTimer: null,
    busy: false,
    tone: "warm",
    voice: "nova",
    playing: false,
    playCursor: 0,
    lastText: null,
    lastDuration: 0,
    playTimer: null,
    audioElement: null,  // real Audio element from OpenAI TTS
    liveSymbols: [],     // symbols accumulated during live recording
  };

  // Cached DOM references.
  const els = {
    camera: $("#camera"),
    placeholder: $("#placeholder"),
    recordBtn: $("#recordBtn"),
    recordLabel: $("#recordLabel"),
    resetBtn: $("#resetBtn"),
    uploadInput: $("#uploadInput"),
    recPill: $("#recPill"),
    recTime: $("#recTime"),
    scanning: $("#scanning"),
    steps: {
      record: $('.step[data-step="record"]'),
      detect: $('.step[data-step="detect"]'),
      translate: $('.step[data-step="translate"]'),
      speak: $('.step[data-step="speak"]'),
    },
    gestures: $("#gestures"),
    confLabel: $("#confLabel"),
    bubble: $("#bubble"),
    sentenceText: $("#sentenceText"),
    voiceCard: $("#voiceCard"),
    voiceSel: $("#voiceSel"),
    playBtn: $("#playBtn"),
    waveform: $("#waveform"),
    voiceCur: $("#voiceCur"),
    voiceDur: $("#voiceDur"),
  };

  // Build the waveform once at startup.
  const WAVE_BARS = 36;
  for (let i = 0; i < WAVE_BARS; i++) {
    const bar = document.createElement("span");
    bar.style.height = `${24 + Math.abs(Math.sin(i * 0.6)) * 70}%`;
    els.waveform.appendChild(bar);
  }

  // Update a single step in the progress rail.
  function setStep(name, mode) {
    const el = els.steps[name];
    if (!el) return;
    el.dataset.state = mode;
    const num = el.querySelector(".step-num");
    num.textContent = mode === "done" ? "✓" : ({ record: "1", detect: "2", translate: "3", speak: "4" })[name];
  }

  // Reset the step rail to idle.
  function resetSteps() {
    setStep("record", "idle");
    setStep("detect", "idle");
    setStep("translate", "idle");
    setStep("speak", "idle");
  }

  // Restore the default empty state.
  function setEmptyState(message) {
    els.gestures.innerHTML = `<span class="empty">${escapeHtml(message)}</span>`;
    els.confLabel.textContent = "—";
    els.bubble.classList.remove("is-active", "is-typing");
    els.sentenceText.classList.add("bubble-placeholder");
    els.sentenceText.textContent = "Your translated sentence will appear here.";
    els.voiceCur.textContent = "0:00";
    els.voiceDur.textContent = "0:00";
    els.playBtn.disabled = true;
    els.waveform.querySelectorAll("span").forEach((bar) => bar.classList.remove("on"));
  }

  // Normalize symbols before sending them downstream.
  function normalizeSymbols(symbols) {
    for (const symbol of Array.isArray(symbols) ? symbols : []) {
      if (!symbol || !symbol.label) continue;
      const label = String(symbol.label).trim();
      if (!label) continue;
      symbol.label = label;
    }
    return Array.isArray(symbols) ? symbols.filter((symbol) => symbol && symbol.label) : [];
  }

  // Add a detected sign token to the gestures panel.
  function addLiveSymbol(symbol) {
    const emptyEl = els.gestures.querySelector(".empty");
    if (emptyEl) emptyEl.remove();
    const token = document.createElement("div");
    token.className = "gesture-token";
    token.innerHTML = `<span class="emo">${escapeHtml(symbol.emoji || "✋")}</span><span class="lab">${escapeHtml(symbol.label || "SIGN")}</span>`;
    els.gestures.appendChild(token);
    state.liveSymbols.push(symbol);
    els.confLabel.textContent = `${state.liveSymbols.length} sign${state.liveSymbols.length !== 1 ? "s" : ""}`;
  }

  // start the whole page in a blank-ish state
  resetSteps();
  setEmptyState("No signs yet — record something to begin.");

  // ask for the camera, which is a browser thing and not my thing
  async function startCamera() {
    if (state.cameraStream) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      state.cameraStream = stream;
      els.camera.srcObject = stream;
      els.placeholder.style.display = "none";
      return true;
    } catch (error) {
      els.placeholder.querySelector(".ph-title").textContent = "Camera unavailable";
      els.placeholder.querySelector(".ph-sub").innerHTML =
        "Upload a video or connect the camera when you’re ready.";
      return false;
    }
  }

  // backend guard so the app can fail in a normal way
  async function requireBackend() {
    const backend = window.aslBackend;
    if (!backend) {
      throw new Error("Backend not connected yet.");
    }
    if (typeof backend.detectGestures !== "function" ||
        typeof backend.interpret !== "function" ||
        typeof backend.synthesize !== "function") {
      throw new Error("Backend is missing one or more required methods.");
    }
    return backend;
  }

  // record button logic
  async function onRecordClick() {
    if (state.busy) return;
    if (!state.recording) {
      const cameraReady = await startCamera();
      if (!cameraReady) return;
      state.recording = true;
      state.recStartedAt = Date.now();
      state.liveSymbols = [];
      els.gestures.innerHTML = "";
      els.confLabel.textContent = "—";
      els.recordLabel.textContent = "Stop & translate";
      els.recordBtn.classList.add("is-recording");
      els.recPill.hidden = false;
      setStep("record", "active");
      setStep("detect", "active");
      state.recTimer = setInterval(() => {
        els.recTime.textContent = fmtTime((Date.now() - state.recStartedAt) / 1000);
      }, 200);
      // kick off live detection — symbols appear in the UI as you sign
      if (window.aslBackend?.startLiveDetection) {
        try {
          await window.aslBackend.startLiveDetection(addLiveSymbol);
        } catch (error) {
          console.warn("Live detection could not start, falling back to upload-style scan.", error);
        }
      }
      return;
    }

    // collect whatever was detected, then run the rest of the pipeline
    let liveSymbols = [];
    if (window.aslBackend?.stopLiveDetection) {
      liveSymbols = normalizeSymbols(window.aslBackend.stopLiveDetection());
    }
    stopRecording();
    await runPipeline(liveSymbols);
  }

  // stop recording and put the ui back
  function stopRecording() {
    state.recording = false;
    clearInterval(state.recTimer);
    els.recPill.hidden = true;
    els.recTime.textContent = "0:00";
    els.recordLabel.textContent = "Start recording";
    els.recordBtn.classList.remove("is-recording");
    setStep("record", "done");
  }

  // the full detect -> translate -> speak flow
  // preDetectedSymbols comes from the live recording loop; empty array triggers upload fallback
  async function runPipeline(preDetectedSymbols) {
    state.busy = true;
    els.recordBtn.disabled = true;

    try {
      const backend = await requireBackend();

      let symbols = normalizeSymbols(preDetectedSymbols);

      if (symbols.length === 0) {
        // upload / fallback path: scan the current video frame
        setStep("detect", "active");
        els.scanning.hidden = false;
        els.gestures.innerHTML = "";
        await sleep(800);

        const det = await backend.detectGestures();
        els.scanning.hidden = true;

        const confidence = Number.isFinite(det?.confidence) ? Math.round(det.confidence * 100) : null;
        els.confLabel.textContent = confidence == null ? "Unknown confidence" : `${confidence}% confidence`;

        symbols = normalizeSymbols(det?.symbols);

        for (let i = 0; i < symbols.length; i++) {
          const symbol = symbols[i];
          const token = document.createElement("div");
          token.className = "gesture-token";
          token.style.animationDelay = `${i * 70}ms`;
          token.innerHTML = `<span class="emo">${escapeHtml(symbol.emoji || "✋")}</span><span class="lab">${escapeHtml(symbol.label || "SIGN")}</span>`;
          els.gestures.appendChild(token);
          await sleep(140);
        }
      }
      // live path: symbols already rendered by addLiveSymbol — just lock in the step
      setStep("detect", "done");

      if (!symbols.length) {
        throw new Error("No signs detected — try signing closer to the camera.");
      }

      // translation
      setStep("translate", "active");
      els.bubble.classList.add("is-active", "is-typing");
      els.sentenceText.classList.remove("bubble-placeholder");
      els.sentenceText.textContent = "";

      const ai = await backend.interpret(symbols, { tone: state.tone });
      const target = String(ai?.text || "").trim();
      if (!target) throw new Error("Translation came back empty.");

      for (let i = 0; i <= target.length; i++) {
        els.sentenceText.textContent = target.slice(0, i);
        await sleep(18);
      }
      els.bubble.classList.remove("is-typing");
      state.lastText = target;
      setStep("translate", "done");

      // voice synthesis
      setStep("speak", "active");
      const tts = await backend.synthesize(target, { voice: state.voice });

      // wire up real audio element if OpenAI TTS returned a blob URL
      if (tts?.audioUrl) {
        if (state.audioElement) {
          state.audioElement.pause();
          URL.revokeObjectURL(state.audioElement.src);
        }
        state.audioElement = new Audio(tts.audioUrl);
        state.audioElement.addEventListener("ended", stopPlaying);
        state.audioElement.addEventListener("timeupdate", () => {
          if (state.audioElement) {
            els.voiceCur.textContent = fmtTime(state.audioElement.currentTime);
          }
        });
      } else {
        state.audioElement = null;
      }

      state.lastDuration = Number(tts?.duration) || 0;
      els.voiceDur.textContent = fmtTime(state.lastDuration);
      lightWaveform(state.lastDuration);
      els.playBtn.disabled = false;
      setStep("speak", "done");

      startPlaying();
    } catch (error) {
      els.scanning.hidden = true;
      setEmptyState(error instanceof Error ? error.message : "Something went wrong.");
      resetSteps();
      els.recordBtn.disabled = false;
    } finally {
      state.busy = false;
      els.recordBtn.disabled = false;
    }
  }

  // light up the waveform bars
  function lightWaveform(duration) {
    const bars = els.waveform.querySelectorAll("span");
    bars.forEach((bar) => bar.classList.remove("on"));
    const active = Math.min(bars.length, Math.max(10, Math.round(duration * 7)));
    bars.forEach((bar, index) => {
      if (index < active) bar.classList.add("on");
    });
  }

  // start playback from the beginning (called automatically after synthesis)
  function startPlaying() {
    stopPlaying();
    if (!state.lastDuration) return;

    state.playing = true;
    state.playCursor = 0;
    els.playBtn.dataset.state = "playing";
    els.voiceCard.dataset.playing = "true";

    if (state.audioElement) {
      // real OpenAI audio
      state.audioElement.currentTime = 0;
      state.audioElement.play().catch(console.error);
    } else {
      // browser speech fallback — use a progress timer since there is no audio element
      const tickMs = 100;
      state.playTimer = setInterval(() => {
        state.playCursor += tickMs / 1000;
        if (state.playCursor >= state.lastDuration) {
          state.playCursor = state.lastDuration;
          els.voiceCur.textContent = fmtTime(state.playCursor);
          stopPlaying();
          return;
        }
        els.voiceCur.textContent = fmtTime(state.playCursor);
      }, tickMs);
    }
  }

  // stop / pause playback and reset button state
  function stopPlaying() {
    state.playing = false;
    if (state.audioElement && !state.audioElement.paused) {
      state.audioElement.pause();
    }
    clearInterval(state.playTimer);
    state.playTimer = null;
    els.playBtn.dataset.state = "paused";
    els.voiceCard.dataset.playing = "false";
  }

  // play / pause toggle wired to the button
  function togglePlay() {
    if (!state.lastText) return;
    if (state.playing) {
      stopPlaying();
    } else {
      state.playing = true;
      els.playBtn.dataset.state = "playing";
      els.voiceCard.dataset.playing = "true";
      if (state.audioElement) {
        state.audioElement.play().catch(console.error);
      } else {
        startPlaying(); // restarts the progress timer for browser speech
      }
    }
  }

  // reset everything back to the beginning
  function fullReset() {
    if (state.recording) {
      if (window.aslBackend?.stopLiveDetection) window.aslBackend.stopLiveDetection();
      stopRecording();
    }
    if (state.audioElement) {
      state.audioElement.pause();
      if (state.audioElement.src.startsWith("blob:")) URL.revokeObjectURL(state.audioElement.src);
      state.audioElement = null;
    }
    state.lastText = null;
    state.lastDuration = 0;
    state.playCursor = 0;
    state.liveSymbols = [];
    stopPlaying();
    resetSteps();
    setEmptyState("No signs yet — record something to begin.");
    els.scanning.hidden = true;
  }

  // upload flow just swaps in the file and reuses the same pipeline (no live symbols)
  async function onUpload(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    els.camera.srcObject = null;
    els.camera.src = url;
    els.camera.loop = false;
    els.camera.muted = true;
    els.camera.play().catch(() => {});
    els.placeholder.style.display = "none";
    setStep("record", "done");
    await runPipeline([]); // empty array triggers the single-frame fallback
  }

  // wiring time
  els.recordBtn.addEventListener("click", onRecordClick);
  els.resetBtn.addEventListener("click", fullReset);
  els.playBtn.addEventListener("click", togglePlay);
  els.uploadInput.addEventListener("change", (event) => onUpload(event.target.files?.[0]));
  els.voiceSel.addEventListener("change", async (event) => {
    state.voice = event.target.value;
    if (!state.lastText || state.busy) return;

    // re-synthesize the existing translation with the newly selected voice
    els.playBtn.disabled = true;
    stopPlaying();
    const backend = window.aslBackend;
    if (!backend) return;
    try {
      const tts = await backend.synthesize(state.lastText, { voice: state.voice });
      if (tts?.audioUrl) {
        if (state.audioElement) {
          state.audioElement.pause();
          URL.revokeObjectURL(state.audioElement.src);
        }
        state.audioElement = new Audio(tts.audioUrl);
        state.audioElement.addEventListener("ended", stopPlaying);
        state.audioElement.addEventListener("timeupdate", () => {
          if (state.audioElement) els.voiceCur.textContent = fmtTime(state.audioElement.currentTime);
        });
      } else {
        state.audioElement = null;
      }
      state.lastDuration = Number(tts?.duration) || 0;
      els.voiceDur.textContent = fmtTime(state.lastDuration);
      lightWaveform(state.lastDuration);
      els.playBtn.disabled = false;
      startPlaying();
    } catch (_) {
      els.playBtn.disabled = false;
    }
  });

  // tone buttons only change the vibe
  $$(".tone").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".tone").forEach((item) => item.classList.remove("is-active"));
      button.classList.add("is-active");
      state.tone = button.dataset.tone;
    });
  });
})();
