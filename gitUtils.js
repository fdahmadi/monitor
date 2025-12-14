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
export const getCurrentLocalCommit = async (git) => {
  try {
    const log = await git.log(["-1"]);
    return log.latest?.hash || null;
  } catch (err) {
    console.warn("Could not get local HEAD commit:", err.message);
    return null;
  }
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
    console.warn(
      `Could not get latest commit from origin/${branch}:`,
      err.message
    );
    return null;
  }
};

// Get commit messages between two commits
export const getCommitMessages = async (git, fromCommit, toCommit) => {
  try {
    // If commits are the same, no new commits
    if (fromCommit && toCommit && fromCommit === toCommit) {
      return [];
    }

    // Build log range using git range format
    // Format: fromCommit..toCommit (commits reachable from toCommit but not from fromCommit)
    let logRange;
    if (!fromCommit) {
      // No local commit yet, get all commits up to toCommit (just get latest few)
      // Limit to avoid too many commits
      logRange = [toCommit, "-20"]; // Last 20 commits max
    } else {
      // Get commits between fromCommit (exclusive) and toCommit (inclusive)
      // Using range format: fromCommit..toCommit
      logRange = [`${fromCommit}..${toCommit}`];
    }

    const log = await git.log(logRange);

    // simple-git returns commits in reverse chronological order (newest first)
    // Reverse to get chronological order (oldest first)
    const commits = log.all
      .map((commit) => ({
        hash: commit.hash,
        message: commit.message,
        date: commit.date,
      }))
      .reverse();

    return commits;
  } catch (err) {
    console.warn("Could not get commit messages:", err.message);
    // Fallback: try to get at least the latest commit message
    try {
      if (toCommit) {
        const log = await git.log([toCommit, "-1"]);
        if (log.latest) {
          return [
            {
              hash: log.latest.hash,
              message: log.latest.message,
              date: log.latest.date,
            },
          ];
        }
      }
    } catch (fallbackErr) {
      console.warn(
        "Fallback commit message retrieval also failed:",
        fallbackErr.message
      );
    }
    return [];
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
      return {
        diff: "",
        latestCommit: null,
        localCommit: null,
        commitMessages: [],
      };
    }

    // Get current local HEAD commit
    let localCommit = null;
    try {
      const log = await git.log(["-1"]);
      localCommit = log.latest?.hash || null;
    } catch (err) {
      console.warn("Could not get local HEAD commit:", err.message);
    }

    // Get commit messages between local HEAD and remote
    let commitMessages = [];
    if (localCommit || latestCommit) {
      commitMessages = await getCommitMessages(
        git,
        localCommit || "HEAD",
        latestCommit
      );
      if (commitMessages.length > 0) {
        console.log(
          `Found ${commitMessages.length} commit(s) between local and remote`
        );
      }
    }

    // Get diff between local HEAD and remote origin/branch
    // This shows what's new in remote A compared to local A
    const diff = await git.diff([
      `HEAD`,
      `origin/${branch}`,
      "--diff-filter=ACDMRT", // Include Added, Copied, Deleted, Modified, Renamed, Type-changed files
      "--unified=3", // More context lines
    ]);

    return { diff, latestCommit, localCommit, commitMessages };
  } catch (err) {
    console.error("Error getting diff:", err.message);
    return {
      diff: "",
      latestCommit: null,
      localCommit: null,
      commitMessages: [],
    };
  }
};

export const getNextCommit = async (git, commitHash) => {
  try {
    // Get all commits from the given commit to HEAD
    const log = await git.log([`${commitHash}..HEAD`]);

    // If we have commits, the first one in the array is the next commit
    // simple-git returns commits in reverse chronological order (newest first)
    // So we need to get the last one in the array to get the next commit
    if (log.all && log.all.length > 0) {
      return log.all[log.all.length - 1]?.hash || null;
    }

    return null;
  } catch (err) {
    console.warn("Could not get next commit:", err.message);
    return null;
  }
};

// Get next commit from remote repository (GitHub)
export const getNextCommitFromRemote = async (
  git,
  commitHash,
  branch = "main"
) => {
  try {
    // First, fetch the latest changes from remote
    await git.fetch("origin", branch);

    // Get all commits from the given commit to the latest remote commit
    const log = await git.log([`${commitHash}..origin/${branch}`]);

    // If we have commits, we need to find the one that comes immediately after commitHash
    // simple-git returns commits in reverse chronological order (newest first)
    if (log.all && log.all.length > 0) {
      // Reverse the array to get chronological order (oldest first)
      const chronologicalCommits = log.all.reverse();

      // The first commit in chronological order is the one that comes immediately after commitHash
      return chronologicalCommits[0]?.hash || null;
    }

    return null;
  } catch (err) {
    console.warn("Could not get next commit from remote:", err.message);
    return null;
  }
};

// Get commits from a specific date
export const getCommitsFromDate = async (
  git,
  date,
  branch = "main",
  useRemote = true
) => {
  try {
    // Format the date for git log (YYYY-MM-DD)
    const formattedDate = new Date(date).toISOString().split("T")[0];

    // Determine the branch to use
    const branchRef = useRemote ? `origin/${branch}` : branch;

    // If using remote, fetch latest changes first
    if (useRemote) {
      await git.fetch("origin", branch);
    }

    // Get commits from the specified date
    const log = await git.log([
      `--since=${formattedDate} 00:00:00`,
      `--until=${formattedDate} 23:59:59`,
      branchRef,
    ]);

    // Return commits with their details
    return log.all.map((commit) => ({
      hash: commit.hash,
      message: commit.message,
      date: commit.date,
      author: commit.author_name,
      authorEmail: commit.author_email,
    }));
  } catch (err) {
    console.warn(`Could not get commits from date ${date}:`, err.message);
    return [];
  }
};

// Get the date of a specific local commit
export const getLocalCommitDate = async (
  git,
  commitHash,
  branch = "master",
  useRemote = true
) => {
  try {
    // Determine the branch to use
    const branchRef = useRemote ? `origin/${branch}` : branch;

    // If using remote, fetch latest changes first
    if (useRemote) {
      await git.fetch("origin", branch);
    }

    // Get the commit details using the commit hash directly
    const log = await git.log({ maxCount: 1 });

    if (log.latest) {
      return log.latest.date;
    }

    return null;
  } catch (err) {
    console.warn(`Could not get date for commit ${commitHash}:`, err.message);
    return null;
  }
};
// Get diff for a single commit
// Returns the diff between commit^ (parent) and commit
export const getSingleCommitDiff = async (git, commitHash) => {
  try {
    // Get diff between parent and commit
    // Format: commit^..commit shows changes introduced by this commit
    const diff = await git.diff([
      `${commitHash}^`,
      commitHash,
      "--diff-filter=ACDMRT", // Include Added, Copied, Deleted, Modified, Renamed, Type-changed files
      "--unified=3", // More context lines
    ]);

    return diff;
  } catch (err) {
    // If commit^ doesn't exist (e.g., first commit), try to get diff from empty tree
    try {
      const diff = await git.diff([
        "--root",
        commitHash,
        "--diff-filter=ACDMRT",
        "--unified=3",
      ]);
      return diff;
    } catch (fallbackErr) {
      console.error(
        `Error getting diff for commit ${commitHash}:`,
        err.message
      );
      return "";
    }
  }
};

// Reset local repository A to a specific commit (after processing that commit)
export const resetLocalToCommit = async (git, branch, commitHash) => {
  try {
    // Ensure we're on the correct branch
    try {
      await git.checkout(branch);
    } catch (err) {
      console.warn(`Branch ${branch} might not exist locally, fetching...`);
      await git.fetch("origin", branch);
      await git.checkout(branch);
    }

    // Reset HEAD to the specific commit (hard reset to discard any uncommitted changes)
    await git.reset(["--hard", commitHash]);

    return true;
  } catch (err) {
    console.error(
      `❌ Error resetting local Repository A to commit ${commitHash.substring(
        0,
        7
      )}:`,
      err.message
    );
    return false;
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
