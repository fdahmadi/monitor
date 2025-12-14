import moment from "moment";
import config from "./config.js";
import logger from "./logger.js";
import { createGitService } from "./gitService.js";
import { createFileService } from "./fileService.js";
import { createPRService } from "./prService.js";
import { BaseError } from "./errors.js";

/**
 * Orchestrator class that coordinates all services
 * Manages the main application logic for syncing repositories and creating PRs
 */
class Orchestrator {
  constructor() {
    this.logger = logger.child("Orchestrator");
    this.repoAConfig = config.getRepoA();
    this.repoBConfig = config.getRepoB();
    this.options = config.getOptions();
    
    // Initialize services
    this.repoAGitService = createGitService(this.repoAConfig.path);
    this.repoBGitService = createGitService(this.repoBConfig.path);
    this.repoBFileService = createFileService(this.repoBConfig.path);
    this.prService = createPRService();
  }

  /**
   * Run the main synchronization process
   * @returns {Promise<Object>} Result object with success status and PR URL
   */
  async run() {
    try {
      this.logger.info("Starting repository synchronization process");
      
      // Print configuration
      this.printConfiguration();

      // Get current state of Repository A
      const currentLocalCommit = await this.repoAGitService.getCurrentCommit();
      const currentLocalCommitDate = await this.repoAGitService.getCommitDate(currentLocalCommit);
      
      // Calculate next day to process
      const nextDay = moment(currentLocalCommitDate).add(1, "day");
      const nextDayCommits = await this.repoAGitService.getCommitsFromDate(
        nextDay.format("YYYY-MM-DD"),
        this.repoAConfig.branch
      );

      this.logger.info(
        `Found ${nextDayCommits.length} commits for ${nextDay.format("YYYY-MM-DD")}`
      );

      // Create a single PR for all commits from the date
      const result = await this.createPRForAllCommitsFromDate(
        nextDay.format("YYYY-MM-DD"),
        nextDayCommits
      );

      if (result.success) {
        if (result.prUrl) {
          this.logger.info(`PR created: ${result.prUrl}`);
        } else {
          this.logger.info(`No PR created: ${result.reason}`);
        }
      } else {
        this.logger.error(`Failed to create PR: ${result.error}`);
      }

      return result;
    } catch (err) {
      this.logger.error("Error in orchestrator", {
        error: err.message,
      });
      
      if (err instanceof BaseError) {
        throw err;
      }
      
      throw new BaseError(
        "Unexpected error in orchestrator",
        "ORCHESTRATOR_ERROR",
        { originalError: err.message }
      );
    }
  }

  /**
   * Print configuration information
   */
  printConfiguration() {
    this.logger.info("=== Configuration ===");
    this.logger.info(`Repo A Path: ${this.repoAConfig.path}`);
    this.logger.info(`Repo A Branch: ${this.repoAConfig.branch}`);
    this.logger.info(`Repo B Path: ${this.repoBConfig.path}`);
    this.logger.info(`Repo B Branch: ${this.repoBConfig.branch}`);
    this.logger.info(`Dry Run: ${this.options.dryRun ? "Yes" : "No"}`);

    if (this.options.includePatterns.length > 0) {
      this.logger.info(`Include Patterns: ${this.options.includePatterns.join(", ")}`);
    }

    if (this.options.excludePatterns.length > 0) {
      this.logger.info(`Exclude Patterns: ${this.options.excludePatterns.join(", ")}`);
    }
  }

  /**
   * Push changes to remote Repository B
   * @returns {Promise<boolean>} Success status
   */
  async pushChangesToRepoB() {
    try {
      this.logger.info("Pushing changes to remote Repository B");

      if (this.options.dryRun) {
        this.logger.info("[DRY RUN] Would push changes to remote Repository B");
        return true;
      }

      await this.repoBGitService.push("origin", this.repoBConfig.branch);
      this.logger.info("Successfully pushed changes to remote Repository B");
      return true;
    } catch (err) {
      this.logger.error("Error pushing changes to remote Repository B", {
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * Apply commit changes from Repository A to Repository B
   * @param {string} commitHash - Commit hash
   * @param {string} commitMessage - Commit message
   * @returns {Promise<boolean>} Success status
   */
  async applyCommitChangesToRepoB(commitHash, commitMessage) {
    try {
      this.logger.info(
        `Applying changes from commit ${commitHash.substring(0, 7)} to Repository B`
      );

      // Get the diff for the specific commit from Repository A
      const diff = await this.repoAGitService.getSingleCommitDiff(commitHash);

      if (!diff || diff.trim() === "") {
        this.logger.info("No changes to apply for this commit");
        return true;
      }

      // Parse the diff to extract file changes
      const fileChanges = this.repoBFileService.parseDiffForFiles(diff);

      if (fileChanges.length === 0) {
        this.logger.info("No file changes detected in this commit");
        return true;
      }

      // Filter files based on include/exclude patterns
      const filteredFileChanges = this.repoBFileService.filterFileChanges(fileChanges);

      if (filteredFileChanges.length === 0) {
        this.logger.info("No files match the include/exclude patterns");
        return true;
      }

      this.logger.info(
        `Found ${fileChanges.length} file(s) in commit, ${filteredFileChanges.length} file(s) to apply changes to`
      );

      // Ensure Repository B is on the correct branch
      await this.ensureRepoBBranch();

      // Pull latest changes from remote Repository B to avoid conflicts
      if (!this.options.dryRun) {
        try {
          await this.repoBGitService.pull("origin", this.repoBConfig.branch);
          this.logger.info("Pulled latest changes from remote Repository B");
        } catch (err) {
          this.logger.warn(
            "Could not pull latest changes from remote Repository B",
            { error: err.message }
          );
        }
      }

      // Apply each file change to Repository B
      const filesProcessed = await this.repoBFileService.applyFileChanges(
        this.repoAGitService,
        filteredFileChanges,
        commitHash,
        this.options.dryRun
      );

      // Commit the changes to Repository B if any files were processed
      if (filesProcessed > 0) {
        if (!this.options.dryRun) {
          await this.repoBGitService.add(".");
          await this.repoBGitService.commit(
            `Sync from Repository A: ${commitMessage}\n\nOriginal commit: ${commitHash}`
          );
          this.logger.info(
            `Successfully applied changes from commit ${commitHash.substring(0, 7)} to Repository B`
          );
        } else {
          this.logger.info(
            `[DRY RUN] Would commit changes from commit ${commitHash.substring(0, 7)} to Repository B`
          );
        }

        // Push changes to remote Repository B
        await this.pushChangesToRepoB();
      } else {
        this.logger.info(
          `No files were processed for commit ${commitHash.substring(0, 7)}`
        );
      }

      return true;
    } catch (err) {
      this.logger.error(
        `Error applying changes from commit ${commitHash.substring(0, 7)}`,
        { error: err.message }
      );
      throw err;
    }
  }

  /**
   * Ensure Repository B is on the correct branch
   */
  async ensureRepoBBranch() {
    try {
      await this.repoBGitService.checkout(this.repoBConfig.branch);
    } catch (err) {
      this.logger.warn(
        `Branch ${this.repoBConfig.branch} might not exist locally, fetching...`
      );
      await this.repoBGitService.fetch("origin", this.repoBConfig.branch);
      await this.repoBGitService.checkout(this.repoBConfig.branch);
    }
  }

  /**
   * Create a pull request for the changes instead of pushing directly
   * @param {string} commitHash - Commit hash
   * @param {string} commitMessage - Commit message
   * @returns {Promise<Object>} Result object with success status and PR URL
   */
  async createPullRequestForChanges(commitHash, commitMessage) {
    try {
      this.logger.info(
        `Creating Pull Request for changes from commit ${commitHash.substring(0, 7)}`
      );

      // Get the diff for the specific commit from Repository A
      const diff = await this.repoAGitService.getSingleCommitDiff(commitHash);

      if (!diff || diff.trim() === "") {
        this.logger.info("No changes to create PR for this commit");
        return { success: true, prUrl: null, reason: "No changes" };
      }

      // Parse the diff to extract file changes
      const fileChanges = this.repoBFileService.parseDiffForFiles(diff);

      if (fileChanges.length === 0) {
        this.logger.info("No file changes detected in this commit");
        return { success: true, prUrl: null, reason: "No file changes" };
      }

      // Filter files based on include/exclude patterns
      const filteredFileChanges = this.repoBFileService.filterFileChanges(fileChanges);

      if (filteredFileChanges.length === 0) {
        this.logger.info("No files match the include/exclude patterns");
        return { success: true, prUrl: null, reason: "No matching files" };
      }

      this.logger.info(
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
      const prResult = await this.prService.mergeAndCreatePR(
        diff,
        commitHash,
        commitMessages
      );

      if (prResult.success) {
        this.logger.info(
          `Successfully created PR for commit ${commitHash.substring(0, 7)}`
        );
        return { success: true, prUrl: prResult.prUrl };
      } else {
        this.logger.error(
          `Failed to create PR for commit ${commitHash.substring(0, 7)}: ${
            prResult.reason || prResult.error
          }`
        );
        return { success: false, error: prResult.reason || prResult.error };
      }
    } catch (err) {
      this.logger.error(
        `Error creating PR for commit ${commitHash.substring(0, 7)}`,
        { error: err.message }
      );
      throw err;
    }
  }

  /**
   * Create a single PR for all commits from a specific date
   * @param {string} dateString - Date string in YYYY-MM-DD format
   * @param {Array} commits - Array of commit objects
   * @returns {Promise<Object>} Result object with success status and PR URL
   */
  async createPRForAllCommitsFromDate(dateString, commits) {
    try {
      this.logger.info(`Creating PR for all commits from date: ${dateString}`);

      if (commits.length === 0) {
        this.logger.info(`No commits found for ${dateString}`);
        return { success: true, prUrl: null, reason: "No commits" };
      }

      this.logger.info(`Found ${commits.length} commits from ${dateString}`);

      // Generate branch name based on date
      const branchName = `pr-${dateString}`;

      // Ensure Repository B is on the correct branch
      await this.ensureRepoBBranch();
      await this.repoBGitService.reset(["--hard", this.repoBConfig.branch]);

      // Pull latest changes from remote Repository B
      if (!this.options.dryRun) {
        try {
          await this.repoBGitService.pull("origin", this.repoBConfig.branch);
          this.logger.info("Pulled latest changes from remote Repository B");
        } catch (err) {
          this.logger.warn(
            "Could not pull latest changes from remote Repository B",
            { error: err.message }
          );
        }
      }

      // Create and checkout new branch
      if (!this.options.dryRun) {
        try {
          await this.repoBGitService.createAndCheckoutBranch(branchName);
          this.logger.info(`Created and checked out branch: ${branchName}`);
        } catch (err) {
          await this.repoBGitService.deleteBranch(branchName, true);
          this.logger.error(`Error creating branch ${branchName}`, {
            error: err.message,
          });
          await this.repoBGitService.createAndCheckoutBranch(branchName);
          this.logger.info(`Created and checked out branch: ${branchName}`);
        }
      } else {
        this.logger.info(`[DRY RUN] Would create and checkout branch: ${branchName}`);
      }

      let totalFilesProcessed = 0;
      let allFileChanges = [];

      // Process each commit and collect all changes
      for (const commit of commits.reverse()) {
        this.logger.info(`Processing commit: ${commit.hash.substring(0, 7)}`);
        this.logger.info(`Commit Date: ${commit.date}`);
        this.logger.info(`Commit Message: ${commit.message}`);

        // Get the diff for the specific commit from Repository A
        const diff = await this.repoAGitService.getSingleCommitDiff(commit.hash);

        if (!diff || diff.trim() === "") {
          this.logger.info("No changes in this commit");
          continue;
        }

        // Parse the diff to extract file changes
        const fileChanges = this.repoBFileService.parseDiffForFiles(diff);

        if (fileChanges.length === 0) {
          this.logger.info("No file changes detected in this commit");
          continue;
        }

        // Filter files based on include/exclude patterns
        const filteredFileChanges = this.repoBFileService.filterFileChanges(fileChanges);

        if (filteredFileChanges.length === 0) {
          this.logger.info("No files match the include/exclude patterns");
          continue;
        }

        this.logger.info(
          `Found ${fileChanges.length} file(s) in commit, ${filteredFileChanges.length} file(s) to apply`
        );

        // Apply each file change to Repository B
        if (!this.options.dryRun) {
          const filesProcessed = await this.repoBFileService.applyFileChanges(
            this.repoAGitService,
            filteredFileChanges,
            commit.hash
          );
          totalFilesProcessed += filesProcessed;
        } else {
          this.logger.info(
            `[DRY RUN] Would apply ${filteredFileChanges.length} file changes from commit ${commit.hash.substring(0, 7)}`
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
        if (!this.options.dryRun) {
          // Stage all changes
          await this.repoBGitService.add(".");

          // Create commit message
          const commitMessage = `Sync changes from Repository A (${dateString})\n\nThis PR includes changes from ${commits.length} commits:\n\n`;

          // Commit changes
          await this.repoBGitService.commit(commitMessage);
          this.logger.info(`Committed all changes to branch ${branchName}`);

          // Push branch to remote
          await this.repoBGitService.push("origin", branchName, ["-f"]);
          this.logger.info(`Pushed branch ${branchName} to remote`);

          // Create PR using the existing PR creation functionality
          // We need to create a diff between the base branch and our new branch
          const diffBetweenBranches = await this.repoBGitService.diff([
            `${this.repoBConfig.branch}...${branchName}`,
            "--unified=3",
          ]);

          // Use existing PR creation functionality
          const prResult = await this.prService.mergeAndCreatePR(
            diffBetweenBranches,
            commits[commits.length - 1].hash,
            commits,
            branchName,
            dateString
          );

          if (prResult.success) {
            this.logger.info(
              `Successfully created PR for all commits from ${dateString}`
            );
            return { success: true, prUrl: prResult.prUrl };
          } else {
            this.logger.error(
              `Failed to create PR: ${prResult.reason || prResult.error}`
            );
            return { success: false, error: prResult.reason || prResult.error };
          }
        } else {
          this.logger.info(
            `[DRY RUN] Would commit all changes and create PR for date ${dateString}`
          );
          return { success: true, prUrl: null, reason: "Dry run" };
        }
      } else {
        this.logger.info(`No files were processed for date ${dateString}`);
        return { success: true, prUrl: null, reason: "No files processed" };
      }
    } catch (err) {
      this.logger.error(`Error creating PR for date ${dateString}`, {
        error: err.message,
      });
      throw err;
    }
  }
}

/**
 * Factory function to create Orchestrator instances
 * @returns {Orchestrator} Orchestrator instance
 */
export function createOrchestrator() {
  return new Orchestrator();
}

export default Orchestrator;
