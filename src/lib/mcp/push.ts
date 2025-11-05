import { Octokit } from "@octokit/rest";
import JSZip from "jszip";

interface File {
  path: string;
  content: string;
}

interface PushData {
  github_token: string;
  currApp: {
    name: string;
    code: string; // base64 zip
  };
}

async function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function waitForGitReady(octokit: Octokit, username: string, repoName: string) {
  // retry /git/refs/main up to 8 times
  for (let i = 0; i < 8; i++) {
    try {
      const { data: ref } = await octokit.rest.git.getRef({
        owner: username,
        repo: repoName,
        ref: "heads/main",
      });
      return ref.object.sha;
    } catch (err: any) {
      if (err.status === 404 || err.status === 409) {
        console.log(`🕐 waiting for Git backend to init... (${i + 1})`);
        await sleep(1500);
        continue;
      }
      throw err;
    }
  }
  throw new Error("GitHub backend never became ready after retries.");
}

export default async (data: PushData): Promise<string> => {
  const { github_token, currApp } = data;
  const { name, code } = currApp;

  const octokit = new Octokit({ auth: github_token });

  // ───── 1️⃣ Decode zip ─────
  const zipBuffer = Buffer.from(code, "base64");
  const zip = await JSZip.loadAsync(zipBuffer);

  const files: File[] = [];
  await Promise.all(
    Object.keys(zip.files).map(async (filename) => {
      const file = zip.files[filename];
      if (!file.dir) {
        const content = await file.async("text");
        files.push({ path: filename, content });
      }
    })
  );

  // ───── 2️⃣ Get username ─────
  const { data: user } = await octokit.rest.users.getAuthenticated();
  const username = user.login;
  const repoName = name.trim().toLowerCase().replace(/\s+/g, "-");
  const defaultBranch = "main";

  // ───── 3️⃣ Create repo (auto_init true = instant usable branch) ─────
  const { data: repo } = await octokit.rest.repos.createForAuthenticatedUser({
    name: repoName,
    private: false,
    auto_init: true,
  });

  const repoFullName = repo.full_name;

  // ───── 4️⃣ Wait until backend is ready (if slow) ─────
  const baseCommitSha = await waitForGitReady(octokit, username, repoName);

  // ───── 5️⃣ Get base tree sha ─────
  const { data: baseCommit } = await octokit.rest.git.getCommit({
    owner: username,
    repo: repoName,
    commit_sha: baseCommitSha,
  });
  const baseTreeSha = baseCommit.tree.sha;

  // ───── 6️⃣ Create blobs for all files ─────
  const blobs = await Promise.all(
    files.map(async (file) => {
      const blob = await octokit.rest.git.createBlob({
        owner: username,
        repo: repoName,
        content: file.content,
        encoding: "utf-8",
      });
      return { path: file.path, sha: blob.data.sha };
    })
  );

  // ───── 7️⃣ Create a new tree ─────
  const { data: newTree } = await octokit.rest.git.createTree({
    owner: username,
    repo: repoName,
    base_tree: baseTreeSha,
    tree: blobs.map((b) => ({
      path: b.path,
      mode: "100644",
      type: "blob",
      sha: b.sha,
    })),
  });

  // ───── 8️⃣ Create a commit for new files ─────
  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner: username,
    repo: repoName,
    message: "Initial project push",
    tree: newTree.sha,
    parents: [baseCommitSha],
  });

  // ───── 9️⃣ Update main branch ─────
  await octokit.rest.git.updateRef({
    owner: username,
    repo: repoName,
    ref: `heads/${defaultBranch}`,
    sha: newCommit.sha,
    force: true,
  });

  // ───── 🔟 Done ─────
  return `https://github.com/${repoFullName}`;
};
