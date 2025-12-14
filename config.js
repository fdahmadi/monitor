import path from "node:path";
import { existsSync } from "node:fs";

/**
 * Configuration management module
 * Centralizes all environment variables and settings with validation
 */
class Config {
  constructor() {
    this.loadConfiguration();
    this.validateConfiguration();
  }

  loadConfiguration() {
    // Repository A configuration
    this.repoA = {
      path: this.resolvePath(process.env.REPO_A_PATH),
      branch: process.env.REPO_A_BRANCH || "main",
      url: process.env.REPO_A_URL,
    };

    // Repository B configuration
    this.repoB = {
      path: this.resolvePath(process.env.REPO_B_PATH),
      branch: process.env.REPO_B_BRANCH || "main",
    };

    // GitHub configuration
    this.github = {
      token: process.env.GITHUB_TOKEN,
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
    };

    // Processing options
    this.options = {
      dryRun: process.env.DRY_RUN === "true",
      includePatterns: this.parsePatterns(process.env.INCLUDE_PATTERNS),
      excludePatterns: this.parsePatterns(process.env.EXCLUDE_PATTERNS),
      conflictStrategy: process.env.CONFLICT_STRATEGY || "overwrite",
    };

    // Logging configuration
    this.logging = {
      level: process.env.LOG_LEVEL || "info",
      file: process.env.LOG_FILE,
    };
  }

  validateConfiguration() {
    const errors = [];

    // Validate required repository paths
    if (!this.repoA.path) {
      errors.push("REPO_A_PATH is required");
    } else if (!existsSync(this.repoA.path)) {
      errors.push(`REPO_A_PATH does not exist: ${this.repoA.path}`);
    }

    if (!this.repoB.path) {
      errors.push("REPO_B_PATH is required");
    } else if (!existsSync(this.repoB.path)) {
      errors.push(`REPO_B_PATH does not exist: ${this.repoB.path}`);
    }

    // Validate GitHub configuration if needed
    if (this.options.createPR) {
      if (!this.github.token) {
        errors.push("GITHUB_TOKEN is required when creating PRs");
      }
      if (!this.github.owner) {
        errors.push("GITHUB_OWNER is required when creating PRs");
      }
      if (!this.github.repo) {
        errors.push("GITHUB_REPO is required when creating PRs");
      }
    }

    // Validate conflict strategy
    const validStrategies = ["overwrite", "keep", "backup", "merge"];
    if (!validStrategies.includes(this.options.conflictStrategy)) {
      errors.push(
        `CONFLICT_STRATEGY must be one of: ${validStrategies.join(", ")}`
      );
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join("\n")}`);
    }
  }

  resolvePath(pathValue) {
    if (!pathValue) return null;
    return path.isAbsolute(pathValue)
      ? pathValue
      : path.resolve(process.cwd(), pathValue);
  }

  parsePatterns(patternsString) {
    if (!patternsString) return [];
    return patternsString.split(",").map((pattern) => pattern.trim());
  }

  // Getters for configuration values
  getRepoA() {
    return { ...this.repoA };
  }

  getRepoB() {
    return { ...this.repoB };
  }

  getGithub() {
    return { ...this.github };
  }

  getOptions() {
    return { ...this.options };
  }

  getLogging() {
    return { ...this.logging };
  }

  // Check if a file should be processed based on include/exclude patterns
  shouldProcessFile(filePath) {
    const { includePatterns, excludePatterns } = this.options;

    // If include patterns are specified, only include files that match at least one pattern
    if (includePatterns.length > 0) {
      const isIncluded = includePatterns.some((pattern) =>
        filePath.includes(pattern)
      );
      if (!isIncluded) {
        return false;
      }
    }

    // If exclude patterns are specified, exclude files that match any pattern
    if (excludePatterns.length > 0) {
      const isExcluded = excludePatterns.some((pattern) =>
        filePath.includes(pattern)
      );
      if (isExcluded) {
        return false;
      }
    }

    return true;
  }
}

// Create and export a singleton instance
const config = new Config();
export default config;
