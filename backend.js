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
    if (!CONFIG?.OPENROUTER_API_KEY || CONFIG.OPENROUTER_API_KEY === "YOUR_API_KEY_HERE") {
      return { text: "err: missing api key in config.js" };
    }

    const signsList = symbols.map(s => s.label).join(", ");
    const prompt = `You are a casual translation assistant. 
Convert the following sequence of ASL glosses/signs into quick, casual conversational slang. 
Do not use stiff, overly formal grammar, and avoid long drawn-out sentences. 
Keep it extremely brief, clear cut, and make it sound like a real person casually texting or talking.
Example tone: ${options.tone || 'neutral'}.

Only reply with the translated phrase. No quotes, no explanations, no AI-speak. Just the words.

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

  // hit the browser's built-in text to speech API
  synthesize: async function (text, options) {
    return new Promise((res) => {
      if (!('speechSynthesis' in window)) {
        res({ duration: 0 });
        return;
      }

      window.speechSynthesis.cancel();

      const utter = new SpeechSynthesisUtterance(text);

      // slightly tweak pitch/rate for the different voices
      switch (options.voice) {
        case 'nova': utter.pitch = 1.2; utter.rate = 1.0; break;
        case 'rio': utter.pitch = 0.8; utter.rate = 0.9; break;
        case 'ash': utter.pitch = 0.9; utter.rate = 0.85; break;
        case 'june': utter.pitch = 1.6; utter.rate = 1.1; break;
        default: utter.pitch = 1.0; utter.rate = 1.0;
      }

      let start = 0;
      utter.onstart = () => start = Date.now();
      utter.onend = () => res({ duration: (Date.now() - start) / 1000 });
      utter.onerror = () => res({ duration: 0 });

      window.speechSynthesis.speak(utter);
    });
  }
};
