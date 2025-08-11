const express = require("express");
const { createClient, AgentEvents } = require("@deepgram/sdk");
require("dotenv").config();

if (!process.env.DEEPGRAM_API_KEY) {
  throw new Error("DEEPGRAM_API_KEY is not set");
}

if (!process.env.AGENT_PROMPT) {
  throw new Error("AGENT_PROMPT environment variable is required");
}

const app = express();
const SAMPLE_RATE = Number(process.env.DEEPGRAM_SAMPLE_RATE || 8000);

// Agent system prompt from environment variable
const AGENT_PROMPT = process.env.AGENT_PROMPT;

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
