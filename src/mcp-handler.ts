import { WebSocket } from "ws";
import { IncomingMessage } from "http";
import { generateApp } from "./lib/mcp/generate";
import makeZip from "./lib/makeZip";
import push from "./lib/mcp/push";
import deploy from "./lib/mcp/deploy";

export async function handleMcpConnection(ws: WebSocket, req: IncomingMessage) {
  console.log("⚡ MCP client connected");

  ws.on("message", async (message) => {
    try {
      const { command, ...data } = JSON.parse(message.toString());
      const lower = command.toLowerCase();

      const genMatch = lower.match(
        /(?:create|generate|build)\s+(?:me\s+an?\s+)?([\w\s-]+)\s+app/
      );
      const pushMatch = lower.match(/\bpush\b/);
      const deployMatch = lower.match(/\bdeploy\b/);

      // ───────────── GENERATE ─────────────
      if (genMatch) {
        const appName = genMatch[1].trim();
        ws.send(JSON.stringify({ bot: { mess: `Generating "${appName}" app...` } }));

        const files = await generateApp(appName);
        const zipBuffer = await makeZip(files);
        const zipBase64 = Buffer.from(zipBuffer).toString("base64");

        ws.send(
          JSON.stringify({
            bot: {
              mess: `Generated "${appName}" app successfully.`,
              zip: zipBase64,
            },
          })
        );
        return;
      }

      // ───────────── PUSH ─────────────
      if (pushMatch) {
        ws.send(JSON.stringify({ bot: { mess: "Pushing project to Git..." } }));
        const gitLink = await push(data);
        ws.send(
          JSON.stringify({
            bot: {
              mess: "Files pushed successfully.",
              link: gitLink,
            },
          })
        );
        return;
      }

      // ───────────── DEPLOY ─────────────
      if (deployMatch) {
        ws.send(JSON.stringify({ bot: { mess: "Deploying project..." } }));
        const result = await deploy(data);
        ws.send(
          JSON.stringify({
            bot: {
              mess: "App deployed successfully.",
              link: result?.url || null,
            },
          })
        );
        return;
      }

      ws.send(JSON.stringify({ bot: { mess: "No valid command found." } }));
    } catch (err: any) {
      ws.send(JSON.stringify({ bot: { mess: `Error: ${err.message}` } }));
    }
  });

  ws.on("close", () => {
    console.log("❌ MCP client disconnected");
  });
}
