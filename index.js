const express = require("express");
const { createClient, AgentEvents } = require("@deepgram/sdk");
require("dotenv").config();

if (!process.env.DEEPGRAM_API_KEY) {
  throw new Error("DEEPGRAM_API_KEY is not set");
}

const app = express();
const SAMPLE_RATE = Number(process.env.DEEPGRAM_SAMPLE_RATE || 8000);

// Agent system prompt
const AGENT_PROMPT = `You are a general-purpose virtual assistant speaking to users over the phone. Your task is to help them find accurate, helpful information across a wide range of everyday topics.

Guidelines:
- Be warm, friendly, and professional.
- Speak clearly and naturally in plain language.
- Keep most responses to 1–2 sentences and under 120 characters unless the caller asks for more detail (max: 300 characters).
- Do not use markdown formatting, like code blocks, quotes, bold, links, or italics.
- Use line breaks in lists.
- Use varied phrasing; avoid repetition.
- If unclear, ask for clarification.
- If the user's message is empty, respond with an empty message.
- If asked about your well-being, respond briefly and kindly.

Voice Instructions:
- Speak in a conversational tone—your responses will be spoken aloud.
- Pause after questions to allow for replies.
- Confirm what the customer said if uncertain.
- Never interrupt.

Style:
- Use active listening cues.
- Be warm and understanding, but concise.
- Use simple words unless the caller uses technical terms.

Call Flow:
- Greet the caller and introduce yourself: "Hi there, I'm your virtual assistant—how can I help today?"
- Your primary goal is to help users quickly find the information they're looking for. This may include:
  * Quick facts: "The capital of Japan is Tokyo."
  * Weather: "It's currently 68 degrees and cloudy in Seattle."
  * Local info: "There's a pharmacy nearby open until 9 PM."
  * Basic how-to guidance: "To restart your phone, hold the power button for 5 seconds."
  * FAQs: "Most returns are accepted within 30 days with a receipt."
  * Navigation help: "Can you tell me the address or place you're trying to reach?"
- If the request is unclear: "Just to confirm, did you mean…?" or "Can you tell me a bit more?"
- If the request is out of scope (e.g. legal, financial, or medical advice): "I'm not able to provide advice on that, but I can help you find someone who can."

Off-Scope Handling:
- If asked about sensitive topics like health, legal, or financial matters: "I'm not qualified to answer that, but I recommend reaching out to a licensed professional."

User Considerations:
- Callers may be in a rush, distracted, or unsure how to phrase their question. Stay calm, helpful, and clear—especially when the user seems stressed, confused, or overwhelmed.

Closing:
- Always ask: "Is there anything else I can help you with today?"
- Then thank them warmly and say: "Thanks for calling. Take care and have a great day!"`;

function createDeepgramAgentConnection() {
  return createClient(process.env.DEEPGRAM_API_KEY).agent();
}

app.post("/speech-to-speech-stream", async (req, res) => {
  const uuid = req.headers["x-uuid"];
  if (uuid) console.log("Received UUID:", uuid);

  res.setHeader("Content-Type", "application/octet-stream");

  const connection = createDeepgramAgentConnection();
  let keepAliveIntervalId = null;
  let outputChunksQueue = Buffer.alloc(0);
  let isFirstOutputChunk = true;
  let outputStartTime = null;

  function flushOutputBuffer() {
    if (outputChunksQueue.length) {
      try {
        res.write(outputChunksQueue);
      } catch (_) {}
      outputChunksQueue = Buffer.alloc(0);
    }
    isFirstOutputChunk = true;
    outputStartTime = null;
  }

  function cleanup() {
    if (keepAliveIntervalId) clearInterval(keepAliveIntervalId);
    flushOutputBuffer();
    try {
      res.end();
    } catch (_) {}
    try {
      connection.disconnect();
    } catch (_) {
      console.error("Error closing connection:", _);
    }
  }

  connection.on(AgentEvents.Open, () => {
    console.log("Deepgram agent WebSocket opened");
  });

  connection.on(AgentEvents.Welcome, () => {
    console.log("Configuring Deepgram agent...");

    connection.configure({
      audio: {
        input: {
          encoding: "linear16",
          sample_rate: SAMPLE_RATE,
        },
        output: {
          encoding: "linear16",
          sample_rate: SAMPLE_RATE,
          container: "none",
        },
      },
      agent: {
        language: "en",
        listen: {
          provider: {
            type: "deepgram",
            model: process.env.DEEPGRAM_ASR_MODEL || "nova-3",
          },
        },
        think: {
          provider: {
            type: "open_ai",
            model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          },
          prompt: AGENT_PROMPT,
        },
        speak: {
          provider: {
            type: "deepgram",
            model: process.env.DEEPGRAM_TTS_MODEL || "aura-2-thalia-en",
          },
        },
        greeting:
          process.env.DEEPGRAM_GREETING ||
          "Hi there, I'm your virtual assistant—how can I help today?",
      },
    });

    console.log("Deepgram agent configured");

    // Start keep alive
    keepAliveIntervalId = setInterval(() => {
      connection.keepAlive();
    }, 5000);
  });

  connection.on(AgentEvents.ConversationText, (data) => {
    try {
      const payload = typeof data === "string" ? JSON.parse(data) : data;
      if (payload?.message?.final) {
        console.log(
          `${payload.message.role?.toUpperCase?.() || ""}: ${
            payload.message.text || ""
          }`
        );
      }
    } catch (_) {}
  });

  connection.on(AgentEvents.Audio, (data) => {
    const buffer = Buffer.from(data);

    if (isFirstOutputChunk) {
      outputStartTime = Date.now();
      isFirstOutputChunk = false;
    }

    outputChunksQueue = Buffer.concat([outputChunksQueue, buffer]);

    // Flush buffer every 100ms
    if (outputStartTime && Date.now() - outputStartTime >= 100) {
      const toWrite = outputChunksQueue;
      outputChunksQueue = Buffer.alloc(0);
      outputStartTime = Date.now();
      res.write(toWrite);
    }
  });

  connection.on(AgentEvents.AgentAudioDone, () => {
    flushOutputBuffer();
  });

  connection.on(AgentEvents.Error, (err) => {
    console.error("Deepgram agent error:", err?.message || err);
    cleanup();
  });

  connection.on(AgentEvents.Close, () => {
    console.log("Deepgram agent WebSocket closed");
    cleanup();
  });

  connection.on(AgentEvents.Unhandled, (data) => {
    console.dir(data, { depth: null });
  });

  // Stream incoming client audio to Deepgram
  req.on("data", (audioChunk) => {
    connection.send(audioChunk);
  });

  req.on("end", () => {
    console.log("Client request stream ended");
    cleanup();
  });

  req.on("error", (err) => {
    console.error("Client request error:", err);
    cleanup();
  });
});

const PORT = process.env.PORT || 6033;
app.listen(PORT, () => {
  console.log(`Deepgram Speech-to-Speech server running on port ${PORT}`);
});
