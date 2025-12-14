import "dotenv/config";
import path from "node:path";
import fs from "node:fs/promises";
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
  getCommitsFromDate,
  getLocalCommitDate,
} from "./gitUtils.js";
import moment from "moment";
import { mergeAndCreatePRNoClaude } from "./prGeneratorNoClaude.js";

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

// Configuration options
const dryRun = process.env.DRY_RUN === "true";
const includePatterns = process.env.INCLUDE_PATTERNS
  ? process.env.INCLUDE_PATTERNS.split(",")
  : [];
const excludePatterns = process.env.EXCLUDE_PATTERNS
  ? process.env.EXCLUDE_PATTERNS.split(",")
  : [];

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

// Push changes to remote Repository B
const pushChangesToRepoB = async () => {
  try {
    console.log(`\n=== Pushing changes to remote Repository B ===`);

    if (dryRun) {
      console.log(`[DRY RUN] Would push changes to remote Repository B`);
      return true;
    }

    const gitB = createGit(repoBPath);

    // Push to remote
    await gitB.push("origin", repoBBranch);
    console.log(`✅ Successfully pushed changes to remote Repository B`);

    return true;
  } catch (err) {
    console.error(
      `❌ Error pushing changes to remote Repository B:`,
      err.message
    );
    return false;
  }
};

// Apply file changes from a commit in Repository A to Repository B
const applyCommitChangesToRepoB = async (commitHash, commitMessage) => {
  try {
    console.log(
      `\n=== Applying changes from commit ${commitHash.substring(
        0,
        7
      )} to Repository B ===`
    );

    // Create git instances for both repositories
    const gitA = createGit(repoAPath);
    const gitB = createGit(repoBPath);

    // Get the diff for the specific commit from Repository A
    const diff = await getSingleCommitDiff(gitA, commitHash);

    if (!diff || diff.trim() === "") {
      console.log("No changes to apply for this commit");
      return true;
    }

    // Parse the diff to extract file changes
    const fileChanges = parseDiffForFiles(diff);

    if (fileChanges.length === 0) {
      console.log("No file changes detected in this commit");
      return true;
    }

    // Filter files based on include/exclude patterns
    const filteredFileChanges = fileChanges.filter((fileChange) =>
      shouldProcessFile(fileChange.path)
    );

    if (filteredFileChanges.length === 0) {
      console.log("No files match the include/exclude patterns");
      return true;
    }

    console.log(
      `Found ${fileChanges.length} file(s) in commit, ${filteredFileChanges.length} file(s) to apply changes to`
    );

    // Ensure Repository B is on the correct branch
    try {
      await gitB.checkout(repoBBranch);
    } catch (err) {
      console.warn(
        `Branch ${repoBBranch} might not exist locally, fetching...`
      );
      await gitB.fetch("origin", repoBBranch);
      await gitB.checkout(repoBBranch);
    }

    // Pull latest changes from remote Repository B to avoid conflicts
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

    // Apply each file change to Repository B
    let filesProcessed = 0;
    for (const fileChange of filteredFileChanges) {
      const success = await applyFileChange(gitA, gitB, fileChange, commitHash);
      if (success) {
        filesProcessed++;
      }
    }

    // Commit the changes to Repository B if any files were processed
    if (filesProcessed > 0) {
      if (!dryRun) {
        await gitB.add(".");
        await gitB.commit(
          `Sync from Repository A: ${commitMessage}\n\nOriginal commit: ${commitHash}`
        );
        console.log(
          `✅ Successfully applied changes from commit ${commitHash.substring(
            0,
            7
          )} to Repository B`
        );
      } else {
        console.log(
          `[DRY RUN] Would commit changes from commit ${commitHash.substring(
            0,
            7
          )} to Repository B`
        );
      }

      // Push changes to remote Repository B
      await pushChangesToRepoB();
    } else {
      console.log(
        `No files were processed for commit ${commitHash.substring(0, 7)}`
      );
    }

    return true;
  } catch (err) {
    console.error(
      `❌ Error applying changes from commit ${commitHash.substring(0, 7)}:`,
      err.message
    );
    return false;
  }
};

// Parse diff to extract file changes
const parseDiffForFiles = (diff) => {
  const fileChanges = [];
  const lines = diff.split("\n");
  let currentFile = null;
  let currentContent = [];
  let isNewFile = false;
  let isDeletedFile = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for file header
    if (line.startsWith("diff --git")) {
      // Save previous file if exists
      if (currentFile) {
        fileChanges.push({
          path: currentFile,
          content: currentContent.join("\n"),
          isNew: isNewFile,
          isDeleted: isDeletedFile,
        });
      }

      // Extract file path
      const match = line.match(/b\/(.+)$/);
      if (match) {
        currentFile = match[1];
        currentContent = [];
        isNewFile = false;
        isDeletedFile = false;
      }
    }
    // Check for new file indicator
    else if (line.startsWith("new file mode")) {
      isNewFile = true;
    }
    // Check for deleted file indicator
    else if (line.startsWith("deleted file mode")) {
      isDeletedFile = true;
    }
    // Collect content lines (skip diff headers)
    else if (
      currentFile &&
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))
    ) {
      currentContent.push(line);
    }
  }

  // Save last file
  if (currentFile) {
    fileChanges.push({
      path: currentFile,
      content: currentContent.join("\n"),
      isNew: isNewFile,
      isDeleted: isDeletedFile,
    });
  }

  return fileChanges;
};

// Check for conflicts before applying changes
const checkForConflicts = async (gitB, filePath, fileContent) => {
  try {
    const repoBFilePath = path.join(repoBPath, filePath);

    // Check if file exists in Repository B
    try {
      const existingContent = await fs.readFile(repoBFilePath, "utf8");

      // Simple conflict detection: check if files have different content
      // This is a basic implementation - you might want more sophisticated conflict detection
      if (existingContent !== fileContent) {
        return {
          hasConflict: true,
          existingContent,
          newContent: fileContent,
        };
      }
    } catch (err) {
      // File doesn't exist in Repository B, no conflict
      return { hasConflict: false };
    }

    return { hasConflict: false };
  } catch (err) {
    console.error(`Error checking for conflicts in ${filePath}:`, err.message);
    return { hasConflict: false, error: err.message };
  }
};

// Resolve conflicts based on strategy
const resolveConflict = async (filePath, conflict, conflictStrategy) => {
  const { existingContent, newContent } = conflict;
  const repoBFilePath = path.join(repoBPath, filePath);

  console.log(`  Conflict detected in ${filePath}`);

  switch (conflictStrategy) {
    case "overwrite":
      // Overwrite with new content from Repository A
      await fs.writeFile(repoBFilePath, newContent);
      console.log(
        `  Resolved conflict: Overwrote with content from Repository A`
      );
      return true;

    case "keep":
      // Keep existing content in Repository B
      console.log(`  Resolved conflict: Kept existing content in Repository B`);
      return true;

    case "backup":
      // Create a backup of existing content and then overwrite
      const backupPath = `${repoBFilePath}.backup.${Date.now()}`;
      await fs.writeFile(backupPath, existingContent);
      await fs.writeFile(repoBFilePath, newContent);
      console.log(
        `  Resolved conflict: Created backup at ${backupPath} and overwrote with new content`
      );
      return true;

    case "merge":
      // Simple merge strategy - in a real implementation, you might use a proper merge algorithm
      // For now, we'll just append the new content after a separator
      const mergedContent = `${existingContent}\n\n<!-- ===== MERGED FROM REPOSITORY A ===== -->\n${newContent}`;
      await fs.writeFile(repoBFilePath, mergedContent);
      console.log(`  Resolved conflict: Merged content from both repositories`);
      return true;

    default:
      console.log(`  Unknown conflict strategy: ${conflictStrategy}`);
      return false;
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

      // Check for conflicts if file exists in Repository B
      const conflictStrategy = process.env.CONFLICT_STRATEGY || "overwrite";
      if (conflictStrategy !== "overwrite") {
        const conflict = await checkForConflicts(gitB, filePath, fileContent);

        if (conflict.hasConflict) {
          const resolved = await resolveConflict(
            filePath,
            conflict,
            conflictStrategy
          );
          if (!resolved) {
            console.log(`  Failed to resolve conflict for ${filePath}`);
            return false;
          }
          return true;
        }
      }

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

// Create a pull request for the changes instead of pushing directly
const createPullRequestForChanges = async (commitHash, commitMessage) => {
  try {
    console.log(
      `\n=== Creating Pull Request for changes from commit ${commitHash.substring(
        0,
        7
      )} ===`
    );

    // Create git instances for both repositories
    const gitA = createGit(repoAPath);
    const gitB = createGit(repoBPath);

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

    // Create a commit message array for the PR generator
    const commitMessages = [
      {
        hash: commitHash,
        message: commitMessage,
        date: new Date().toISOString(),
      },
    ];

    // Use the existing PR creation functionality
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

// Create a single PR for all commits from a specific date
const createPRForAllCommitsFromDate = async (dateString) => {
  try {
    console.log(
      `\n=== Creating PR for all commits from date: ${dateString} ===`
    );

    const git = createGit(repoAPath);

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
        await gitB.checkoutLocalBranch(branchName);
        console.log(`Created and checked out branch: ${branchName}`);
      } catch (err) {
        await gitB.deleteLocalBranch(branchName, true);
        console.error(`Error creating branch ${branchName}:`, err.message);
        await gitB.checkoutLocalBranch(branchName);
        console.log(`Created and checked out branch: ${branchName}`);
        // return { success: false, error: err.message };
      }
    } else {
      console.log(`[DRY RUN] Would create and checkout branch: ${branchName}`);
    }

    let totalFilesProcessed = 0;
    let allFileChanges = [];

    // Process each commit and collect all changes
    for (const commit of commits.reverse()) {
      console.log(`\nProcessing commit: ${commit.hash.substring(0, 7)}`);
      console.log(`Commit Date: ${commit.date}`);
      console.log(`Commit Message: ${commit.message}`);

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

        // // Add commit details to PR description
        // for (const commit of commits.reverse()) {
        //   commitMessage += `- ${commit.hash.substring(0, 7)}: ${
        //     commit.message.split("\n")[0]
        //   }\n`;
        // }

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

        // Create a commit message array for PR generator
        const commitMessages = commits.map((commit) => ({
          hash: commit.hash,
          message: commit.message,
          date: commit.date,
        }));

        // Use existing PR creation functionality
        const prResult = await mergeAndCreatePRNoClaude(
          diffBetweenBranches,
          commits[commits.length - 1].hash,
          commitMessages,
          branchName,
          dateString
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

const main = async () => {
  console.log("\n=== Checking Repo A for updates ===");
  console.log(`Repo A Path: ${repoAPath}`);
  console.log(`Repo A Branch: ${repoABranch}`);
  console.log(`Repo B Path: ${repoBPath}`);
  console.log(`Repo B Branch: ${repoBBranch}`);
  console.log(`Dry Run: ${dryRun ? "Yes" : "No"}`);

  if (includePatterns.length > 0) {
    console.log(`Include Patterns: ${includePatterns.join(", ")}`);
  }

  if (excludePatterns.length > 0) {
    console.log(`Exclude Patterns: ${excludePatterns.join(", ")}`);
  }

  const git = createGit(repoAPath);
  const repoRoot = await getRepoRoot(git);
  let currentLocalCommit = await getCurrentLocalCommit(git);
  let currentLocalCommitDate = await getLocalCommitDate(
    git,
    currentLocalCommit
  );
  let nextDay = moment(currentLocalCommitDate).add(1, "day");
  let nextDayCommits = await getCommitsFromDate(
    git,
    nextDay.format("YYYY-MM-DD"),
    repoABranch
  );

  console.log(
    `Found ${nextDayCommits.length} commits for ${nextDay.format("YYYY-MM-DD")}`
  );

  // Create a single PR for all commits from the date
  const result = await createPRForAllCommitsFromDate(
    nextDay.format("YYYY-MM-DD")
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
};

main();
