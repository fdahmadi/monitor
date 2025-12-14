# Repository Synchronization Tool - Optimized Version

This is a professional, well-structured tool for synchronizing changes between two Git repositories and creating pull requests. The code has been refactored to follow best practices with proper separation of concerns, error handling, and logging.

## Architecture

The application is built with a modular architecture consisting of several services:

### Core Services

1. **Configuration Service** (`config.js`)
   - Centralizes all environment variables and settings
   - Provides validation and default values
   - Handles path resolution and pattern parsing

2. **Logging Service** (`logger.js`)
   - Provides structured logging with different log levels
   - Supports both console and file output
   - Includes timestamps and proper formatting

3. **Error Handling** (`errors.js`)
   - Custom error types for different categories of errors
   - Proper error serialization with context information
   - Consistent error handling across the application

4. **Git Service** (`gitService.js`)
   - Encapsulates all Git operations
   - Provides proper error handling and logging
   - Abstracts Git functionality into reusable methods

5. **File Service** (`fileService.js`)
   - Handles file operations and conflict resolution
   - Parses Git diffs and applies file changes
   - Implements different conflict resolution strategies

6. **PR Service** (`prService.js`)
   - Manages pull request operations
   - Checks for conflicts with existing PRs
   - Generates PR content from commit messages

7. **Orchestrator** (`orchestrator.js`)
   - Coordinates all services
   - Implements the main application logic
   - Manages the synchronization workflow

## Usage

### Running the Application

```bash
# Run the original version
npm start

# Run the optimized version
npm run start:optimized
```

### Environment Variables

The application requires the following environment variables:

#### Repository Configuration
- `REPO_A_PATH`: Path to Repository A (source)
- `REPO_A_BRANCH`: Branch name for Repository A (default: "main")
- `REPO_A_URL`: URL of Repository A (for commit links)
- `REPO_B_PATH`: Path to Repository B (target)
- `REPO_B_BRANCH`: Branch name for Repository B (default: "main")

#### GitHub Configuration
- `GITHUB_TOKEN`: GitHub personal access token
- `GITHUB_OWNER`: GitHub repository owner
- `GITHUB_REPO`: GitHub repository name

#### Processing Options
- `DRY_RUN`: Set to "true" for dry run mode (default: "false")
- `INCLUDE_PATTERNS`: Comma-separated patterns of files to include
- `EXCLUDE_PATTERNS`: Comma-separated patterns of files to exclude
- `CONFLICT_STRATEGY`: Strategy for resolving conflicts (default: "overwrite")
  - "overwrite": Overwrite with new content
  - "keep": Keep existing content
  - "backup": Create backup and overwrite
  - "merge": Merge content from both repositories

#### Logging Configuration
- `LOG_LEVEL`: Logging level (default: "info")
  - "error": Only error messages
  - "warn": Warning messages and above
  - "info": Informational messages and above
  - "debug": All messages including debug
- `LOG_FILE`: Path to log file (optional)

## Features

### Synchronization Workflow

1. **Repository Analysis**: Analyzes Repository A for new commits
2. **Change Detection**: Identifies files that have changed
3. **Filtering**: Applies include/exclude patterns to filter files
4. **Conflict Resolution**: Handles conflicts based on configured strategy
5. **Branch Management**: Creates and manages branches for PRs
6. **Pull Request Creation**: Creates PRs with detailed descriptions

### Conflict Resolution

The tool supports multiple conflict resolution strategies:

- **Overwrite**: Replaces existing files with new content
- **Keep**: Preserves existing files and ignores new content
- **Backup**: Creates a backup of existing files before overwriting
- **Merge**: Combines content from both repositories

### Logging

The application provides comprehensive logging with:

- Structured log messages with timestamps
- Different log levels for filtering
- Optional file output for persistent logs
- Child loggers for different components

## Error Handling

The application uses custom error types for better error categorization:

- `ConfigurationError`: Configuration-related errors
- `GitError`: Git operation errors
- `FileOperationError`: File operation errors
- `PullRequestError`: Pull request errors
- `ConflictResolutionError`: Conflict resolution errors
- `ValidationError`: Validation errors
- `ApiError`: API-related errors

## Development

### Code Structure

The code follows these principles:

- **Separation of Concerns**: Each service has a specific responsibility
- **Dependency Injection**: Services are injected rather than hard-coded
- **Error Handling**: Proper error handling with custom error types
- **Logging**: Comprehensive logging throughout the application
- **Configuration**: Centralized configuration management

### Testing

To run tests (when implemented):

```bash
npm test
```

### Linting

To check for linting issues:

```bash
npm run lint
```

To fix linting issues:

```bash
npm run lint:fix
```

## Migration from Original Version

To migrate from the original version:

1. Update your environment variables as needed
2. Run the optimized version with `npm run start:optimized`
3. Monitor the logs to ensure proper operation
4. The optimized version should be functionally equivalent to the original

## Benefits of the Optimized Version

1. **Better Maintainability**: Modular structure makes the code easier to maintain
2. **Improved Error Handling**: Custom error types provide better error context
3. **Enhanced Logging**: Structured logging with different levels
4. **Configuration Management**: Centralized configuration with validation
5. **Testability**: Modular structure makes the code easier to test
6. **Reusability**: Services can be reused in other applications
7. **Extensibility**: Easy to add new features or modify existing ones
