import "dotenv/config";
import path from "node:path";
import cron from "node-cron";
import {
  createGit,
  getLatestDiff,
  updateLocalRepositoryA,
  resetLocalToCommit,
  getRepoRoot,
  getSingleCommitDiff,
  getNextCommit,
  getCurrentLocalCommit,
  getNextCommitFromRemote,
} from "./gitUtils.js";
import { mergeAndCreatePRNoClaude } from "./prGeneratorNoClaude.js";

// Handle both absolute and relative paths for REPO_A_PATH
const repoAPathRaw = process.env.REPO_A_PATH;
const repoAPath = path.isAbsolute(repoAPathRaw)
  ? repoAPathRaw
  : path.resolve(process.cwd(), repoAPathRaw);
const repoABranch = process.env.REPO_A_BRANCH || "main";

// Get commit wait time from environment (in minutes, default: 3 minutes)
const commitWaitTimeMinutes = parseInt(process.env.COMMIT_WAIT_TIME || "3", 10);
const commitWaitTimeMs = commitWaitTimeMinutes * 60 * 1000;

// Validate required environment variables (NO CLAUDE_API_KEY needed)
const requiredEnvVars = [
  "REPO_A_PATH",
  "REPO_B_PATH",
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
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
    let currentLocalCommit = await getCurrentLocalCommit(git);
    let nextCommit = await getNextCommitFromRemote(
      git,
      currentLocalCommit,
      repoABranch
    );
    if (nextCommit) {
      console.log(`Next commit: ${nextCommit.substring(0, 7)}`);
    }
    if (repoRoot) {
      console.log(`Repo Root: ${repoRoot}`);
    }

    const { diff, latestCommit, localCommit, commitMessages } =
      await getLatestDiff(git, repoABranch);

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
        console.log(
          `  ${idx + 1}. [${commit.hash.substring(0, 7)}] ${
            commit.message.split("\n")[0]
          }`
        );
      });
    }

    if (commitMessages.length > 0) {
      console.log(`✅ Found ${commitMessages.length} commit(s) to process`);
      console.log(
        "→ Processing each commit separately (starting from oldest)...\n"
      );

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
        console.log(
          `\n📦 Processing commit ${i + 1}/${
            sortedCommits.length
          }: ${commit.hash.substring(0, 7)}`
        );
        console.log(`   Message: ${commit.message.split("\n")[0]}`);

        try {
          // Get diff for this single commit
          const commitDiff = await getSingleCommitDiff(git, commit.hash);

          if (!commitDiff || commitDiff.trim().length === 0) {
            console.log(`   ⚠️ No changes found in this commit, skipping...`);
            lastProcessedCommit = commit.hash;
            // Reset local repo A to this commit after skipping to prevent reprocessing
            await resetLocalToCommit(git, repoABranch, commit.hash);

            // Wait before processing next commit (if there is one)
            if (i < sortedCommits.length - 1) {
              console.log(
                `   ⏳ Waiting ${commitWaitTimeMinutes} minute(s) before processing next commit...`
              );
              await new Promise((resolve) =>
                setTimeout(resolve, commitWaitTimeMs)
              );
            }
            continue;
          }

          // Process this single commit (WITHOUT Claude)
          const result = await mergeAndCreatePRNoClaude(
            commitDiff,
            commit.hash,
            [commit]
          );

          if (result.success) {
            if (result.prUrl) {
              console.log(`   ✅ PR created successfully: ${result.prUrl}`);
              anyPRCreated = true;
            } else {
              console.log(`   ℹ️ No PR created (no changes after merge)`);
            }
            lastProcessedCommit = commit.hash;

            // Reset local repo A to this commit after successful processing to prevent reprocessing
            console.log(
              `   🔄 Resetting local Repository A to commit ${commit.hash.substring(
                0,
                7
              )}...`
            );
            await resetLocalToCommit(git, repoABranch, commit.hash);

            // Wait before processing next commit (if there is one)
            if (i < sortedCommits.length - 1) {
              console.log(
                `   ⏳ Waiting ${commitWaitTimeMinutes} minute(s) before processing next commit...`
              );
              await new Promise((resolve) =>
                setTimeout(resolve, commitWaitTimeMs)
              );
            }
          } else {
            // Check if it's a conflict error
            if (result.reason === "File conflicts with open PRs") {
              console.error(
                `   ❌ File conflicts detected with open pull requests.`
              );
              if (result.conflictingPRs) {
                console.error(`   Conflicting PRs:`);
                result.conflictingPRs.forEach((conflict) => {
                  console.error(
                    `     - PR #${conflict.prNumber}: ${conflict.prTitle} (${conflict.prUrl})`
                  );
                  console.error(
                    `       Files: ${conflict.conflictingFiles.join(", ")}`
                  );
                });
              }
            } else {
              console.error(
                `   ❌ Failed to create PR: ${result.reason || result.error}`
              );
            }
            console.error(
              `\n🛑 Stopping processing due to error. Remaining commits will not be processed.`
            );
            allSuccessful = false;
            break; // Stop processing remaining commits
          }
        } catch (err) {
          console.error(
            `   ❌ Error processing commit ${commit.hash.substring(0, 7)}:`,
            err.message
          );
          console.error(
            `\n🛑 Stopping processing due to error. Remaining commits will not be processed.`
          );
          allSuccessful = false;
          break; // Stop processing remaining commits
        }
      }

      // Final update check (shouldn't be needed since we update after each commit, but keeping as safety net)
      if (
        allSuccessful &&
        lastProcessedCommit &&
        lastProcessedCommit !== localCommit
      ) {
        console.log(
          `\n🔄 Final sync: Updating local Repository A to latest processed commit...`
        );
        await updateLocalRepositoryA(git, repoABranch);
      } else if (
        anyPRCreated &&
        lastProcessedCommit &&
        lastProcessedCommit !== localCommit
      ) {
        // Even if some failed, update if at least one PR was created (safety net)
        console.log(`\n🔄 Final sync: Updating local Repository A...`);
        await updateLocalRepositoryA(git, repoABranch);
      }
    } else if (diff && diff.trim().length > 0) {
      // Fallback: if we have diff but no commit messages, process as before
      console.log(`✅ Differences found between local and remote A`);
      console.log("→ Running PR logic (No Claude)...");

      const result = await mergeAndCreatePRNoClaude(
        diff,
        latestCommit,
        commitMessages
      );

      if (result.success) {
        if (result.prUrl) {
          console.log(`\n🎉 PR created successfully: ${result.prUrl}`);

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
        // Check if it's a conflict error
        if (result.reason === "File conflicts with open PRs") {
          console.error(
            `\n❌ File conflicts detected with open pull requests.`
          );
          if (result.conflictingPRs) {
            console.error(`Conflicting PRs:`);
            result.conflictingPRs.forEach((conflict) => {
              console.error(
                `  - PR #${conflict.prNumber}: ${conflict.prTitle} (${conflict.prUrl})`
              );
              console.error(
                `    Files: ${conflict.conflictingFiles.join(", ")}`
              );
            });
          }
        } else {
          console.error(`\n❌ PR failed: ${result.reason || result.error}`);
        }
        // Don't update local A if PR creation failed
      }
    } else {
      console.log(
        "ℹ️ No new changes detected (local A is up to date with remote A)."
      );

      // Even if no diff, check if we need to sync
      if (localCommit !== latestCommit) {
        console.log(
          "⚠️ Local and remote commits differ but no diff found. Updating local A..."
        );
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

// Run immediately on startup, then every hour using cron
console.log("🚀 Monitor started (No Claude version)");
console.log("⏰ Will check for updates every hour (using cron: 0 * * * *)");

// Run immediately on startup
updateRepository();

// Schedule to run every hour using cron
// Cron expression: 0 * * * * means "at minute 0 of every hour"
const cronSchedule = process.env.CRON_SCHEDULE || "0 * * * *";

const task = cron.schedule(
  cronSchedule,
  () => {
    console.log(
      `\n⏰ Scheduled check triggered at ${new Date().toISOString()}`
    );
    updateRepository();
  },
  {
    scheduled: true,
    timezone: "UTC",
  }
);

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down gracefully...");
  task.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Shutting down gracefully...");
  task.stop();
  process.exit(0);
});
