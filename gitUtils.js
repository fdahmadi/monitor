import simpleGit from "simple-git";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const createGit = (cwd) => simpleGit({ baseDir: cwd });

const STATE_FILE = path.join(process.cwd(), ".last-processed-commit.json");

// Load last processed commit hash
export const getLastProcessedCommit = async () => {
    try {
        if (existsSync(STATE_FILE)) {
            const data = await readFile(STATE_FILE, "utf8");
            const state = JSON.parse(data);
            return state.lastCommit || null;
        }
    } catch (err) {
        console.warn("Could not read state file:", err.message);
    }
    return null;
};

// Save last processed commit hash
export const saveLastProcessedCommit = async (commitHash) => {
    try {
        await writeFile(STATE_FILE, JSON.stringify({ lastCommit: commitHash }, null, 2));
    } catch (err) {
        console.error("Could not save state file:", err.message);
    }
};

// Get the latest commit hash from remote branch
export const getLatestCommitHash = async (git, branch) => {
    await git.fetch();
    const log = await git.log([`origin/${branch}`, "-1"]);
    return log.latest?.hash || null;
};

// Get diff between last processed commit and latest commit
export const getLatestDiff = async (git, branch) => {
    await git.fetch();
    const lastProcessed = await getLastProcessedCommit();
    const latestCommit = await getLatestCommitHash(git, branch);
    
    if (!latestCommit) {
        return { diff: "", latestCommit: null };
    }
    
    // If no previous commit tracked, get diff from HEAD
    if (!lastProcessed) {
        const diff = await git.diff([`HEAD`, `origin/${branch}`]);
        return { diff, latestCommit };
    }
    
    // Get diff from last processed commit to latest
    try {
        const diff = await git.diff([lastProcessed, latestCommit]);
        return { diff, latestCommit };
    } catch (err) {
        // If commit not found, fallback to HEAD comparison
        console.warn("Last processed commit not found, using HEAD comparison");
        const diff = await git.diff([`HEAD`, `origin/${branch}`]);
        return { diff, latestCommit };
    }
};

