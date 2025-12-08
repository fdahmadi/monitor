import "dotenv/config";
import { createGit, getLatestDiff, saveLastProcessedCommit } from "./gitUtils.js";
import { runCustomFunction } from "./runCustomFunction.js";

const repoAPath = process.env.REPO_A_PATH;
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
    console.error("❌ Missing required environment variables:", missingVars.join(", "));
    process.exit(1);
}

const updateRepository = async () => {
    try {
        console.log("\n=== Checking Repo A for updates ===");
        console.log(`Repo A Path: ${repoAPath}`);
        console.log(`Repo A Branch: ${repoABranch}`);

        const git = createGit(repoAPath);

        const { diff, latestCommit } = await getLatestDiff(git, repoABranch);

        if (!latestCommit) {
            console.log("⚠️ Could not determine latest commit");
            return;
        }

        if (diff && diff.trim().length > 0) {
            console.log(`✅ Differences found (commit: ${latestCommit.substring(0, 7)})`);
            console.log("→ Running Smart PR logic...");

            const result = await runCustomFunction(diff, latestCommit);

            if (result.success) {
                if (result.prUrl) {
                    console.log(`\n🎉 Smart PR created successfully: ${result.prUrl}`);
                } else {
                    console.log("\n✅ Processing completed (no PR needed)");
                }
                // Save the processed commit to avoid reprocessing
                if (result.latestCommit) {
                    await saveLastProcessedCommit(result.latestCommit);
                    console.log(`💾 Saved processed commit: ${result.latestCommit.substring(0, 7)}`);
                }
            } else {
                console.error(`\n❌ Smart PR failed: ${result.reason || result.error}`);
            }
        } else {
            console.log("ℹ️ No new changes detected.");
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

