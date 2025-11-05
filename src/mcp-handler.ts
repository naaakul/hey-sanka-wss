import { WebSocket } from "ws";
import { IncomingMessage } from "http";
import { generateApp } from "./lib/mcp/generate";
import makeZip from "./lib/makeZip";
import push from "./lib/mcp/push";
import deploy from "./lib/mcp/deploy";

export async function handleMcpConnection(ws: WebSocket, req: IncomingMessage) {
  console.log("⚡ MCP client connected");

  // ───── session per connection ─────
  let session: {
    currApp?: { name: string; code: string };
    repoFullName?: string; // e.g. "wizzzzzzzard/doing"
  } = {};

  ws.on("message", async (message) => {
    try {
      const { command, github_token, vercel_token } = JSON.parse(
        message.toString()
      );
      const lower = command.toLowerCase();

      console.log("🧠 Command:", lower);

      const genMatch = lower.match(
        /(?:create|generate|build)\s+(?:me\s+an?\s+)?([\w\s-]+)\s+app/
      );
      const pushMatch = lower.match(/\b(?:push|github)\b/);
      const deployMatch = lower.match(/\bdeploy\b/);

      // ───────────── GEN ─────────────
      if (genMatch) {
        const appName = genMatch[1].trim();
        ws.send(
          JSON.stringify({ bot: { mess: `Generating "${appName}" app...` } })
        );

        const files = await generateApp(appName);
        const zipBuffer = await makeZip(files);
        const zipBase64 = Buffer.from(zipBuffer).toString("base64");

        // store this app in memory for this connection
        session.currApp = { name: appName, code: zipBase64 };

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
        if (!session.currApp) {
          ws.send(
            JSON.stringify({
              bot: { mess: "No app found to push. Please generate one first." },
            })
          );
          return;
        }

        ws.send(JSON.stringify({ bot: { mess: "Pushing project to Git..." } }));

        const gitLink = await push({
          github_token,
          currApp: session.currApp,
        });

        // 🔥 extract "owner/repo" from link and store it
        const match = gitLink.match(/github\.com\/([^/]+\/[^/]+)/);
        if (match) {
          session.repoFullName = match[1];
        }

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
        if (!session.repoFullName) {
          ws.send(
            JSON.stringify({
              bot: {
                mess:
                  "No GitHub repo found. Please push your app before deploying.",
              },
            })
          );
          return;
        }

        ws.send(JSON.stringify({ bot: { mess: "Deploying project..." } }));

        const result = await deploy({
          repoFullName: session.repoFullName,
          VERCEL_TOKEN: vercel_token,
        });

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

      // ───────────── FALLBACK ─────────────
      ws.send(JSON.stringify({ bot: { mess: "No valid command found." } }));
    } catch (err: any) {
      ws.send(
        JSON.stringify({ bot: { mess: `Error from MCP: ${err.message}` } })
      );
    }
  });

  ws.on("close", () => {
    console.log("❌ MCP client disconnected");
  });
}
