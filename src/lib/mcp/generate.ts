import fs from "fs-extra";
import path from "path";
import { tmpdir } from "os";
import Groq from "groq-sdk";
import glob from "fast-glob";
import { SCAFFOLD_SYSTEM_PROMPT } from "../prompts/scaffold-prompt";
import "dotenv/config";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

const TEMPLATE_PATH = path.join(process.cwd(), "templates/next14-base");

export async function generateApp(appName: string) {
  const prompt = `Generate a fully working Next.js 14 app with Tailwind CSS named "${appName}".
It should include at least:
- app/page.tsx with basic UI related to ${appName}
- components/ directory for modular UI
- utils/ directory if needed
Return a JSON with "files": [{ "path": "file path", "content": "file content" }]`;

  const chatCompletion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: SCAFFOLD_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0,
  });

  let text = chatCompletion.choices[0]?.message?.content || "";

  text = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No valid JSON object found in response");
  const config = JSON.parse(match[0]);

  const tempDir = path.join(tmpdir(), appName);
  await fs.copy(TEMPLATE_PATH, tempDir);

  for (const file of config.files) {
    const fullPath = path.join(tempDir, file.path);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, file.content);
  }

  const filePaths = await glob("**/*", {
    cwd: tempDir,
    dot: true,
    onlyFiles: true,
    ignore: [
      "**/*.ico",
      "**/*.png",
      "**/*.jpg",
      "**/*.jpeg",
      "**/*.gif",
      "**/*.webp",
      "**/*.avif",
    ],
  });

  const files = await Promise.all(
    filePaths.map(async (p) => {
      const fullPath = path.join(tempDir, p);
      const isBinary = /\.(ico|png|jpg|jpeg|gif|webp|avif)$/i.test(p);
      const content = isBinary
        ? (await fs.readFile(fullPath)).toString("base64") // encode binary as base64
        : await fs.readFile(fullPath, "utf-8");

      return {
        path: p,
        content,
        encoding: isBinary ? "base64" : "utf-8",
      };
    })
  );

  if (!Array.isArray(config.files)) {
    throw new Error("Invalid response: files is not an array");
  }

  return files;
}
