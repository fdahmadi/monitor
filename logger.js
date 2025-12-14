import fs from "node:fs";
import path from "node:path";
import config from "./config.js";

/**
 * Logging system with different log levels
 * Supports console and file output
 */
class Logger {
  constructor() {
    this.logLevels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
    };

    this.currentLevel =
      this.logLevels[config.getLogging().level] || this.logLevels.info;
    this.logFile = config.getLogging().file;
  }

  /**
   * Format log message with timestamp and level
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {any} data - Additional data to log
   * @returns {string} Formatted log message
   */
  formatMessage(level, message, data = null) {
    const timestamp = new Date().toISOString();
    let formattedMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

    if (data) {
      if (typeof data === "object") {
        formattedMessage += `\n${JSON.stringify(data, null, 2)}`;
      } else {
        formattedMessage += ` ${data}`;
      }
    }

    return formattedMessage;
  }

  /**
   * Write log message to file if configured
   * @param {string} formattedMessage - Formatted log message
   */
  async writeToFile(formattedMessage) {
    if (!this.logFile) return;

    try {
      // Ensure log directory exists
      const logDir = path.dirname(this.logFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      // Append to log file
      await fs.promises.appendFile(this.logFile, formattedMessage + "\n");
    } catch (err) {
      console.error("Failed to write to log file:", err.message);
    }
  }

  /**
   * Generic log method
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {any} data - Additional data to log
   */
  async log(level, message, data = null) {
    const levelValue = this.logLevels[level];

    // Skip if current level is lower than the message level
    if (levelValue > this.currentLevel) return;

    const formattedMessage = this.formatMessage(level, message, data);

    // Output to console with appropriate method
    switch (level) {
      case "error":
        console.error(formattedMessage);
        break;
      case "warn":
        console.warn(formattedMessage);
        break;
      case "debug":
        console.debug(formattedMessage);
        break;
      default:
        console.log(formattedMessage);
    }

    // Write to file if configured
    await this.writeToFile(formattedMessage);
  }

  /**
   * Log error message
   * @param {string} message - Log message
   * @param {any} data - Additional data to log
   */
  async error(message, data = null) {
    await this.log("error", message, data);
  }

  /**
   * Log warning message
   * @param {string} message - Log message
   * @param {any} data - Additional data to log
   */
  async warn(message, data = null) {
    await this.log("warn", message, data);
  }

  /**
   * Log info message
   * @param {string} message - Log message
   * @param {any} data - Additional data to log
   */
  async info(message, data = null) {
    await this.log("info", message, data);
  }

  /**
   * Log debug message
   * @param {string} message - Log message
   * @param {any} data - Additional data to log
   */
  async debug(message, data = null) {
    await this.log("debug", message, data);
  }

  /**
   * Create a child logger with a prefix
   * @param {string} prefix - Prefix to add to all messages
   * @returns {Object} Child logger with prefix
   */
  child(prefix) {
    return {
      error: (message, data) => this.error(`${prefix}: ${message}`, data),
      warn: (message, data) => this.warn(`${prefix}: ${message}`, data),
      info: (message, data) => this.info(`${prefix}: ${message}`, data),
      debug: (message, data) => this.debug(`${prefix}: ${message}`, data),
    };
  }
}

// Create and export a singleton instance
const logger = new Logger();
export default logger;
