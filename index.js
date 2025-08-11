/**
 * index.js
 * Entry point for the Deepgram Speech-to-Speech streaming application.
 * This server handles real-time audio streaming between clients and Deepgram's API,
 * performing necessary audio format conversions and WebSocket communication.
 *
 * @author Agent Voice Response <info@agentvoiceresponse.com>
 * @see https://www.agentvoiceresponse.com
 */

const express = require("express");
const { createClient } = require("@deepgram/sdk");
const { AgentEvents } = require("@deepgram/sdk");

require("dotenv").config();

// Initialize Express application
const app = express();
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

/**
 * Stream Processing
 */

/**
 * Handles incoming client audio stream and manages communication with Deepgram's API.
 * Implements buffering for audio chunks received before WebSocket connection is established.
 *
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 */
const handleAudioStream = async (req, res) => {
  console.log("New audio stream received");

  // Create an agent connection
  const agent = deepgram.agent();

  // Configure WebSocket event handlers
  // Set up event handlers
  agent.on(AgentEvents.Open, () => {
    console.log("Connection opened");

    // Configure the agent once connection is established
    agent.configure({
      audio: {
        input: {
          encoding: "linear16",
          sample_rate: 8000
        },
        output: {
          encoding: "linear16",
          sample_rate: 8000,
          // bitrate: 8000,
          container: "none",
        },
      },
      agent: {
        // "instructions": "You are a helpful AI assistant. Keep responses concise.",
        // "listen_model": "nova",
        // "think_model": "gpt-4",
        // "speak_model": "aura-2-thalia-en"
      },
    });
  });

  // Handle agent responses
  agent.on(AgentEvents.AgentStartedSpeaking, (data) => {
    console.log("Agent started speaking:", data["total_latency"]);
  });

  agent.on(AgentEvents.ConversationText, (message) => {
    console.log(`${message.role} said: ${message.content}`);
  });

  agent.on(AgentEvents.Audio, (audio) => {
    res.write(audio);
  });

  agent.on(AgentEvents.Error, (error) => {
    console.error("Error:", error);
  });

  agent.on(AgentEvents.Close, () => {
    console.log("Connection closed");
  });

  // Handle incoming audio data
  req.on("data", (chunk) => {
    try {
      agent.send(chunk);
    } catch (error) {
      console.error("Error processing audio chunk:", error);
    }
  });

  req.on("end", () => {
    console.log("Request stream ended");
    agent.end();
    res.end();
  });

  req.on("error", (err) => {
    console.error("Request error:", err);
    try {
      agent.end();
      res.status(500).json({ message: "Stream error" });
    } catch (error) {
      console.error("Error closing WebSocket:", error);
    }
  });

  // Set required headers for streaming
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
};

// API Endpoints
app.post("/speech-to-speech-stream", handleAudioStream);

// Start server
const PORT = process.env.PORT || 6033;
app.listen(PORT, () => {
  console.log(`Deepgram Speech-to-Speech server running on port ${PORT}`);
});
