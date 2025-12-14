import "dotenv/config";
import path from "node:path";
import fs from "node:fs/promises";
import {
  createGit,
  getSingleCommitDiff,
  getCurrentLocalCommit,
  getCommitsFromDate,
  getLocalCommitDate,
} from "./gitUtils.js";
import moment from "moment";
import { mergeAndCreatePRNoClaude } from "./prGeneratorNoClaude.js";

// Configuration options
const dryRun = process.env.DRY_RUN === "true";
const includePatterns = process.env.INCLUDE_PATTERNS
  ? process.env.INCLUDE_PATTERNS.split(",")
  : [];
const excludePatterns = process.env.EXCLUDE_PATTERNS
  ? process.env.EXCLUDE_PATTERNS.split(",")
  : [];

const repoAPathRaw = process.env.REPO_A_PATH;
const repoAPath = path.isAbsolute(repoAPathRaw)
  ? repoAPathRaw
  : path.resolve(process.cwd(), repoAPathRaw);
const repoABranch = process.env.REPO_A_BRANCH || "main";

const repoBPathRaw = process.env.REPO_B_PATH;
const repoBPath = path.isAbsolute(repoBPathRaw)
  ? repoBPathRaw
  : path.resolve(process.cwd(), repoBPathRaw);
const repoBBranch = process.env.REPO_B_BRANCH || "main";

// Check if a file should be processed based on include/exclude patterns
const shouldProcessFile = (filePath) => {
  // If include patterns are specified, only include files that match at least one pattern
  if (includePatterns.length > 0) {
    const isIncluded = includePatterns.some((pattern) =>
      filePath.includes(pattern.trim())
    );
    if (!isIncluded) {
      return false;
    }
  }

  // If exclude patterns are specified, exclude files that match any pattern
  if (excludePatterns.length > 0) {
    const isExcluded = excludePatterns.some((pattern) =>
      filePath.includes(pattern.trim())
    );
    if (isExcluded) {
      return false;
    }
  }

  return true;
};

// Create a pull request for changes from a commit in Repository A
const createPRForCommit = async (commitHash, commitMessage) => {
  try {
    console.log(
      `\n=== Creating PR for commit ${commitHash.substring(0, 7)} ===`
    );

    // Create git instance for Repository A
    const gitA = createGit(repoAPath);

    // Get the diff for the specific commit from Repository A
    const diff = await getSingleCommitDiff(gitA, commitHash);

    if (!diff || diff.trim() === "") {
      console.log("No changes to create PR for this commit");
      return { success: true, prUrl: null, reason: "No changes" };
    }

    // Parse the diff to extract file changes
    const fileChanges = parseDiffForFiles(diff);

    if (fileChanges.length === 0) {
      console.log("No file changes detected in this commit");
      return { success: true, prUrl: null, reason: "No file changes" };
    }

    // Filter files based on include/exclude patterns
    const filteredFileChanges = fileChanges.filter((fileChange) =>
      shouldProcessFile(fileChange.path)
    );

    if (filteredFileChanges.length === 0) {
      console.log("No files match the include/exclude patterns");
      return { success: true, prUrl: null, reason: "No matching files" };
    }

    console.log(
      `Found ${fileChanges.length} file(s) in commit, ${filteredFileChanges.length} file(s) to include in PR`
    );

    // Create a commit message array for PR generator
    const commitMessages = [
      {
        hash: commitHash,
        message: commitMessage,
        date: new Date().toISOString(),
      },
    ];

    // Use existing PR creation functionality
    const prResult = await mergeAndCreatePRNoClaude(
      diff,
      commitHash,
      commitMessages
    );

    if (prResult.success) {
      console.log(
        `✅ Successfully created PR for commit ${commitHash.substring(0, 7)}`
      );
      return { success: true, prUrl: prResult.prUrl };
    } else {
      console.log(
        `❌ Failed to create PR for commit ${commitHash.substring(0, 7)}: ${
          prResult.reason || prResult.error
        }`
      );
      return { success: false, error: prResult.reason || prResult.error };
    }
  } catch (err) {
    console.error(
      `❌ Error creating PR for commit ${commitHash.substring(0, 7)}:`,
      err.message
    );
    return { success: false, error: err.message };
  }
};

// Example: Create a PR for a specific commit from Repository A
const createPRForSpecificCommit = async (commitHash) => {
  console.log(`\n=== Creating PR for specific commit: ${commitHash} ===`);

  const git = createGit(repoAPath);

  try {
    // Get commit details
    const commitDetails = await git.show([commitHash, "--stat"]);
    console.log("Commit details:");
    console.log(commitDetails);

    // Create a PR for the commit
    const result = await createPRForCommit(
      commitHash,
      "Manual PR for specific commit"
    );

    if (result.success) {
      if (result.prUrl) {
        console.log(`✅ PR created: ${result.prUrl}`);
      } else {
        console.log(`ℹ️ No PR created: ${result.reason}`);
      }
    } else {
      console.log(`❌ Failed to create PR: ${result.error}`);
    }
  } catch (err) {
    console.error(`Error creating PR for commit ${commitHash}:`, err.message);
  }
};

// Example: Create PRs for all commits from a specific date
const createPRsFromDate = async (dateString) => {
  console.log(`\n=== Creating PRs for commits from date: ${dateString} ===`);

  const git = createGit(repoAPath);

  try {
    // Get commits from the specified date
    const commits = await getCommitsFromDate(git, dateString, repoABranch);

    console.log(`Found ${commits.length} commits from ${dateString}`);

    // Process each commit
    for (const commit of commits.reverse()) {
      console.log(`\nProcessing commit: ${commit.hash.substring(0, 7)}`);
      console.log(`Date: ${commit.date}`);
      console.log(`Message: ${commit.message}`);

      if (dryRun) {
        console.log(
          `[DRY RUN] Would create PR for commit ${commit.hash.substring(0, 7)}`
        );
        continue;
      }

      const result = await createPRForCommit(commit.hash, commit.message);

      if (result.success) {
        if (result.prUrl) {
          console.log(`✅ PR created: ${result.prUrl}`);
        } else {
          console.log(`ℹ️ No PR created: ${result.reason}`);
        }
      } else {
        console.log(`❌ Failed to create PR: ${result.error}`);
      }
    }
  } catch (err) {
    console.error(`Error creating PRs from ${dateString}:`, err.message);
  }
};

// Create a single PR for all commits from a specific date
const createPRForAllCommitsFromDate = async (dateString) => {
  console.log(`\n=== Creating PR for all commits from date: ${dateString} ===`);

  const git = createGit(repoAPath);

  try {
    // Get commits from the specified date
    const commits = await getCommitsFromDate(git, dateString, repoABranch);

    if (commits.length === 0) {
      console.log(`No commits found for ${dateString}`);
      return { success: true, prUrl: null, reason: "No commits" };
    }

    console.log(`Found ${commits.length} commits from ${dateString}`);

    // Create git instances for both repositories
    const gitA = createGit(repoAPath);
    const gitB = createGit(repoBPath);

    // Generate branch name based on date
    const branchName = `pr-${dateString}`;

    // Ensure Repository B is on the correct branch
    try {
      await gitB.checkout(repoBBranch);
      await gitB.reset(["--hard", repoBBranch]);
    } catch (err) {
      console.warn(
        `Branch ${repoBBranch} might not exist locally, fetching...`
      );
      await gitB.fetch("origin", repoBBranch);
      await gitB.checkout(repoBBranch);
      await gitB.reset(["--hard", repoBBranch]);
    }

    // Pull latest changes from remote Repository B
    if (!dryRun) {
      try {
        await gitB.pull("origin", repoBBranch);
        console.log("Pulled latest changes from remote Repository B");
      } catch (err) {
        console.warn(
          "Could not pull latest changes from remote Repository B:",
          err.message
        );
      }
    }

    // Create and checkout new branch

    if (!dryRun) {
      try {
        await gitB.deleteLocalBranch(branchName, true);
        await gitB.push("origin", "--delete", branchName);
        await gitB.checkoutLocalBranch(branchName);
        console.log(`Created and checked out branch: ${branchName}`);
      } catch (err) {
        console.error(`Error creating branch ${branchName}:`, err.message);
        return { success: false, error: err.message };
      }
    } else {
      console.log(`[DRY RUN] Would create and checkout branch: ${branchName}`);
    }

    let totalFilesProcessed = 0;
    let allFileChanges = [];

    // Process each commit and collect all changes
    for (const commit of commits.reverse()) {
      console.log(`\nProcessing commit: ${commit.hash.substring(0, 7)}`);
      console.log(`Date: ${commit.date}`);
      console.log(`Message: ${commit.message}`);

      // Get the diff for the specific commit from Repository A
      const diff = await getSingleCommitDiff(gitA, commit.hash);

      if (!diff || diff.trim() === "") {
        console.log("No changes in this commit");
        continue;
      }

      // Parse the diff to extract file changes
      const fileChanges = parseDiffForFiles(diff);

      if (fileChanges.length === 0) {
        console.log("No file changes detected in this commit");
        continue;
      }

      // Filter files based on include/exclude patterns
      const filteredFileChanges = fileChanges.filter((fileChange) =>
        shouldProcessFile(fileChange.path)
      );

      if (filteredFileChanges.length === 0) {
        console.log("No files match the include/exclude patterns");
        continue;
      }

      console.log(
        `Found ${fileChanges.length} file(s) in commit, ${filteredFileChanges.length} file(s) to apply`
      );

      // Apply each file change to Repository B
      if (!dryRun) {
        let filesProcessed = 0;
        for (const fileChange of filteredFileChanges) {
          const success = await applyFileChange(
            gitA,
            gitB,
            fileChange,
            commit.hash
          );
          if (success) {
            filesProcessed++;
          }
        }
        totalFilesProcessed += filesProcessed;
      } else {
        console.log(
          `[DRY RUN] Would apply ${
            filteredFileChanges.length
          } file changes from commit ${commit.hash.substring(0, 7)}`
        );
        totalFilesProcessed += filteredFileChanges.length;
      }

      // Collect all file changes for PR description
      allFileChanges.push({
        commit: commit,
        fileChanges: filteredFileChanges,
      });
    }

    // Commit all changes and create PR
    if (totalFilesProcessed > 0) {
      if (!dryRun) {
        // Stage all changes
        await gitB.add(".");

        // Create commit message
        const commitMessage = `Sync changes from Repository A (${dateString})\n\nThis PR includes changes from ${commits.length} commits:\n\n`;

        // Add commit details to PR description
        for (const commit of commits.reverse()) {
          commitMessage += `- ${commit.hash.substring(0, 7)}: ${
            commit.message.split("\n")[0]
          }\n`;
        }

        // Commit changes
        await gitB.commit(commitMessage);
        console.log(`Committed all changes to branch ${branchName}`);

        // Push branch to remote
        await gitB.push("origin", branchName, ["-f"]);
        console.log(`Pushed branch ${branchName} to remote`);

        // Create PR using the existing PR creation functionality
        // We need to create a diff between the base branch and our new branch
        const diffBetweenBranches = await gitB.diff([
          `${repoBBranch}...${branchName}`,
          "--unified=3",
        ]);

        // Create a commit message array for the PR generator
        const commitMessages = commits.map((commit) => ({
          hash: commit.hash,
          message: commit.message,
          date: commit.date,
        }));

        // Use existing PR creation functionality
        const prResult = await mergeAndCreatePRNoClaude(
          diffBetweenBranches,
          commits[commits.length - 1].hash,
          commitMessages
        );

        if (prResult.success) {
          console.log(
            `✅ Successfully created PR for all commits from ${dateString}`
          );
          return { success: true, prUrl: prResult.prUrl };
        } else {
          console.log(
            `❌ Failed to create PR: ${prResult.reason || prResult.error}`
          );
          return { success: false, error: prResult.reason || prResult.error };
        }
      } else {
        console.log(
          `[DRY RUN] Would commit all changes and create PR for date ${dateString}`
        );
        return { success: true, prUrl: null, reason: "Dry run" };
      }
    } else {
      console.log(`No files were processed for date ${dateString}`);
      return { success: true, prUrl: null, reason: "No files processed" };
    }
  } catch (err) {
    console.error(`❌ Error creating PR for date ${dateString}:`, err.message);
    return { success: false, error: err.message };
  }
};

// Apply a single file change to Repository B
const applyFileChange = async (gitA, gitB, fileChange, commitHash) => {
  try {
    const filePath = fileChange.path;
    const repoBFilePath = path.join(repoBPath, filePath);

    console.log(`Processing file: ${filePath}`);

    // If file is deleted in Repository A, delete it in Repository B
    if (fileChange.isDeleted) {
      if (dryRun) {
        console.log(`  [DRY RUN] Would delete file: ${filePath}`);
        return true;
      }

      try {
        await fs.unlink(repoBFilePath);
        console.log(`  Deleted file: ${filePath}`);
        return true;
      } catch (err) {
        // File might not exist in Repository B, which is fine
        console.log(
          `  File ${filePath} not found in Repository B, skipping deletion`
        );
        return true;
      }
    }

    // For new or modified files, get the content from Repository A
    if (dryRun) {
      console.log(
        `  [DRY RUN] Would ${
          fileChange.isNew ? "create" : "update"
        } file: ${filePath}`
      );
      return true;
    }

    try {
      // Get the file content from Repository A at the specific commit
      const fileContent = await gitA.show([`${commitHash}:${filePath}`]);

      // Ensure directory exists in Repository B
      const dirPath = path.dirname(repoBFilePath);
      await fs.mkdir(dirPath, { recursive: true });

      // Write the file content to Repository B
      await fs.writeFile(repoBFilePath, fileContent);
      console.log(
        `  ${fileChange.isNew ? "Created" : "Updated"} file: ${filePath}`
      );
      return true;
    } catch (err) {
      console.error(`  Error processing file ${filePath}:`, err.message);
      return false;
    }
  } catch (err) {
    console.error(
      `  Error applying file change for ${fileChange.path}:`,
      err.message
    );
    return false;
  }
};
