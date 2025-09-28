import { WebSocket } from "ws";
import { IncomingMessage } from "http";
import speech from "@google-cloud/speech";
import textToSpeech from "@google-cloud/text-to-speech";
import dotenv from "dotenv";

dotenv.config();

const SILENCE_TIMEOUT_MS = Number(process.env.SILENCE_TIMEOUT_MS || 1500);
const RESTART_STT_AFTER_TTS_MS = Number(
  process.env.RESTART_STT_AFTER_TTS_MS || 500
);
const AUTO_TTS_ON_FINAL = process.env.AUTO_TTS_ON_FINAL === "1" || false;
const DEFAULT_TTS_VOICES = [
  process.env.TTS_VOICE || "en-US-Chirp3-HD-Achernar",
  "en-US-Wavenet-F",
  "en-US-Wavenet-C",
];

const sttClient = new speech.SpeechClient();
const ttsClient = new textToSpeech.TextToSpeechClient();

function safeSend(ws: WebSocket, payload: any) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  } catch (e) {}
}

async function synthesizeTextToBase64(text: string) {
  for (const voiceName of DEFAULT_TTS_VOICES) {
    try {
      const [res] = await ttsClient.synthesizeSpeech({
        input: { text },
        voice: { languageCode: "en-US", name: voiceName },
        audioConfig: { audioEncoding: "MP3" },
      } as any);
      const audioContent: Buffer | undefined = (res as any).audioContent;
      if (audioContent)
        return { b64: audioContent.toString("base64"), voice: voiceName };
    } catch (err) {
      console.warn(
        `TTS voice "${voiceName}" failed: ${String(err).slice(0, 200)}`
      );
    }
  }
  throw new Error("All TTS voices failed");
}

function makeReplyForTranscript(transcript: string) {
  const username = process.env.USER_NAME || "friend";
  return `done ${username}, have a look. I generated a TODO app for you based on: "${transcript}"`;
}

function parseJSON(raw: any) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

export async function handleConnection(ws: WebSocket, req?: IncomingMessage) {
  console.log("✅ Client connected", req?.socket.remoteAddress);

  let recognizeStream: any = null;
  let silenceTimer: NodeJS.Timeout | null = null;
  let lastInterim = "";

  const clearSilenceTimer = () => {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  };

  const startSTT = () => {
    if (recognizeStream) {
      try {
        recognizeStream.end();
      } catch {}
      recognizeStream = null;
    }

    recognizeStream = sttClient
      .streamingRecognize({
        config: {
          encoding: "LINEAR16",
          sampleRateHertz: 16000,
          languageCode: "en-US",
        },
        interimResults: true,
      })
      .on("error", (err: any) => {
        console.error("STT stream error:", err);
        recognizeStream = null;
        safeSend(ws, { error: "stt_error", message: String(err) });
      })
      .on("data", async (res: any) => {
        try {
          const result = res.results?.[0];
          const alt = result?.alternatives?.[0];
          const transcription = String(alt?.transcript || "").trim();
          const isFinal = Boolean(result?.isFinal);

          console.log(
            "🔍 STT data:",
            JSON.stringify({
              isFinal,
              preview: transcription?.slice(0, 120),
            })
          );

          if (!transcription) return;

          safeSend(ws, { transcript: transcription, isFinal });

          lastInterim = transcription;

          if (isFinal) {
            console.log("⏱️ [isFinal] finalizing:", transcription);
            clearSilenceTimer();
            safeSend(ws, { final: transcription });

            if (AUTO_TTS_ON_FINAL) {
              try {
                const replyText = makeReplyForTranscript(transcription);
                const { b64 } = await synthesizeTextToBase64(replyText);
                safeSend(ws, { audio: b64, text: replyText });
              } catch (err) {
                console.error("Auto TTS failed (isFinal):", err);
                safeSend(ws, {
                  error: "auto_tts_failed",
                  message: String(err),
                });
              } finally {
                setTimeout(() => {
                  if (ws.readyState === ws.OPEN) startSTT();
                }, RESTART_STT_AFTER_TTS_MS);
              }
            }
            return;
          }

          clearSilenceTimer();
          silenceTimer = setTimeout(async () => {
            try {
              console.log(
                "⏱️ [timer] Silence detected → finalizing:",
                lastInterim
              );
              safeSend(ws, { final: lastInterim });
            } catch {}

            if (AUTO_TTS_ON_FINAL) {
              try {
                const replyText = makeReplyForTranscript(lastInterim);
                const { b64 } = await synthesizeTextToBase64(replyText);
                safeSend(ws, { audio: b64, text: replyText });
              } catch (err) {
                console.error("Auto TTS failed (timer):", err);
                safeSend(ws, {
                  error: "auto_tts_failed",
                  message: String(err),
                });
              } finally {
                setTimeout(() => {
                  if (ws.readyState === ws.OPEN) startSTT();
                }, RESTART_STT_AFTER_TTS_MS);
              }
            }
          }, SILENCE_TIMEOUT_MS);
        } catch (err) {
          console.error("Error in STT data handler:", err);
        }
      });

    console.log("🎙️ STT started");
  };

  const stopSTT = () => {
    if (recognizeStream) {
      try {
        recognizeStream.end();
      } catch {}
    }
    recognizeStream = null;
    clearSilenceTimer();
    console.log("🛑 STT stopped");
  };

  ws.on("message", async (raw) => {
    const data = parseJSON(raw);
    if (!data) {
      safeSend(ws, { error: "bad_message", message: "invalid json" });
      return;
    }

    try {
      if (data.event === "start") {
        startSTT();
      } else if (data.event === "audio") {
        if (!recognizeStream) startSTT();

        let audioBuffer: Buffer;
        if (typeof data.audio === "string") {
          audioBuffer = Buffer.from(data.audio, "base64");
        } else if (Array.isArray(data.audio)) {
          audioBuffer = Buffer.from(data.audio);
        } else if (Buffer.isBuffer(data.audio)) {
          audioBuffer = data.audio;
        } else {
          console.warn("Unknown audio payload format");
          return;
        }

        try {
          recognizeStream.write(audioBuffer);
        } catch (err) {
          console.error("Stream write error:", err);
          recognizeStream = null;
        }
      } else if (data.event === "stop") {
        stopSTT();
      } else if (data.event === "tts") {
        const text = data.text || "";
        if (!text || typeof text !== "string") {
          safeSend(ws, { error: "invalid_tts_text" });
          return;
        }
        try {
          const { b64 } = await synthesizeTextToBase64(text);
          safeSend(ws, { audio: b64, text });
        } catch (err) {
          console.error("TTS synth error:", err);
          safeSend(ws, { error: "tts_failed", message: String(err) });
        }
      } else {
        safeSend(ws, { echo_server: data });
      }
    } catch (err) {
      console.error("Failed to handle WS message:", err);
      safeSend(ws, { error: "server_error", message: String(err) });
    }
  });

  ws.on("close", () => {
    console.log("❌ Client disconnected");
    stopSTT();
  });

  ws.on("error", (err) => {
    console.error("WS error:", err);
    stopSTT();
  });
}
