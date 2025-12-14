# OpenCTI Monitor

This tool monitors changes in one Git repository (Repository A) and creates pull requests for those changes in another repository (Repository B). It's designed to help maintain a customized fork of a project by automatically creating PRs for changes from the original repository.

## Features

- Monitor commits from a source repository
- Create pull requests for file changes in a target repository
- Filter files based on include/exclude patterns
- Dry-run mode to preview changes before creating PRs
- Automatic conflict detection and resolution strategies
- Detailed logging of all operations

## Setup

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the example environment file and configure it:
   ```bash
   cp env.example .env
   ```
4. Edit the `.env` file with your repository paths and settings

## Configuration

### Required Settings

- `REPO_A_PATH`: Path to the source repository (original)
- `REPO_A_BRANCH`: Branch to monitor in the source repository (default: main)
- `REPO_B_PATH`: Path to the target repository (your fork/customized)
- `REPO_B_BRANCH`: Branch to create pull requests against in the target repository (default: main)

### Optional Settings

#### File Sync Options

- `DRY_RUN`: Set to `true` to preview changes without creating PRs (default: false)
- `INCLUDE_PATTERNS`: Comma-separated list of patterns to include only matching files
  - Example: `src/,docs/` - Only create PRs for files in src/ and docs/ directories
  - Leave empty to include all files
- `EXCLUDE_PATTERNS`: Comma-separated list of patterns to exclude from PRs
  - Example: `node_modules/,*.log,config/` - Exclude node_modules directory, log files, and config directory
  - Leave empty to not exclude any files

#### Conflict Resolution

When a file exists in both repositories with different content, you can choose how to resolve the conflict:

- `CONFLICT_STRATEGY`: Strategy for resolving conflicts (default: overwrite)
  - `overwrite`: Overwrite with content from Repository A
  - `keep`: Keep existing content in Repository B
  - `backup`: Create a backup of existing content and then overwrite
  - `merge`: Merge content from both repositories (simple merge)

#### GitHub Credentials (required for PR creation)

- `GITHUB_TOKEN`: GitHub personal access token
- `GITHUB_USER`: GitHub username
- `GITHUB_OWNER`: Repository owner
- `GITHUB_REPO`: Repository name

#### Claude AI (for intelligent PR creation)

- `CLAUDE_API_KEY`: Anthropic Claude API key
- `CLAUDE_MODEL`: Claude model to use

## Usage

### Basic Usage

Run the script to create pull requests for changes from Repository A to Repository B:

```bash
node test.js
```

### Example Script

For more specific use cases, you can use the `example-sync.js` script:

#### Create a PR for a Specific Commit

```bash
node example-sync.js commit abc1234
```

#### Create PRs for All Commits from a Specific Date

```bash
node example-sync.js date 2023-12-14
```

#### Create a Single PR for All Commits from a Specific Date

```bash
node example-sync.js all 2023-12-14
```

This creates a new branch named `pr-2023-12-14`, applies all changes from that date to the branch, and creates a single pull request for all those changes.

To delete the branch after creating the PR, use the `-D` flag:

```bash
node example-sync.js all 2023-12-14 -D
```

This will create the PR and then delete both the local and remote branches after the PR is successfully created.

#### Preview Changes Without Creating PRs

```bash
node example-sync.js preview abc1234
```

### Dry Run Mode

To preview what PRs would be created without actually creating them:

1. Set `DRY_RUN=true` in your `.env` file, or
2. Run with environment variable:
   ```bash
   DRY_RUN=true node test.js
   ```

### File Filtering

To only create PRs for specific files or directories:

1. Set `INCLUDE_PATTERNS` in your `.env` file:
   ```
   INCLUDE_PATTERNS=src/,docs/
   ```

To exclude certain files or directories from PRs:

1. Set `EXCLUDE_PATTERNS` in your `.env` file:
   ```
   EXCLUDE_PATTERNS=node_modules/,*.log,config/
   ```

### Conflict Resolution

To handle conflicts between repositories when creating PRs:

1. Set `CONFLICT_STRATEGY` in your `.env` file:
   ```
   CONFLICT_STRATEGY=backup
   ```

## How It Works

1. The script checks for commits in Repository A from the next day after the last processed commit
2. For each commit, it:
   - Extracts the file changes
   - Filters files based on include/exclude patterns
   - Creates a pull request with the changes
   - Includes a reference to the original commit in the PR description
   - Handles conflicts based on the selected strategy

### Single PR for All Commits from a Date

When using the `all` command, the workflow is slightly different:

1. Creates a new branch named `pr-YYYY-MM-DD` (e.g., `pr-2023-12-14`)
2. Applies all changes from that date to the new branch
3. Creates a single pull request for all those changes
4. The PR description includes a list of all commits included

## Example Output

```
=== Checking Repo A for updates ===
Repo A Path: /path/to/repo-a
Repo A Branch: main
Repo B Path: /path/to/repo-b
Repo B Branch: main
Dry Run: No
Found 3 commits for 2023-12-14

=== Creating PR for all commits from date: 2023-12-14 ===
Found 3 commits from 2023-12-14
Created and checked out branch: pr-2023-12-14

Processing commit: abc1234
Commit Date: 2023-12-14T10:30:00Z
Commit Message: Fix bug in authentication
Found 2 file(s) in commit, 2 file(s) to apply
Processing file: src/auth/login.js
  Updated file: src/auth/login.js
Processing file: tests/auth.test.js
  Updated file: tests/auth.test.js

Processing commit: def5678
Commit Date: 2023-12-14T14:20:00Z
Commit Message: Update documentation
Found 1 file(s) in commit, 1 file(s) to apply
Processing file: docs/api.md
  Updated file: docs/api.md

Processing commit: ghi9012
Commit Date: 2023-12-14T16:45:00Z
Commit Message: Add new feature
Found 3 file(s) in commit, 3 file(s) to apply
Processing file: src/feature.js
  Created file: src/feature.js
Processing file: tests/feature.test.js
  Created file: tests/feature.test.js
Processing file: docs/feature.md
  Created file: docs/feature.md

Committed all changes to branch pr-2023-12-14
Pushed branch pr-2023-12-14 to remote
Running PR Generator (No Claude)...
Extracting changed files...
Found 6 changed file(s):
  - src/auth/login.js (modified)
  - tests/auth.test.js (modified)
  - docs/api.md (modified)
  - src/feature.js (new)
  - tests/feature.test.js (new)
  - docs/feature.md (new)
📋 Found 0 open pull request(s)
✅ No file conflicts found with open pull requests.
📝 Creating PR on GitHub...
Title: Fix bug in authentication
✅ Successfully created PR: https://github.com/user/repo/pull/123
✅ Successfully created PR for all commits from 2023-12-14
✅ PR created: https://github.com/user/repo/pull/123
```

## Conflict Resolution Examples

### Overwrite Strategy (Default)

```
Processing file: src/config.js
  Conflict detected in src/config.js
  Resolved conflict: Overwrote with content from Repository A
```

### Backup Strategy

```
Processing file: src/config.js
  Conflict detected in src/config.js
  Resolved conflict: Created backup at /path/to/repo-b/src/config.js.backup.1702584000000 and overwrote with new content
```

### Keep Strategy

```
Processing file: src/config.js
  Conflict detected in src/config.js
  Resolved conflict: Kept existing content in Repository B
```

### Merge Strategy

```
Processing file: src/config.js
  Conflict detected in src/config.js
  Resolved conflict: Merged content from both repositories
```

## Troubleshooting

### Common Issues

1. **"Branch might not exist locally" error**
   - Make sure both repositories are properly cloned
   - Check that the branch names in your `.env` file are correct

2. **"Could not pull latest changes" error**
   - Check your internet connection
   - Verify you have the proper permissions for both repositories

3. **File permission errors**
   - Make sure the script has read/write permissions for both repositories
   - Check that the files aren't locked by another process

4. **GitHub authentication errors**
   - Verify your `GITHUB_TOKEN` has the necessary permissions
   - Check that `GITHUB_OWNER` and `GITHUB_REPO` are correct

5. **Conflict resolution issues**
   - Try using the `backup` strategy to preserve existing changes
   - Manually resolve complex conflicts in the created PRs

### Debug Mode

For more detailed logging, you can modify the script to add additional console.log statements or use a Node.js debugger.

## Advanced Usage

### Custom Date Range

To process commits from a specific date range, modify the `main` function in `test.js`:

```javascript
// Instead of using nextDay, specify a custom date
const customDate = moment("2023-12-01");
let customDateCommits = await getCommitsFromDate(
  git,
  customDate.format("YYYY-MM-DD"),
  repoABranch
);
```

### Processing Specific Commits

To process specific commits instead of all commits from a date:

```javascript
// Replace the for loop with specific commit hashes
const specificCommits = ["abc1234", "def5678", "ghi9012"];
for (const commitHash of specificCommits) {
  // Get commit details
  const commitDetails = await getCommitDetails(git, commitHash);
  
  // Create PR
  await createPullRequestForChanges(commitHash, commitDetails.message);
}
```

