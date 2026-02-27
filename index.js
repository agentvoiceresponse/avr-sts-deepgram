/**
 * index.js
 * Entry point for the Deepgram Speech-to-Speech streaming WebSocket server.
 * This server handles real-time audio streaming between clients and Deepgram's API,
 * performing necessary audio format conversions and WebSocket communication.
 *
 * Client Protocol:
 * - Send {"type": "init", "uuid": "uuid"} to initialize session
 * - Send {"type": "audio", "audio": "base64_encoded_audio"} to stream audio
 * - Receive {"type": "audio", "audio": "base64_encoded_audio"} for responses
 * - Receive {"type": "error", "message": "error_message"} for errors
 *
 * @author Agent Voice Response <info@agentvoiceresponse.com>
 * @see https://www.agentvoiceresponse.com
 */

const WebSocket = require("ws");
const { createClient, AgentEvents } = require("@deepgram/sdk");
const { loadTools, getToolHandler } = require("./loadTools");

require("dotenv").config();

if (!process.env.DEEPGRAM_API_KEY) {
  throw new Error("DEEPGRAM_API_KEY is not set");
}

if (!process.env.AGENT_PROMPT) {
  throw new Error("AGENT_PROMPT environment variable is required");
}

const SAMPLE_RATE = Number(process.env.DEEPGRAM_SAMPLE_RATE || 8000);

// Agent system prompt from environment variable
const AGENT_PROMPT = process.env.AGENT_PROMPT;

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  const data =
    typeof payload === "string" ? payload : JSON.stringify(payload);

  try {
    ws.send(data);
  } catch (error) {
    console.error("Error sending WebSocket message to client:", error);
  }
}

/**
 * Creates and configures a Deepgram agent connection.
 *
 * @returns {Object} Configured Deepgram agent connection
 */
function createDeepgramAgentConnection() {
  return createClient(process.env.DEEPGRAM_API_KEY).agent();
}

/**
 * Handles incoming client WebSocket connection and manages communication with Deepgram's API.
 * Implements buffering for audio chunks received before WebSocket connection is established.
 *
 * @param {WebSocket} clientWs - Client WebSocket connection
 */
const handleClientConnection = (clientWs) => {
  console.log("New client WebSocket connection received");
  let sessionUuid = null;
  let connection = null;
  let keepAliveIntervalId = null;
  let isCleanedUp = false;

  function cleanup() {
    if (isCleanedUp) return;
    isCleanedUp = true;

    if (keepAliveIntervalId) clearInterval(keepAliveIntervalId);
    if (connection) {
      try {
        connection.disconnect();
      } catch (error) {
        console.error("Error disconnecting Deepgram agent:", error);
      }
    }
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      try {
        clientWs.close();
      } catch (error) {
        console.error("Error closing client WebSocket:", error);
      }
    }
  }

  // Handle client WebSocket messages
  clientWs.on("message", (data) => {
    try {
      const message = JSON.parse(data);
      switch (message.type) {
        case "init":
          sessionUuid = message.uuid;
          console.log("Session UUID:", sessionUuid);
          // Initialize Deepgram connection when client is ready
          initializeDeepgramConnection();
          break;

        case "audio":
          // Handle audio data from client
          if (message.audio && connection) {
            const audioBuffer = Buffer.from(message.audio, "base64");
            try {
              connection.send(audioBuffer);
            } catch (error) {
              console.error("Error sending audio to Deepgram agent:", error);
            }
          }
          break;

        default:
          console.log("Unknown message type from client:", message.type);
          break;
      }
    } catch (error) {
      console.error("Error processing client message:", error);
    }
  });

  // Initialize Deepgram WebSocket connection
  const initializeDeepgramConnection = () => {
    connection = createDeepgramAgentConnection();

    connection.on(AgentEvents.Open, () => {
      console.log("Deepgram agent WebSocket opened");
    });

    connection.on(AgentEvents.Welcome, () => {
      console.log("Configuring Deepgram agent...");

      let obj = {
        audio: {
          input: {
            encoding: process.env.DEEPGRAM_INPUT_ENCODING || "linear16",
            sample_rate: Number(process.env.DEEPGRAM_INPUT_SAMPLE_RATE || SAMPLE_RATE),
          },
          output: {
            encoding: process.env.DEEPGRAM_OUTPUT_ENCODING || "linear16",
            sample_rate: Number(process.env.DEEPGRAM_OUTPUT_SAMPLE_RATE || SAMPLE_RATE),
            container: process.env.DEEPGRAM_OUTPUT_CONTAINER || "none",
          },
        },
        agent: {
          language: process.env.DEEPGRAM_LANGUAGE || "en",
          listen: {
            provider: {
              type: process.env.DEEPGRAM_LISTEN_PROVIDER || "deepgram",
              model: process.env.DEEPGRAM_ASR_MODEL || "nova-3",
            },
          },
          think: {
            provider: {
              type: process.env.DEEPGRAM_THINK_PROVIDER || "open_ai",
              model: process.env.DEEPGRAM_THINK_MODEL || "gpt-4o-mini",
            },
            prompt: AGENT_PROMPT,
          },
          speak: {
            provider: {
              type: process.env.DEEPGRAM_SPEAK_PROVIDER || "deepgram",
              model: process.env.DEEPGRAM_TTS_MODEL || "aura-2-thalia-en",
            },
          },
          greeting:
            process.env.DEEPGRAM_GREETING ||
            "Hi there, I'm your virtual assistant—how can I help today?",
        },
      };

      try {
        obj.agent.think.functions = loadTools();
        console.log(`Loaded ${obj.agent.think.functions.length} tools for Deepgram`);
      } catch (error) {
        console.error(`Error loading tools for Deepgram: ${error.message}`);
      }

      connection.configure(obj);

      console.log("Deepgram agent configured", obj);

      const keepAliveMs = Number(process.env.DEEPGRAM_KEEPALIVE_INTERVAL || 5000);
      keepAliveIntervalId = setInterval(() => {
        connection.keepAlive();
      }, keepAliveMs);
    });

    connection.on(AgentEvents.ConversationText, (data) => {
      safeSend(clientWs, {
        type: "transcript",
        role: data.role == "user" ? "user" : "agent",
        text: data.content,
      });
    });

    connection.on(AgentEvents.Audio, (data) => {
      safeSend(clientWs, {
        type: "audio",
        audio: data.toString("base64"),
      });
    });

    connection.on(AgentEvents.AgentAudioDone, () => {
      console.log("Deepgram agent audio done");
    });

    connection.on(AgentEvents.UserStartedSpeaking, () => {
      safeSend(clientWs, { type: "interruption" });
    });

    connection.on(AgentEvents.FunctionCallRequest, async (data) => {
      console.log("Deepgram agent function call request", data);
      for (const func of data.functions) {
        const handler = getToolHandler(func.name);

        if (!handler) {
          console.error(`No handler found for tool: ${func.name}`);
          continue;
        }
        
        try {
          const content = await handler(
            sessionUuid,
            JSON.parse(func.arguments)
          );
          console.log("Tool response:", content);
          connection.send(JSON.stringify({
            type: "FunctionCallResponse",
            id: func.id,
            name: func.name,
            content
          }));
        } catch (error) {
          console.error(`Error executing tool ${func.name}:`, error);
          connection.send(JSON.stringify({
            type: "FunctionCallResponse",
            id: func.id,
            name: func.name,
            content: error.message
          }));
        }
      }
    });

    connection.on(AgentEvents.Error, (err) => {
      console.error("Deepgram agent error:", err?.message || err);
      safeSend(clientWs, {
        type: "error",
        message: err?.message || "Deepgram agent error",
      });
      cleanup();
    });

    connection.on(AgentEvents.Close, () => {
      console.log("Deepgram agent WebSocket closed");
      cleanup();
    });
  };

  // Handle client WebSocket close
  clientWs.on("close", () => {
    console.log("Client WebSocket connection closed");
    cleanup();
  });

  clientWs.on("error", (err) => {
    console.error("Client WebSocket error:", err);
    cleanup();
  });
};

// Start the server
const startServer = () => {
  let wss;
  let isShuttingDown = false;

  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log("Shutting down WebSocket server...");

    if (wss) {
      wss.close(() => {
        console.log("WebSocket server closed");
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  };

  try {
    // Create WebSocket server
    const PORT = process.env.PORT || 6033;
    wss = new WebSocket.Server({ port: PORT });

    wss.on("connection", (clientWs) => {
      console.log("New client connected");
      handleClientConnection(clientWs);
    });

    console.log(
      `Deepgram Speech-to-Speech WebSocket server running on port ${PORT}`
    );

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

// Start the server
startServer();
