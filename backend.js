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

  // send signs to openrouter to get a real sentence back
  interpret: async function (symbols, options) {

    const signsList = symbols.map(s => s.label).join(", ");

    const prompt = `You are an expert ASL to English translator. 
Convert the following sequence of ASL glosses/signs into a natural, grammatically correct English sentence.
Required tone of the sentence: ${options.tone || 'neutral'}.
Only reply with the final translated sentence. Do not include quotes, explanations, or any other wrapper text.

Signs: ${signsList}`;

    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "meta-llama/llama-3.1-8b-instruct:free",
          messages: [{ role: "user", content: prompt }]
        })
      });

      const data = await res.json();

      if (data?.choices?.[0]?.message) {
        return { text: data.choices[0].message.content.trim() };
      }
      throw new Error("bad output");

    } catch (err) {
      console.error("translation req failed:", err);
      return { text: "api error, check console" };
    }
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
