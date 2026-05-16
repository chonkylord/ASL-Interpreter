window.aslBackend = {

  // fake the gesture stuff for now until @ is done
  detectGestures: async function () {
    console.log("mocking gesture detection...");
    return new Promise(res => {
      setTimeout(() => {
        res({
          confidence: 0.95,
          symbols: [
            { label: "STORE", emoji: "🏪" },
            { label: "I", emoji: "🙋" },
            { label: "GO", emoji: "🚶" }
          ]
        });
      }, 1500);
    });
  },

  interpret: async function (symbols, options) {
    if (!CONFIG?.OPENROUTER_API_KEY || CONFIG.OPENROUTER_API_KEY === "openrouter_key") {
      return { text: "err: missing api key in config.js" };
    }

    const signsList = symbols.map(s => s.label).join(", ");
    const prompt = `You are an expert ASL to English translator. 
Convert the following sequence of ASL glosses/signs into a natural, grammatically correct English sentence.
Required tone of the sentence: ${options.tone || 'neutral'}.
Only reply with the final translated sentence. Do not include quotes, explanations, or any other wrapper text.

Signs: ${signsList}`;

    // fallback models in case openrouter is busy
    const models = [
      "google/gemma-4-31b-it:free",
      "meta-llama/llama-3.2-3b-instruct:free",
      "google/gemma-4-26b-a4b-it:free",
      "deepseek/deepseek-chat:free",
      "openrouter/auto"
    ];

    for (const model of models) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://127.0.0.1:5500",
            "X-Title": "ASL Interpreter"
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "user", content: prompt }]
          })
        });

        const data = await res.json();

        if (!data.error && data?.choices?.[0]?.message) {
          return { text: data.choices[0].message.content.trim() };
        }

      } catch (err) {
        // silently fail and try the next model
        console.warn(`model ${model} failed, trying next...`);
      }
    }

    // if all of them fail
    return { text: "err: all providers are busy or your openrouter account isn't verified." };
  },

  // using elevenlabs api for audio
  synthesize: async function (text, options) {
    return new Promise(async (res) => {
      if (!CONFIG?.ELEVENLABS_API_KEY || CONFIG.ELEVENLABS_API_KEY === "elevenlabs_key") {
        console.warn("missing elevenlabs api key");
        return res({ duration: 0 });
      }

      // Voice mapping
      let voiceId = "Xb7hH8MSUJpSbSDYk0k2"; // default to Alice
      switch (options.voice) {
        case 'alice': voiceId = "Xb7hH8MSUJpSbSDYk0k2"; break; // Alice
        case 'adam': voiceId = "pNInz6obpgDQGcFmaJgB"; break; // Adam
        case 'bill': voiceId = "pqHfZKP75CvOlQylNhV4"; break; // Bill
        case 'lily': voiceId = "pFZP5JQG7iQjIQuC4Bku"; break; // Lily
      }

      try {
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: "POST",
          headers: {
            "Accept": "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": CONFIG.ELEVENLABS_API_KEY
          },
          body: JSON.stringify({
            text: text,
            model_id: "eleven_multilingual_v2", // latest standard free tier model
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75
            }
          })
        });

        if (!response.ok) {
          throw new Error("ElevenLabs API failed. Check API key or quota.");
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);

        // save globally so app.js play button can hit it again
        window.lastAudio = audio;

        // wait for the audio to load just enough to get the exact duration
        audio.addEventListener('loadedmetadata', () => {
          audio.play(); // blast it out loud
          res({ duration: audio.duration }); // tell the UI how long it is
        });

      } catch (err) {
        console.error("tts err:", err);
        res({ duration: 0 });
      }
    });
  }
};
