/**
 * Custom error types for better error handling and categorization
 */

/**
 * Base error class for all custom errors
 */
class BaseError extends Error {
  constructor(message, code = null, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      details: this.details,
      stack: this.stack,
    };
  }
}

/**
 * Configuration related errors
 */
class ConfigurationError extends BaseError {
  constructor(message, code = null, details = {}) {
    super(message, code, details);
  }
}

/**
 * Git operation related errors
 */
class GitError extends BaseError {
  constructor(message, code = null, details = {}) {
    super(message, code, details);
  }
}

/**
 * File operation related errors
 */
class FileOperationError extends BaseError {
  constructor(message, code = null, details = {}) {
    super(message, code, details);
  }
}

/**
 * Pull request related errors
 */
class PullRequestError extends BaseError {
  constructor(message, code = null, details = {}) {
    super(message, code, details);
  }
}

/**
 * Conflict resolution related errors
 */
class ConflictResolutionError extends BaseError {
  constructor(message, code = null, details = {}) {
    super(message, code, details);
  }
}

/**
 * Validation related errors
 */
class ValidationError extends BaseError {
  constructor(message, code = null, details = {}) {
    super(message, code, details);
  }
}

/**
 * API related errors
 */
class ApiError extends BaseError {
  constructor(message, code = null, details = {}) {
    super(message, code, details);
  }
}

export {
  BaseError,
  ConfigurationError,
  GitError,
  FileOperationError,
  PullRequestError,
  ConflictResolutionError,
  ValidationError,
  ApiError,
};
