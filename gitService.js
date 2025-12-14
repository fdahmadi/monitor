import simpleGit from "simple-git";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import logger from "./logger.js";
import { GitError } from "./errors.js";

/**
 * Git service class for handling all git operations
 * Encapsulates git functionality with proper error handling and logging
 */
class GitService {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.git = simpleGit({ baseDir: repoPath });
    this.logger = logger.child(`GitService[${path.basename(repoPath)}]`);
  }

  /**
   * Get the root directory of the Git repository
   * @returns {Promise<string|null>} Repository root path or null if error
   */
  async getRepoRoot() {
    try {
      const root = await this.git.revparse(["--show-toplevel"]);
      return root.trim();
    } catch (err) {
      this.logger.error("Could not determine Git repository root", {
        error: err.message,
      });
      throw new GitError(
        "Could not determine Git repository root",
        "REPO_ROOT_ERROR",
        { originalError: err.message }
      );
    }
  }

  /**
   * Get the current commit hash
   * @returns {Promise<string|null>} Current commit hash or null if error
   */
  async getCurrentCommit() {
    try {
      const log = await this.git.log(["-1"]);
      return log.latest?.hash || null;
    } catch (err) {
      this.logger.error("Could not get current commit", {
        error: err.message,
      });
      throw new GitError(
        "Could not get current commit",
        "GET_CURRENT_COMMIT_ERROR",
        { originalError: err.message }
      );
    }
  }

  /**
   * Get the date of a specific commit
   * @param {string} commitHash - Commit hash
   * @returns {Promise<string|null>} Commit date or null if error
   */
  async getCommitDate(commitHash) {
    try {
      const log = await this.git.log({ maxCount: 1, from: commitHash });
      return log.latest?.date || null;
    } catch (err) {
      this.logger.error(`Could not get date for commit ${commitHash}`, {
        error: err.message,
      });
      throw new GitError(
        `Could not get date for commit ${commitHash}`,
        "GET_COMMIT_DATE_ERROR",
        { commitHash, originalError: err.message }
      );
    }
  }

  /**
   * Fetch latest changes from remote
   * @param {string} remote - Remote name (default: "origin")
   * @param {string} branch - Branch name
   * @returns {Promise<boolean>} Success status
   */
  async fetch(remote = "origin", branch) {
    try {
      this.logger.debug(`Fetching from ${remote}/${branch}`);
      await this.git.fetch(remote, branch);
      return true;
    } catch (err) {
      this.logger.error(`Failed to fetch from ${remote}/${branch}`, {
        error: err.message,
      });
      throw new GitError(
        `Failed to fetch from ${remote}/${branch}`,
        "FETCH_ERROR",
        { remote, branch, originalError: err.message }
      );
    }
  }

  /**
   * Pull latest changes from remote
   * @param {string} remote - Remote name (default: "origin")
   * @param {string} branch - Branch name
   * @returns {Promise<boolean>} Success status
   */
  async pull(remote = "origin", branch) {
    try {
      this.logger.debug(`Pulling from ${remote}/${branch}`);
      await this.git.pull(remote, branch);
      return true;
    } catch (err) {
      this.logger.error(`Failed to pull from ${remote}/${branch}`, {
        error: err.message,
      });
      throw new GitError(
        `Failed to pull from ${remote}/${branch}`,
        "PULL_ERROR",
        { remote, branch, originalError: err.message }
      );
    }
  }

  /**
   * Push changes to remote
   * @param {string} remote - Remote name (default: "origin")
   * @param {string} branch - Branch name
   * @param {Array<string>} options - Additional push options
   * @returns {Promise<boolean>} Success status
   */
  async push(remote = "origin", branch, options = []) {
    try {
      this.logger.debug(`Pushing to ${remote}/${branch}`);
      await this.git.push(remote, branch, options);
      return true;
    } catch (err) {
      this.logger.error(`Failed to push to ${remote}/${branch}`, {
        error: err.message,
      });
      throw new GitError(
        `Failed to push to ${remote}/${branch}`,
        "PUSH_ERROR",
        { remote, branch, options, originalError: err.message }
      );
    }
  }

  /**
   * Checkout a branch
   * @param {string} branch - Branch name
   * @returns {Promise<boolean>} Success status
   */
  async checkout(branch) {
    try {
      this.logger.debug(`Checking out branch ${branch}`);
      await this.git.checkout(branch);
      return true;
    } catch (err) {
      this.logger.error(`Failed to checkout branch ${branch}`, {
        error: err.message,
      });
      throw new GitError(
        `Failed to checkout branch ${branch}`,
        "CHECKOUT_ERROR",
        { branch, originalError: err.message }
      );
    }
  }

  /**
   * Create and checkout a new local branch
   * @param {string} branchName - New branch name
   * @returns {Promise<boolean>} Success status
   */
  async createAndCheckoutBranch(branchName) {
    try {
      this.logger.debug(`Creating and checking out branch ${branchName}`);
      await this.git.checkoutLocalBranch(branchName);
      return true;
    } catch (err) {
      this.logger.error(`Failed to create and checkout branch ${branchName}`, {
        error: err.message,
      });
      throw new GitError(
        `Failed to create and checkout branch ${branchName}`,
        "CREATE_BRANCH_ERROR",
        { branchName, originalError: err.message }
      );
    }
  }

  /**
   * Delete a local branch
   * @param {string} branchName - Branch name
   * @param {boolean} force - Force delete (default: false)
   * @returns {Promise<boolean>} Success status
   */
  async deleteBranch(branchName, force = false) {
    try {
      this.logger.debug(`Deleting branch ${branchName} (force: ${force})`);
      await this.git.deleteLocalBranch(branchName, force);
      return true;
    } catch (err) {
      this.logger.error(`Failed to delete branch ${branchName}`, {
        error: err.message,
      });
      throw new GitError(
        `Failed to delete branch ${branchName}`,
        "DELETE_BRANCH_ERROR",
        { branchName, force, originalError: err.message }
      );
    }
  }

  /**
   * Reset repository to a specific commit
   * @param {string} commitHash - Commit hash
   * @param {string} mode - Reset mode (default: "hard")
   * @returns {Promise<boolean>} Success status
   */
  async reset(commitHash, mode = "hard") {
    try {
      this.logger.debug(`Resetting to commit ${commitHash} (${mode} reset)`);
      await this.git.reset([`--${mode}`, commitHash]);
      return true;
    } catch (err) {
      this.logger.error(`Failed to reset to commit ${commitHash}`, {
        error: err.message,
      });
      throw new GitError(
        `Failed to reset to commit ${commitHash}`,
        "RESET_ERROR",
        { commitHash, mode, originalError: err.message }
      );
    }
  }

  /**
   * Add files to staging area
   * @param {string} files - Files to add (default: ".")
   * @returns {Promise<boolean>} Success status
   */
  async add(files = ".") {
    try {
      this.logger.debug(`Adding files to staging area: ${files}`);
      await this.git.add(files);
      return true;
    } catch (err) {
      this.logger.error(`Failed to add files to staging area`, {
        error: err.message,
      });
      throw new GitError("Failed to add files to staging area", "ADD_ERROR", {
        files,
        originalError: err.message,
      });
    }
  }

  /**
   * Commit staged changes
   * @param {string} message - Commit message
   * @returns {Promise<boolean>} Success status
   */
  async commit(message) {
    try {
      this.logger.debug(`Committing with message: ${message}`);
      await this.git.commit(message);
      return true;
    } catch (err) {
      this.logger.error(`Failed to commit changes`, {
        error: err.message,
      });
      throw new GitError("Failed to commit changes", "COMMIT_ERROR", {
        message,
        originalError: err.message,
      });
    }
  }

  /**
   * Get diff between commits or branches
   * @param {Array<string>} options - Diff options
   * @returns {Promise<string>} Diff output
   */
  async diff(options = []) {
    try {
      this.logger.debug(`Getting diff with options: ${options.join(" ")}`);
      return await this.git.diff(options);
    } catch (err) {
      this.logger.error(`Failed to get diff`, {
        error: err.message,
      });
      throw new GitError("Failed to get diff", "DIFF_ERROR", {
        options,
        originalError: err.message,
      });
    }
  }

  /**
   * Get file content at a specific commit
   * @param {string} commitHash - Commit hash
   * @param {string} filePath - File path
   * @returns {Promise<string>} File content
   */
  async show(commitHash, filePath) {
    try {
      this.logger.debug(
        `Getting file content for ${filePath} at ${commitHash}`
      );
      return await this.git.show([`${commitHash}:${filePath}`]);
    } catch (err) {
      this.logger.error(`Failed to get file content`, {
        error: err.message,
      });
      throw new GitError("Failed to get file content", "SHOW_ERROR", {
        commitHash,
        filePath,
        originalError: err.message,
      });
    }
  }

  /**
   * Get commit history
   * @param {Array<string>} options - Log options
   * @returns {Promise<Array>} Array of commit objects
   */
  async log(options = []) {
    try {
      this.logger.debug(`Getting log with options: ${options.join(" ")}`);
      const log = await this.git.log(options);

      return log.all.map((commit) => ({
        hash: commit.hash,
        message: commit.message,
        date: commit.date,
        author: commit.author_name,
        authorEmail: commit.author_email,
      }));
    } catch (err) {
      this.logger.error(`Failed to get commit history`, {
        error: err.message,
      });
      throw new GitError("Failed to get commit history", "LOG_ERROR", {
        options,
        originalError: err.message,
      });
    }
  }

  /**
   * Get commits from a specific date
   * @param {string} date - Date in YYYY-MM-DD format
   * @param {string} branch - Branch name
   * @param {boolean} useRemote - Use remote branch (default: true)
   * @returns {Promise<Array>} Array of commit objects
   */
  async getCommitsFromDate(date, branch = "main", useRemote = true) {
    try {
      const formattedDate = new Date(date).toISOString().split("T")[0];
      const branchRef = useRemote ? `origin/${branch}` : branch;

      if (useRemote) {
        await this.fetch("origin", branch);
      }

      this.logger.debug(
        `Getting commits from ${formattedDate} on ${branchRef}`
      );
      const commits = await this.log([
        `--since=${formattedDate} 00:00:00`,
        `--until=${formattedDate} 23:59:59`,
        branchRef,
      ]);

      return commits;
    } catch (err) {
      this.logger.error(`Failed to get commits from date ${date}`, {
        error: err.message,
      });
      throw new GitError(
        `Failed to get commits from date ${date}`,
        "GET_COMMITS_FROM_DATE_ERROR",
        { date, branch, useRemote, originalError: err.message }
      );
    }
  }

  /**
   * Get diff for a single commit
   * @param {string} commitHash - Commit hash
   * @returns {Promise<string>} Diff output
   */
  async getSingleCommitDiff(commitHash) {
    try {
      this.logger.debug(`Getting diff for commit ${commitHash}`);

      try {
        // Try to get diff between parent and commit
        return await this.diff([
          `${commitHash}^`,
          commitHash,
          "--diff-filter=ACDMRT",
          "--unified=3",
        ]);
      } catch (err) {
        // If commit^ doesn't exist (e.g., first commit), try to get diff from empty tree
        this.logger.debug(
          `Failed to get diff with parent, trying from empty tree`
        );
        return await this.diff([
          "--root",
          commitHash,
          "--diff-filter=ACDMRT",
          "--unified=3",
        ]);
      }
    } catch (err) {
      this.logger.error(`Failed to get diff for commit ${commitHash}`, {
        error: err.message,
      });
      throw new GitError(
        `Failed to get diff for commit ${commitHash}`,
        "GET_SINGLE_COMMIT_DIFF_ERROR",
        { commitHash, originalError: err.message }
      );
    }
  }

  /**
   * Get the latest commit hash from remote branch
   * @param {string} branch - Branch name
   * @returns {Promise<string|null>} Latest commit hash or null if error
   */
  async getLatestRemoteCommit(branch) {
    try {
      await this.fetch("origin", branch);
      const log = await this.git.log([`origin/${branch}`, "-1"]);
      return log.latest?.hash || null;
    } catch (err) {
      this.logger.error(`Failed to get latest commit from origin/${branch}`, {
        error: err.message,
      });
      throw new GitError(
        `Failed to get latest commit from origin/${branch}`,
        "GET_LATEST_REMOTE_COMMIT_ERROR",
        { branch, originalError: err.message }
      );
    }
  }

  /**
   * Get commit messages between two commits
   * @param {string} fromCommit - Starting commit (exclusive)
   * @param {string} toCommit - Ending commit (inclusive)
   * @returns {Promise<Array>} Array of commit objects
   */
  async getCommitMessages(fromCommit, toCommit) {
    try {
      // If commits are the same, no new commits
      if (fromCommit && toCommit && fromCommit === toCommit) {
        return [];
      }

      // Build log range using git range format
      let logRange;
      if (!fromCommit) {
        // No local commit yet, get all commits up to toCommit (limit to avoid too many commits)
        logRange = [toCommit, "-20"]; // Last 20 commits max
      } else {
        // Get commits between fromCommit (exclusive) and toCommit (inclusive)
        logRange = [`${fromCommit}..${toCommit}`];
      }

      this.logger.debug(
        `Getting commit messages with range: ${logRange.join(" ")}`
      );
      const commits = await this.log(logRange);

      // Return commits in chronological order (oldest first)
      return commits.reverse();
    } catch (err) {
      this.logger.error(`Failed to get commit messages`, {
        error: err.message,
      });
      throw new GitError(
        "Failed to get commit messages",
        "GET_COMMIT_MESSAGES_ERROR",
        { fromCommit, toCommit, originalError: err.message }
      );
    }
  }
}

/**
 * Factory function to create GitService instances
 * @param {string} repoPath - Path to the repository
 * @returns {GitService} GitService instance
 */
export function createGitService(repoPath) {
  return new GitService(repoPath);
}

export default GitService;
