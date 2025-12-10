import "dotenv/config";
import path from "node:path";
import cron from "node-cron";
import {
  createGit,
  getLatestDiff,
  updateLocalRepositoryA,
  getRepoRoot,
  getSingleCommitDiff,
} from "./gitUtils.js";
import { mergeAndCreatePR } from "./prGenerator.js";

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

    const { diff, latestCommit, localCommit, commitMessages } = await getLatestDiff(git, repoABranch);

    if (!latestCommit) {
      console.log("⚠️ Could not determine latest commit from remote");
      return;
    }

    if (localCommit) {
      console.log(`Local A commit: ${localCommit.substring(0, 7)}`);
    }
    console.log(`Remote A commit: ${latestCommit.substring(0, 7)}`);

    if (commitMessages.length > 0) {
      console.log(`📝 Commit messages from Repository A:`);
      commitMessages.forEach((commit, idx) => {
        console.log(`  ${idx + 1}. [${commit.hash.substring(0, 7)}] ${commit.message.split('\n')[0]}`);
      });
    }

    if (commitMessages.length > 0) {
      console.log(
        `✅ Found ${commitMessages.length} commit(s) to process`
      );
      console.log("→ Processing each commit separately (starting from oldest)...\n");

      // Ensure commits are sorted by date (oldest first)
      const sortedCommits = [...commitMessages].sort((a, b) => {
        const dateA = new Date(a.date);
        const dateB = new Date(b.date);
        return dateA - dateB; // Oldest first
      });

      let lastProcessedCommit = localCommit;
      let allSuccessful = true;
      let anyPRCreated = false;

      // Process each commit separately (starting from oldest)
      for (let i = 0; i < sortedCommits.length; i++) {
        const commit = sortedCommits[i];
        const commit = commitMessages[i];
        console.log(`\n📦 Processing commit ${i + 1}/${commitMessages.length}: ${commit.hash.substring(0, 7)}`);
        console.log(`   Message: ${commit.message.split('\n')[0]}`);

        try {
          // Get diff for this single commit
          const commitDiff = await getSingleCommitDiff(git, commit.hash);
          
          if (!commitDiff || commitDiff.trim().length === 0) {
            console.log(`   ⚠️ No changes found in this commit, skipping...`);
            lastProcessedCommit = commit.hash;
            continue;
          }

          // Process this single commit
          const result = await mergeAndCreatePR(commitDiff, commit.hash, [commit]);

          if (result.success) {
            if (result.prUrl) {
              console.log(`   ✅ PR created successfully: ${result.prUrl}`);
              anyPRCreated = true;
              lastProcessedCommit = commit.hash;
            } else {
              console.log(`   ℹ️ No PR created (no changes after merge)`);
              lastProcessedCommit = commit.hash;
            }
          } else {
            console.error(`   ❌ Failed to create PR: ${result.reason || result.error}`);
            console.error(`\n🛑 Stopping processing due to error. Remaining commits will not be processed.`);
            allSuccessful = false;
            break; // Stop processing remaining commits
          }
        } catch (err) {
          console.error(`   ❌ Error processing commit ${commit.hash.substring(0, 7)}:`, err.message);
          console.error(`\n🛑 Stopping processing due to error. Remaining commits will not be processed.`);
          allSuccessful = false;
          break; // Stop processing remaining commits
        }
      }

      // After processing all commits, update local Repository A
      if (allSuccessful && lastProcessedCommit && lastProcessedCommit !== localCommit) {
        console.log(`\n🔄 Updating local Repository A to latest processed commit...`);
        await updateLocalRepositoryA(git, repoABranch);
      } else if (anyPRCreated) {
        // Even if some failed, update if at least one PR was created
        console.log(`\n🔄 Updating local Repository A...`);
        await updateLocalRepositoryA(git, repoABranch);
      }
    } else if (diff && diff.trim().length > 0) {
      // Fallback: if we have diff but no commit messages, process as before
      console.log(
        `✅ Differences found between local and remote A`
      );
      console.log("→ Running Smart PR logic...");

      const result = await mergeAndCreatePR(diff, latestCommit, commitMessages);

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

// Run immediately on startup, then every 5 minutes using cron
console.log("🚀 Monitor started");
console.log("⏰ Will check for updates every 5 minutes (using cron: */5 * * * *)");

// Run immediately on startup
updateRepository();

// Schedule to run every 5 minutes using cron
// Cron expression: */5 * * * * means "every 5 minutes"
const cronSchedule = process.env.CRON_SCHEDULE || "*/5 * * * *";

const task = cron.schedule(cronSchedule, () => {
  console.log(`\n⏰ Scheduled check triggered at ${new Date().toISOString()}`);
  updateRepository();
}, {
  scheduled: true,
  timezone: "UTC"
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  task.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down gracefully...');
  task.stop();
  process.exit(0);
});
