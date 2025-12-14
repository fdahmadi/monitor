import { Octokit } from "@octokit/rest";
import { extractChangedFiles } from "./createSmartPR.js";
import logger from "./logger.js";
import config from "./config.js";
import { PullRequestError, ApiError } from "./errors.js";

/**
 * Pull Request service class for handling PR operations
 * Encapsulates PR functionality with proper error handling and logging
 */
class PRService {
  constructor() {
    const githubConfig = config.getGithub();
    
    if (!githubConfig.token) {
      throw new PullRequestError(
        "GitHub token is required for PR operations",
        "MISSING_GITHUB_TOKEN"
      );
    }

    this.octokit = new Octokit({ auth: githubConfig.token });
    this.owner = githubConfig.owner;
    this.repo = githubConfig.repo;
    this.logger = logger.child("PRService");
  }

  /**
   * Get list of open pull requests and their changed files
   * @returns {Promise<Array>} Array of PR objects with number, title, and files array
   */
  async getOpenPullRequests() {
    try {
      this.logger.info("Fetching open pull requests");
      
      // Get all open pull requests
      const { data: prs } = await this.octokit.pulls.list({
        owner: this.owner,
        repo: this.repo,
        state: "open",
        per_page: 100, // Get up to 100 open PRs
      });

      this.logger.info(`Found ${prs.length} open pull request(s)`);

      // For each PR, get the list of changed files
      const prsWithFiles = await Promise.all(
        prs.map(async (pr) => {
          try {
            const { data: files } = await this.octokit.pulls.listFiles({
              owner: this.owner,
              repo: this.repo,
              pull_number: pr.number,
              per_page: 100, // Get up to 100 files per PR
            });

            const filePaths = files.map((file) => file.filename);

            return {
              number: pr.number,
              title: pr.title,
              url: pr.html_url,
              files: filePaths,
            };
          } catch (err) {
            this.logger.warn(
              `Could not get files for PR #${pr.number}`,
              { error: err.message }
            );
            return {
              number: pr.number,
              title: pr.title,
              url: pr.html_url,
              files: [],
            };
          }
        })
      );

      return prsWithFiles;
    } catch (err) {
      this.logger.error("Error getting open pull requests", {
        error: err.message,
      });
      throw new PullRequestError(
        "Error getting open pull requests",
        "GET_OPEN_PRS_ERROR",
        { originalError: err.message }
      );
    }
  }

  /**
   * Check if files in current commit overlap with files in open PRs
   * @param {Set<string>} currentFiles - Set of file paths in current commit
   * @param {Array} openPRs - Array of PR objects with files array
   * @returns {Object} { hasConflict: boolean, conflictingPRs: Array }
   */
  checkFileConflicts(currentFiles, openPRs) {
    const conflictingPRs = [];

    for (const pr of openPRs) {
      const prFiles = new Set(pr.files);
      const intersection = [...currentFiles].filter((file) => prFiles.has(file));

      if (intersection.length > 0) {
        conflictingPRs.push({
          prNumber: pr.number,
          prTitle: pr.title,
          prUrl: pr.url,
          conflictingFiles: intersection,
        });
      }
    }

    return {
      hasConflict: conflictingPRs.length > 0,
      conflictingPRs,
    };
  }

  /**
   * Create a pull request on GitHub
   * @param {string} title - PR title
   * @param {string} body - PR body/description
   * @param {string} head - Head branch
   * @param {string} base - Base branch
   * @returns {Promise<Object>} PR object with URL
   */
  async createPullRequest(title, body, head, base) {
    try {
      this.logger.info(`Creating PR: ${title}`);
      
      const pr = await this.octokit.pulls.create({
        owner: this.owner,
        repo: this.repo,
        title,
        body,
        head,
        base,
      });

      this.logger.info(`Successfully created PR: ${pr.data.html_url}`);
      return {
        success: true,
        prUrl: pr.data.html_url,
        prNumber: pr.data.number,
      };
    } catch (err) {
      this.logger.error("Error creating pull request", {
        error: err.message,
      });
      throw new PullRequestError(
        "Error creating pull request",
        "CREATE_PR_ERROR",
        { title, head, base, originalError: err.message }
      );
    }
  }

  /**
   * Helper function to create commit URL
   * @param {string} commitHash - Commit hash
   * @returns {string|null} Commit URL or null if repo URL is not configured
   */
  createCommitUrl(commitHash) {
    const repoAUrl = process.env.REPO_A_URL;
    if (!repoAUrl) return null;

    // Remove .git suffix if present
    const baseUrl = repoAUrl.replace(/\.git$/, "");

    // Handle different Git hosting platforms
    if (baseUrl.includes("github.com")) {
      return `${baseUrl}/commit/${commitHash}`;
    } else if (baseUrl.includes("gitlab.com") || baseUrl.includes("gitlab")) {
      return `${baseUrl}/-/commit/${commitHash}`;
    } else if (baseUrl.includes("bitbucket.org")) {
      return `${baseUrl}/commits/${commitHash}`;
    } else {
      return `${baseUrl}/commit/${commitHash}`;
    }
  }

  /**
   * Generate PR title and description from commit messages
   * @param {Array} commitMessages - Array of commit objects with hash, message, and date
   * @param {string} dateString - Date string for the PR
   * @returns {Object} { title, description }
   */
  generatePRContent(commitMessages, dateString) {
    let title = `Auto-merge from Upstream (${dateString})`;
    let description = `This PR contains changes automatically merged from Upstream (${dateString}).\n\n`;

    if (commitMessages && commitMessages.length > 0) {
      if (commitMessages.length === 1) {
        const commit = commitMessages[0];
        const messageLines = commit.message.trim().split("\n");
        title = messageLines[0] || title;

        const commitHashShort = commit.hash.substring(0, 7);
        const commitUrl = this.createCommitUrl(commit.hash);

        description += `## 📝 Commit from Repository A\n\n`;
        if (commitUrl) {
          description += `- ${title} ([${commitHashShort}](${commitUrl}))\n\n`;
        } else {
          description += `- ${title} (\`${commitHashShort}\`)\n\n`;
        }

        if (messageLines.length > 1) {
          const messageBody = messageLines
            .slice(1)
            .filter((line) => line.trim())
            .join("\n");
          if (messageBody) {
            description += `\`\`\`\n${messageBody}\n\`\`\`\n`;
          }
        }
      } else {
        description += `## 📝 Commits from Repository A\n\n`;
        description += `This PR includes changes from **${commitMessages.length} commits**:\n\n`;

        commitMessages.forEach((commit, idx) => {
          const commitHashShort = commit.hash.substring(0, 7);
          const commitUrl = this.createCommitUrl(commit.hash);

          const messageLines = commit.message.trim().split("\n");
          const messageTitle = messageLines[0];
          const messageBody = messageLines
            .slice(1)
            .filter((line) => line.trim())
            .join("\n");

          if (commitUrl) {
            description += `${
              idx + 1
            }. ${messageTitle} ([${commitHashShort}](${commitUrl}))\n\n`;
          } else {
            description += `${
              idx + 1
            }. ${messageTitle} (\`${commitHashShort}\`)\n\n`;
          }

          if (messageBody) {
            description += `   \`\`\`\n   ${messageBody.replace(
              /\n/g,
              "\n   "
            )}\n   \`\`\`\n\n`;
          }
        });
      }
    }

    return { title, description };
  }

  /**
   * Merge changes from Repository A into Repository B and create a Pull Request
   * WITHOUT using Claude AI - just uses the diff directly
   * @param {string} diffText - Git diff between local and remote Repository A
   * @param {string} latestCommit - Latest commit hash from Repository A
   * @param {Array} commitMessages - Array of commit objects with hash, message, and date
   * @param {string} branchName - Branch name for the PR
   * @param {string} dateString - Date string for the PR
   * @returns {Promise<Object>} Result object with success status and PR URL
   */
  async mergeAndCreatePR(diffText, latestCommit, commitMessages = [], branchName, dateString) {
    try {
      if (!diffText || diffText.trim() === "") {
        this.logger.info("No new changes found in Repository A");
        return { success: false, reason: "No changes" };
      }

      this.logger.info("Extracting changed files");
      const changedFilesMap = extractChangedFiles(diffText);
      this.logger.info(`Found ${changedFilesMap.size} changed file(s)`);

      // Log file operations
      for (const [filePath, fileInfo] of changedFilesMap.entries()) {
        this.logger.debug(`  - ${filePath} (${fileInfo.operation})`);
      }

      // Get list of files in current commit
      const currentFiles = new Set(changedFilesMap.keys());

      // Check for conflicts with open PRs
      this.logger.info("Checking for file conflicts with open pull requests");
      const openPRs = await this.getOpenPullRequests();

      if (openPRs.length > 0) {
        const conflictCheck = this.checkFileConflicts(currentFiles, openPRs);

        if (conflictCheck.hasConflict) {
          this.logger.error("File conflicts detected with open pull requests");
          for (const conflict of conflictCheck.conflictingPRs) {
            this.logger.error(`PR #${conflict.prNumber}: ${conflict.prTitle}`);
            this.logger.error(`URL: ${conflict.prUrl}`);
            this.logger.error(
              `Conflicting files (${conflict.conflictingFiles.length}):`
            );
            conflict.conflictingFiles.forEach((file) => {
              this.logger.error(`  - ${file}`);
            });
          }
          this.logger.error("Stopping processing to avoid conflicts");
          return {
            success: false,
            reason: "File conflicts with open PRs",
            conflictingPRs: conflictCheck.conflictingPRs,
          };
        } else {
          this.logger.info("No file conflicts found with open pull requests");
        }
      } else {
        this.logger.info("No open pull requests found");
      }

      // Generate PR title and description
      const { title, description } = this.generatePRContent(commitMessages, dateString);

      // Create PR
      const repoBConfig = config.getRepoB();
      const result = await this.createPullRequest(
        title,
        description,
        branchName,
        repoBConfig.branch
      );

      return {
        success: true,
        prUrl: result.prUrl,
        prNumber: result.prNumber,
      };
    } catch (err) {
      this.logger.error("Error in mergeAndCreatePR", {
        error: err.message,
      });
      throw new PullRequestError(
        "Error in mergeAndCreatePR",
        "MERGE_CREATE_PR_ERROR",
        { originalError: err.message }
      );
    }
  }
}

/**
 * Factory function to create PRService instances
 * @returns {PRService} PRService instance
 */
export function createPRService() {
  return new PRService();
}

export default PRService;
