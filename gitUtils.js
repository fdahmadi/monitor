import simpleGit from "simple-git";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const createGit = (cwd) => simpleGit({ baseDir: cwd });

// Get the root directory of a Git repository
export const getRepoRoot = async (git) => {
  try {
    const root = await git.revparse(["--show-toplevel"]);
    return root.trim();
  } catch (err) {
    console.warn("Could not determine Git repository root:", err.message);
    return null;
  }
};

const STATE_FILE = path.join(process.cwd(), ".last-processed-commit.json");

// Load last processed commit hash
export const getLastProcessedCommit = async () => {
  try {
    if (existsSync(STATE_FILE)) {
      const data = await readFile(STATE_FILE, "utf8");
      const state = JSON.parse(data);
      return state.lastCommit || null;
    }
  } catch (err) {
    console.warn("Could not read state file:", err.message);
  }
  return null;
};

// Save last processed commit hash
export const saveLastProcessedCommit = async (commitHash) => {
  try {
    await writeFile(
      STATE_FILE,
      JSON.stringify({ lastCommit: commitHash }, null, 2)
    );
  } catch (err) {
    console.error("Could not save state file:", err.message);
  }
};

// Get the latest commit hash from remote branch
// Note: Assumes fetch has already been called
export const getLatestCommitHash = async (git, branch) => {
  try {
    const log = await git.log([`origin/${branch}`, "-1"]);
    return log.latest?.hash || null;
  } catch (err) {
    console.warn(`Could not get latest commit from origin/${branch}:`, err.message);
    return null;
  }
};

// Get diff between local HEAD and remote origin/branch
// This compares the local clone of A with the remote A repository
export const getLatestDiff = async (git, branch) => {
  try {
    // Fetch latest changes from remote
    console.log(`Fetching latest changes from origin/${branch}...`);
    await git.fetch("origin", branch);
    
    // Get the latest commit hash from remote
    const latestCommit = await getLatestCommitHash(git, branch);
    
    if (!latestCommit) {
      return { diff: "", latestCommit: null, localCommit: null };
    }

    // Get current local HEAD commit
    let localCommit = null;
    try {
      const log = await git.log(["-1"]);
      localCommit = log.latest?.hash || null;
    } catch (err) {
      console.warn("Could not get local HEAD commit:", err.message);
    }

    // Get diff between local HEAD and remote origin/branch
    // This shows what's new in remote A compared to local A
    const diff = await git.diff([
      `HEAD`,
      `origin/${branch}`,
      "--diff-filter=ACDMRT", // Include Added, Copied, Deleted, Modified, Renamed, Type-changed files
      "--unified=3" // More context lines
    ]);

    return { diff, latestCommit, localCommit };
  } catch (err) {
    console.error("Error getting diff:", err.message);
    return { diff: "", latestCommit: null, localCommit: null };
  }
};

// Update local repository A to match remote A (after successful PR creation)
export const updateLocalRepositoryA = async (git, branch) => {
  try {
    console.log(`\n🔄 Updating local Repository A to match remote...`);
    
    // Ensure we're on the correct branch
    try {
      await git.checkout(branch);
    } catch (err) {
      console.warn(`Branch ${branch} might not exist locally, fetching...`);
      await git.fetch("origin", branch);
      await git.checkout(branch);
    }
    
    // Pull latest changes to sync local with remote
    await git.pull("origin", branch);
    
    console.log(`✅ Local Repository A updated successfully`);
    return true;
  } catch (err) {
    console.error("❌ Error updating local Repository A:", err.message);
    return false;
  }
};
