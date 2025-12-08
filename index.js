import "dotenv/config";
import path from "node:path";
import {
  createGit,
  getLatestDiff,
  updateLocalRepositoryA,
  getRepoRoot,
} from "./gitUtils.js";
import { runCustomFunction } from "./runCustomFunction.js";

// Handle both absolute and relative paths for REPO_A_PATH
const repoAPathRaw = process.env.REPO_A_PATH;
const repoAPath = path.isAbsolute(repoAPathRaw) 
  ? repoAPathRaw 
  : path.resolve(process.cwd(), repoAPathRaw);
const repoABranch = process.env.REPO_A_BRANCH || "main";

// Validate required environment variables
const requiredEnvVars = [
  "REPO_A_PATH",
  "REPO_B_PATH",
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "CLAUDE_API_KEY",
];

const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);
if (missingVars.length > 0) {
  console.error(
    "❌ Missing required environment variables:",
    missingVars.join(", ")
  );
  process.exit(1);
}

const updateRepository = async () => {
  try {
    console.log("\n=== Checking Repo A for updates ===");
    console.log(`Repo A Path: ${repoAPath}`);
    console.log(`Repo A Branch: ${repoABranch}`);

    const git = createGit(repoAPath);
    const repoRoot = await getRepoRoot(git);

    if (repoRoot) {
      console.log(`Repo Root: ${repoRoot}`);
    }

    const { diff, latestCommit, localCommit } = await getLatestDiff(git, repoABranch);

    if (!latestCommit) {
      console.log("⚠️ Could not determine latest commit from remote");
      return;
    }

    if (localCommit) {
      console.log(`Local A commit: ${localCommit.substring(0, 7)}`);
    }
    console.log(`Remote A commit: ${latestCommit.substring(0, 7)}`);

    if (diff && diff.trim().length > 0) {
      console.log(
        `✅ Differences found between local and remote A`
      );
      console.log("→ Running Smart PR logic...");

      const result = await runCustomFunction(diff, latestCommit);

      if (result.success) {
        if (result.prUrl) {
          console.log(`\n🎉 Smart PR created successfully: ${result.prUrl}`);
          
          // After successful PR creation, update local Repository A
          // to sync with remote A for next check
          await updateLocalRepositoryA(git, repoABranch);
        } else {
          console.log("\n✅ Processing completed (no PR needed)");
          // Even if no PR was created (maybe no changes after merge),
          // we should still update local A if there were changes in remote
          if (localCommit !== latestCommit) {
            await updateLocalRepositoryA(git, repoABranch);
          }
        }
      } else {
        console.error(`\n❌ Smart PR failed: ${result.reason || result.error}`);
        // Don't update local A if PR creation failed
      }
    } else {
      console.log("ℹ️ No new changes detected (local A is up to date with remote A).");
      
      // Even if no diff, check if we need to sync
      if (localCommit !== latestCommit) {
        console.log("⚠️ Local and remote commits differ but no diff found. Updating local A...");
        await updateLocalRepositoryA(git, repoABranch);
      }
    }
  } catch (err) {
    console.error("❌ Error in updateRepository:", err);
    if (err.stack) {
      console.error(err.stack);
    }
  }
};

// Run immediately on startup, then every 5 minutes
console.log("🚀 Monitor started");
console.log("⏰ Will check for updates every 5 minutes");
updateRepository();
setInterval(updateRepository, 5 * 60 * 1000);
