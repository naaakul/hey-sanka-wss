import { Vercel } from "@vercel/sdk";

type DeployOpts = {
  repoFullName: string;      // e.g. "wizzzzzzzard/doing"
  VERCEL_TOKEN: string;      // personal access token
  branch?: string;           // default "main"
  waitTimeoutMs?: number;    // default 2 minutes
  pollIntervalMs?: number;   // default 3 seconds
};

export default async (opts: DeployOpts) => {
  const {
    repoFullName,
    VERCEL_TOKEN,
    branch = "main",
    waitTimeoutMs = 120_000,
    pollIntervalMs = 3_000,
  } = opts;

  if (!repoFullName || !VERCEL_TOKEN) {
    throw new Error("repoFullName and VERCEL_TOKEN are required.");
  }

  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error("repoFullName must be 'owner/repo'.");

  const client = new Vercel({ bearerToken: VERCEL_TOKEN });
  let projectIdOrName = repo;

  // ───── 1️⃣ Ensure the Vercel project exists ─────
  try {
    const projectResp = await client.projects.createProject({
      requestBody: {
        name: projectIdOrName,
        framework: "nextjs",
        gitRepository: {
          repo: repoFullName,
          type: "github",
        },
      },
    });
    projectIdOrName = projectResp.id ?? repo;
    console.log(`✅ Created new Vercel project: ${projectIdOrName}`);
  } catch (err: any) {
    const msg = err?.message || JSON.stringify(err);
    if (msg.includes("already exists")) {
      console.log("ℹ️ Project already exists on Vercel, continuing...");
    } else {
      console.warn("createProject warning:", msg);
    }
  }

  // ───── 2️⃣ Trigger deployment from GitHub ─────
  let deployment: any;
  try {
    const deployResp = await client.deployments.createDeployment({
      requestBody: {
        name: projectIdOrName,
        target: "production",
        gitSource: {
          type: "github",
          repo: repo,
          org: owner,
          ref: branch,
        },
        gitMetadata: {
          remoteUrl: `https://github.com/${repoFullName}`,
          commitRef: branch,
        },
      },
    });
    deployment = deployResp;
    console.log(`🚀 Triggered Vercel deploy: ${deployment.id}`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    throw new Error(`Failed to trigger Vercel deployment: ${msg}`);
  }

  // ───── 3️⃣ Poll until deployment is READY ─────
  const start = Date.now();
  async function fetchDeployment() {
    return await client.deployments.getDeployment({
      idOrUrl: deployment.id,
    });
  }

  let finalDeployment: any = deployment;

  while (true) {
    if (Date.now() - start > waitTimeoutMs) {
      throw new Error(
        `Timed out waiting for deployment to be READY (waited ${
          Math.round(waitTimeoutMs / 1000)
        }s). Current status: ${finalDeployment.status ?? "unknown"}`
      );
    }

    try {
      finalDeployment = await fetchDeployment();
    } catch (err: any) {
      console.warn("fetchDeployment transient error:", err?.message ?? String(err));
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      continue;
    }

    const status = (finalDeployment.status ?? "").toUpperCase();

    if (status === "READY") {
      const url =
        finalDeployment.url ??
        finalDeployment.aliasFinal ??
        (finalDeployment.alias && finalDeployment.alias[0]);
      console.log(`✅ Vercel deploy READY at: https://${url}`);
      return {
        success: true,
        url: `https://${url}`,
        deployment: finalDeployment,
      };
    }

    if (status === "ERROR" || status === "CANCELED") {
      throw new Error(
        `Deployment failed with status=${status}. Reason: ${
          finalDeployment.errorMessage ?? "unknown"
        }`
      );
    }

    console.log(`🕐 Vercel status: ${status}...`);
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
};
