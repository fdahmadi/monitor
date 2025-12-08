import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { createGit } from "./gitUtils.js";

const client = new Anthropic({
    apiKey: process.env.CLAUDE_API_KEY,
});

const runCmd = (cmd, cwd) => {
    return new Promise((resolve, reject) => {
        exec(cmd, { cwd }, (err, stdout, stderr) => {
            if (err) return reject(stderr || err.message);
            resolve(stdout.trim());
        });
    });
};

export const getDiffFromA = async () => {
    const repoPath = process.env.REPO_A_PATH;
    const branch = process.env.REPO_A_BRANCH;
    return runCmd(`git diff HEAD~1 HEAD`, repoPath);
};

export const extractChangedFiles = (diffText) => {
    const files = new Set();
    const regex = /diff --git a\/(.+?) b\/(.+?)\n/g;
    let match;
    while ((match = regex.exec(diffText)) !== null) {
        files.add(match[1]);
    }
    return Array.from(files);
};

export const readFilesFromB = async (files) => {
    const repoB = process.env.REPO_B_PATH;
    const result = {};

    for (const file of files) {
        const filePath = path.join(repoB, file);
        try {
            const content = await readFile(filePath, "utf8");
            result[file] = content;
        } catch {
            result[file] = null;
        }
    }
    return result;
};

export const generatePRviaClaude = async (diffText, filesFromB) => {
    const repoAUrl = process.env.REPO_A_URL;
    const repoBUrl = process.env.REPO_B_URL;
    const model = process.env.CLAUDE_MODEL || "claude-3-5-sonnet-20241022";

    const prompt = `
You are an AI expert in code merging.

Repository A URL: ${repoAUrl}
Repository B URL: ${repoBUrl}

Latest changes in Repository A:
-------------------------
${diffText}

Current state of relevant files in Repository B:
-------------------------
${Object.entries(filesFromB)
        .map(([name, content]) => `
FILE: ${name}
-------------
${content || "(file not found in B)"}
`)
        .join("\n\n")}

Task:
Generate the best possible Pull Request patch that intelligently merges
changes from A into B, preserving any custom modifications in B.

IMPORTANT: Return your response in the following EXACT format:
---
TITLE: [Your PR title here]
---
DESCRIPTION: [Your PR description here]
---
PATCH:
[Unified git patch format starting with diff --git]
---

The patch must be a valid unified diff that can be applied with 'git apply'.
`;

    const res = await client.messages.create({
        model,
        max_tokens: 8192,
        messages: [{ role: "user", content: prompt }],
    });

    return res.content[0].text;
};

// Parse Claude's response to extract title, description, and patch
export const parseClaudeResponse = (response) => {
    // Try to match the structured format first
    const titleMatch = response.match(/TITLE:\s*(.+?)(?=\n---|\nDESCRIPTION:|$)/s);
    const descMatch = response.match(/DESCRIPTION:\s*(.+?)(?=\n---|\nPATCH:|$)/s);
    const patchMatch = response.match(/PATCH:\s*([\s\S]+?)(?=\n---|$)/s);
    
    let title = titleMatch ? titleMatch[1].trim() : "Merge changes from Repository A";
    let description = descMatch ? descMatch[1].trim() : "Automated merge of changes from Repository A using AI.";
    let patch = patchMatch ? patchMatch[1].trim() : null;
    
    // Fallback: try to extract patch if format is different
    if (!patch) {
        const lines = response.split('\n');
        let patchStart = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('diff --git') || lines[i].startsWith('---') && i + 1 < lines.length && lines[i + 1].startsWith('+++')) {
                patchStart = i;
                break;
            }
        }
        if (patchStart >= 0) {
            patch = lines.slice(patchStart).join('\n').trim();
        }
    }
    
    // Remove markdown code blocks if present
    if (patch) {
        patch = patch.replace(/^```[\w]*\n/gm, '').replace(/\n```$/gm, '').trim();
    }
    
    return { title, description, patch };
};

// Create PR on GitHub by applying patch to repo B
export const createPRonGitHub = async (title, description, patch) => {
    const repoBPath = process.env.REPO_B_PATH;
    const repoBBranch = process.env.REPO_B_BRANCH || "main";
    const githubToken = process.env.GITHUB_TOKEN;
    const githubOwner = process.env.GITHUB_OWNER;
    const githubRepo = process.env.GITHUB_REPO;
    
    if (!githubToken || !githubOwner || !githubRepo) {
        throw new Error("Missing GitHub configuration (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO)");
    }
    
    const octokit = new Octokit({ auth: githubToken });
    const git = createGit(repoBPath);
    
    // Generate unique branch name
    const timestamp = Date.now();
    const branchName = `ai-merge-${timestamp}`;
    
    try {
        // Ensure we're on the base branch and up to date
        try {
            await git.checkout(repoBBranch);
        } catch (checkoutError) {
            // Branch might not exist locally, try to fetch and checkout
            await git.fetch();
            await git.checkout(repoBBranch);
        }
        
        await git.pull();
        
        // Create new branch
        await git.checkoutLocalBranch(branchName);
        
        // Write patch to temporary file (use repo B path for better compatibility)
        const patchFile = path.join(repoBPath, `temp-patch-${timestamp}.patch`);
        await writeFile(patchFile, patch, "utf8");
        
        // Apply patch
        try {
            // Use absolute path and proper escaping for cross-platform compatibility
            const normalizedPath = path.resolve(patchFile).replace(/\\/g, '/');
            await runCmd(`git apply "${normalizedPath}"`, repoBPath);
        } catch (applyError) {
            // Clean up patch file
            try {
                await unlink(patchFile);
            } catch {}
            throw new Error(`Failed to apply patch: ${applyError.message}`);
        }
        
        // Clean up patch file
        try {
            await unlink(patchFile);
        } catch (cleanupError) {
            console.warn("Could not clean up patch file:", cleanupError.message);
        }
        
        // Check if there are any changes
        const status = await git.status();
        if (status.files.length === 0) {
            // No changes, delete branch and return
            await git.checkout(repoBBranch);
            await git.deleteLocalBranch(branchName);
            console.log("No changes after applying patch, skipping PR creation");
            return null;
        }
        
        // Stage all changes
        await git.add(".");
        
        // Commit
        await git.commit(`AI Merge: ${title}`);
        
        // Push branch
        await git.push("origin", branchName);
        
        // Create Pull Request
        const pr = await octokit.pulls.create({
            owner: githubOwner,
            repo: githubRepo,
            title: title,
            body: description,
            head: branchName,
            base: repoBBranch,
        });
        
        console.log(`✅ PR created: ${pr.data.html_url}`);
        return pr.data.html_url;
        
    } catch (error) {
        // Try to clean up branch if something went wrong
        try {
            await git.checkout(repoBBranch);
            const branches = await git.branchLocal();
            if (branches.all.includes(branchName)) {
                await git.deleteLocalBranch(branchName);
            }
        } catch {}
        
        throw error;
    }
};

