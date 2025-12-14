import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Store original environment variables
const originalEnv = { ...process.env };

// Store original console methods
const originalConsole = { ...console };

/**
 * Reset all mocks to their original state
 */
export function resetMocks() {
  // Reset environment variables
  process.env = { ...originalEnv };
  
  // Reset console methods
  Object.keys(originalConsole).forEach(key => {
    console[key] = originalConsole[key];
  });
}

/**
 * Mock environment variables
 * @param {Object} env - Environment variables to mock
 */
export function mockEnv(env) {
  process.env = { ...process.env, ...env };
}

/**
 * Mock console methods
 * @param {Object} methods - Console methods to mock
 */
export function mockConsole(methods) {
  Object.keys(methods).forEach(key => {
    console[key] = methods[key];
  });
}

/**
 * Create a temporary directory for testing
 * @param {string} prefix - Directory name prefix
 * @returns {string} Path to temporary directory
 */
export function createTempDir(prefix = "test-") {
  const tempDir = fs.mkdtempSync(path.join(__dirname, "..", prefix));
  return tempDir;
}

/**
 * Remove a directory recursively
 * @param {string} dirPath - Path to directory to remove
 */
export function removeDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

/**
 * Create a file with content
 * @param {string} filePath - Path to file
 * @param {string} content - File content
 */
export function createFile(filePath, content = "") {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  fs.writeFileSync(filePath, content);
}

/**
 * Read file content
 * @param {string} filePath - Path to file
 * @returns {string} File content
 */
export function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

/**
 * Create a mock Git repository
 * @param {string} repoPath - Path to repository
 * @param {Object} options - Repository options
 */
export async function createMockRepo(repoPath, options = {}) {
  const { 
    initialCommit = true, 
    files = {},
    remote = false,
    remoteName = "origin",
    remoteUrl = "https://github.com/example/repo.git"
  } = options;

  // Create directory if it doesn't exist
  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(repoPath, { recursive: true });
  }

  // Initialize repository
  const { simpleGit } = await import("simple-git");
  const git = simpleGit({ baseDir: repoPath });

  await git.init();

  // Configure user
  await git.addConfig("user.name", "Test User");
  await git.addConfig("user.email", "test@example.com");

  // Add files
  Object.entries(files).forEach(([filePath, content]) => {
    const fullPath = path.join(repoPath, filePath);
    createFile(fullPath, content);
  });

  if (Object.keys(files).length > 0) {
    await git.add(".");
    await git.commit("Initial commit");
  }

  // Add remote if specified
  if (remote) {
    await git.addRemote(remoteName, remoteUrl);
  }

  return git;
}

/**
 * Create a mock Git repository with a remote
 * @param {string} repoPath - Path to repository
 * @param {string} remotePath - Path to remote repository
 * @param {Object} options - Repository options
 */
export async function createMockRepoWithRemote(repoPath, remotePath, options = {}) {
  const { 
    initialCommit = true, 
    files = {},
    remoteName = "origin",
    branch = "main"
  } = options;

  // Create remote repository
  const remoteGit = await createMockRepo(remotePath, {
    initialCommit,
    files,
    remote: false
  });

  // Create local repository
  const localGit = await createMockRepo(repoPath, {
    initialCommit: false,
    remote: true,
    remoteUrl: remotePath,
    remoteName
  });

  // Fetch from remote
  await localGit.fetch(remoteName, branch);

  // Checkout branch
  await localGit.checkout(branch);

  return { localGit, remoteGit };
}

/**
 * Create a mock GitHub API client
 * @param {Object} responses - Mock responses for API calls
 */
export function createMockGitHubClient(responses = {}) {
  return {
    pulls: {
      list: async () => responses.pulls?.list || { data: [] },
      create: async () => responses.pulls?.create || { data: { html_url: "https://github.com/example/repo/pull/1" } },
      listFiles: async () => responses.pulls?.listFiles || { data: [] },
    },
  };
}

/**
 * Wait for a specified amount of time
 * @param {number} ms - Time to wait in milliseconds
 */
export function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
