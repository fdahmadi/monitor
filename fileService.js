import fs from "node:fs/promises";
import path from "node:path";
import logger from "./logger.js";
import config from "./config.js";
import { FileOperationError, ConflictResolutionError } from "./errors.js";

/**
 * File service class for handling file operations and conflict resolution
 * Encapsulates file functionality with proper error handling and logging
 */
class FileService {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.logger = logger.child(`FileService[${path.basename(repoPath)}]`);
  }

  /**
   * Parse git diff to extract file changes
   * @param {string} diff - Git diff output
   * @returns {Array} Array of file change objects
   */
  parseDiffForFiles(diff) {
    try {
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
    } catch (err) {
      this.logger.error("Failed to parse diff for files", {
        error: err.message,
      });
      throw new FileOperationError(
        "Failed to parse diff for files",
        "PARSE_DIFF_ERROR",
        { originalError: err.message }
      );
    }
  }

  /**
   * Check if a file should be processed based on include/exclude patterns
   * @param {string} filePath - File path
   * @returns {boolean} Whether the file should be processed
   */
  shouldProcessFile(filePath) {
    return config.shouldProcessFile(filePath);
  }

  /**
   * Filter file changes based on include/exclude patterns
   * @param {Array} fileChanges - Array of file change objects
   * @returns {Array} Filtered array of file change objects
   */
  filterFileChanges(fileChanges) {
    return fileChanges.filter((fileChange) =>
      this.shouldProcessFile(fileChange.path)
    );
  }

  /**
   * Check for conflicts before applying changes
   * @param {string} filePath - File path
   * @param {string} newContent - New file content
   * @returns {Promise<Object>} Conflict information
   */
  async checkForConflicts(filePath, newContent) {
    try {
      const repoFilePath = path.join(this.repoPath, filePath);

      // Check if file exists in repository
      try {
        const existingContent = await fs.readFile(repoFilePath, "utf8");

        // Simple conflict detection: check if files have different content
        // This is a basic implementation - you might want more sophisticated conflict detection
        if (existingContent !== newContent) {
          return {
            hasConflict: true,
            existingContent,
            newContent,
          };
        }
      } catch (err) {
        // File doesn't exist in repository, no conflict
        return { hasConflict: false };
      }

      return { hasConflict: false };
    } catch (err) {
      this.logger.error(`Error checking for conflicts in ${filePath}`, {
        error: err.message,
      });
      throw new FileOperationError(
        `Error checking for conflicts in ${filePath}`,
        "CHECK_CONFLICTS_ERROR",
        { filePath, originalError: err.message }
      );
    }
  }

  /**
   * Resolve conflicts based on strategy
   * @param {string} filePath - File path
   * @param {Object} conflict - Conflict information
   * @param {string} conflictStrategy - Conflict resolution strategy
   * @returns {Promise<boolean>} Success status
   */
  async resolveConflict(filePath, conflict, conflictStrategy) {
    try {
      const { existingContent, newContent } = conflict;
      const repoFilePath = path.join(this.repoPath, filePath);

      this.logger.info(
        `Resolving conflict in ${filePath} using strategy: ${conflictStrategy}`
      );

      switch (conflictStrategy) {
        case "overwrite":
          // Overwrite with new content
          await fs.writeFile(repoFilePath, newContent);
          this.logger.info(`Resolved conflict: Overwrote with new content`);
          return true;

        case "keep":
          // Keep existing content
          this.logger.info(`Resolved conflict: Kept existing content`);
          return true;

        case "backup":
          // Create a backup of existing content and then overwrite
          const backupPath = `${repoFilePath}.backup.${Date.now()}`;
          await fs.writeFile(backupPath, existingContent);
          await fs.writeFile(repoFilePath, newContent);
          this.logger.info(
            `Resolved conflict: Created backup at ${backupPath} and overwrote with new content`
          );
          return true;

        case "merge":
          // Simple merge strategy - in a real implementation, you might use a proper merge algorithm
          // For now, we'll just append the new content after a separator
          const mergedContent = `${existingContent}\n\n<!-- ===== MERGED FROM REPOSITORY A ===== -->\n${newContent}`;
          await fs.writeFile(repoFilePath, mergedContent);
          this.logger.info(
            `Resolved conflict: Merged content from both repositories`
          );
          return true;

        default:
          throw new ConflictResolutionError(
            `Unknown conflict strategy: ${conflictStrategy}`,
            "UNKNOWN_CONFLICT_STRATEGY",
            { conflictStrategy }
          );
      }
    } catch (err) {
      this.logger.error(`Failed to resolve conflict for ${filePath}`, {
        error: err.message,
      });
      throw new ConflictResolutionError(
        `Failed to resolve conflict for ${filePath}`,
        "RESOLVE_CONFLICT_ERROR",
        { filePath, conflictStrategy, originalError: err.message }
      );
    }
  }

  /**
   * Delete a file
   * @param {string} filePath - File path
   * @returns {Promise<boolean>} Success status
   */
  async deleteFile(filePath) {
    try {
      const repoFilePath = path.join(this.repoPath, filePath);
      await fs.unlink(repoFilePath);
      this.logger.info(`Deleted file: ${filePath}`);
      return true;
    } catch (err) {
      // File might not exist, which is fine for deletion
      if (err.code === "ENOENT") {
        this.logger.info(`File ${filePath} not found, skipping deletion`);
        return true;
      }

      this.logger.error(`Failed to delete file ${filePath}`, {
        error: err.message,
      });
      throw new FileOperationError(
        `Failed to delete file ${filePath}`,
        "DELETE_FILE_ERROR",
        { filePath, originalError: err.message }
      );
    }
  }

  /**
   * Write content to a file
   * @param {string} filePath - File path
   * @param {string} content - File content
   * @returns {Promise<boolean>} Success status
   */
  async writeFile(filePath, content) {
    try {
      const repoFilePath = path.join(this.repoPath, filePath);

      // Ensure directory exists
      const dirPath = path.dirname(repoFilePath);
      await fs.mkdir(dirPath, { recursive: true });

      // Write the file content
      await fs.writeFile(repoFilePath, content);
      this.logger.info(`Wrote file: ${filePath}`);
      return true;
    } catch (err) {
      this.logger.error(`Failed to write file ${filePath}`, {
        error: err.message,
      });
      throw new FileOperationError(
        `Failed to write file ${filePath}`,
        "WRITE_FILE_ERROR",
        { filePath, originalError: err.message }
      );
    }
  }

  /**
   * Read content from a file
   * @param {string} filePath - File path
   * @returns {Promise<string>} File content
   */
  async readFile(filePath) {
    try {
      const repoFilePath = path.join(this.repoPath, filePath);
      return await fs.readFile(repoFilePath, "utf8");
    } catch (err) {
      this.logger.error(`Failed to read file ${filePath}`, {
        error: err.message,
      });
      throw new FileOperationError(
        `Failed to read file ${filePath}`,
        "READ_FILE_ERROR",
        { filePath, originalError: err.message }
      );
    }
  }

  /**
   * Apply a single file change to the repository
   * @param {Object} gitService - GitService instance
   * @param {Object} fileChange - File change object
   * @param {string} commitHash - Commit hash
   * @param {boolean} dryRun - Whether to perform a dry run
   * @returns {Promise<boolean>} Success status
   */
  async applyFileChange(gitService, fileChange, commitHash, dryRun = false) {
    try {
      const filePath = fileChange.path;

      this.logger.info(`Processing file: ${filePath}`);

      // If file is deleted in Repository A, delete it in Repository B
      if (fileChange.isDeleted) {
        if (dryRun) {
          this.logger.info(`[DRY RUN] Would delete file: ${filePath}`);
          return true;
        }

        return await this.deleteFile(filePath);
      }

      // For new or modified files, get the content from Repository A
      if (dryRun) {
        this.logger.info(
          `[DRY RUN] Would ${
            fileChange.isNew ? "create" : "update"
          } file: ${filePath}`
        );
        return true;
      }

      // Get the file content from Repository A at the specific commit
      const fileContent = await gitService.show(commitHash, filePath);

      // Check for conflicts if file exists in Repository B
      const conflictStrategy = config.getOptions().conflictStrategy;
      if (conflictStrategy !== "overwrite") {
        const conflict = await this.checkForConflicts(filePath, fileContent);

        if (conflict.hasConflict) {
          const resolved = await this.resolveConflict(
            filePath,
            conflict,
            conflictStrategy
          );
          if (!resolved) {
            this.logger.error(`Failed to resolve conflict for ${filePath}`);
            return false;
          }
          return true;
        }
      }

      // Write the file content to Repository B
      await this.writeFile(filePath, fileContent);
      this.logger.info(
        `${fileChange.isNew ? "Created" : "Updated"} file: ${filePath}`
      );
      return true;
    } catch (err) {
      this.logger.error(`Error applying file change for ${fileChange.path}`, {
        error: err.message,
      });
      throw new FileOperationError(
        `Error applying file change for ${fileChange.path}`,
        "APPLY_FILE_CHANGE_ERROR",
        { fileChange, commitHash, originalError: err.message }
      );
    }
  }

  /**
   * Apply multiple file changes to the repository
   * @param {Object} gitService - GitService instance
   * @param {Array} fileChanges - Array of file change objects
   * @param {string} commitHash - Commit hash
   * @param {boolean} dryRun - Whether to perform a dry run
   * @returns {Promise<number>} Number of files processed
   */
  async applyFileChanges(gitService, fileChanges, commitHash, dryRun = false) {
    try {
      let filesProcessed = 0;

      for (const fileChange of fileChanges) {
        const success = await this.applyFileChange(
          gitService,
          fileChange,
          commitHash,
          dryRun
        );
        if (success) {
          filesProcessed++;
        }
      }

      return filesProcessed;
    } catch (err) {
      this.logger.error("Failed to apply file changes", {
        error: err.message,
      });
      throw new FileOperationError(
        "Failed to apply file changes",
        "APPLY_FILE_CHANGES_ERROR",
        { fileChanges, commitHash, originalError: err.message }
      );
    }
  }
}

/**
 * Factory function to create FileService instances
 * @param {string} repoPath - Path to the repository
 * @returns {FileService} FileService instance
 */
export function createFileService(repoPath) {
  return new FileService(repoPath);
}

export default FileService;
