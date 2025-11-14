import http from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { handleConnection } from "./wss-handler";

dotenv.config();

const PORT = Number(process.env.WSS_PORT || 8082);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim());

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Sanka WSS server running\n");
});

const wss = new WebSocketServer({ noServer: true });

wss.on("error", (err) => {
  console.error("WSS error:", err);
});

wss.on("connection", (ws, req) => {
  handleConnection(ws, req).catch((err) => {
    console.error("Connection handler error:", err);
    ws.close();
  });
});

server.on("upgrade", (req, socket, head) => {
  const origin = (req.headers.origin as string) || "";
  if (!origin || !allowedOrigins.includes(origin)) {
    console.log("⛔ Blocked WS upgrade from:", origin);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

server.listen(PORT, () => console.log(`🚀 WSS server running on :${PORT}`));
