import {
    extractChangedFiles,
    createPRonGitHub,
} from "./createSmartPR.js";
import { Octokit } from "@octokit/rest";

/**
 * Get list of open pull requests and their changed files
 * @returns {Promise<Array>} Array of PR objects with number, title, and files array
 */
export const getOpenPullRequests = async () => {
    const githubToken = process.env.GITHUB_TOKEN;
    const githubOwner = process.env.GITHUB_OWNER;
    const githubRepo = process.env.GITHUB_REPO;
    
    if (!githubToken || !githubOwner || !githubRepo) {
        throw new Error("Missing GitHub configuration (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO)");
    }
    
    const octokit = new Octokit({ auth: githubToken });
    
    try {
        // Get all open pull requests
        const { data: prs } = await octokit.pulls.list({
            owner: githubOwner,
            repo: githubRepo,
            state: 'open',
            per_page: 100, // Get up to 100 open PRs
        });
        
        console.log(`📋 Found ${prs.length} open pull request(s)`);
        
        // For each PR, get the list of changed files
        const prsWithFiles = await Promise.all(
            prs.map(async (pr) => {
                try {
                    const { data: files } = await octokit.pulls.listFiles({
                        owner: githubOwner,
                        repo: githubRepo,
                        pull_number: pr.number,
                        per_page: 100, // Get up to 100 files per PR
                    });
                    
                    const filePaths = files.map(file => file.filename);
                    
                    return {
                        number: pr.number,
                        title: pr.title,
                        url: pr.html_url,
                        files: filePaths,
                    };
                } catch (err) {
                    console.warn(`⚠️ Could not get files for PR #${pr.number}:`, err.message);
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
        console.error("❌ Error getting open pull requests:", err.message);
        throw err;
    }
};

/**
 * Check if files in current commit overlap with files in open PRs
 * @param {Set<string>} currentFiles - Set of file paths in current commit
 * @param {Array} openPRs - Array of PR objects with files array
 * @returns {Object} { hasConflict: boolean, conflictingPRs: Array }
 */
export const checkFileConflicts = (currentFiles, openPRs) => {
    const conflictingPRs = [];
    
    for (const pr of openPRs) {
        const prFiles = new Set(pr.files);
        const intersection = [...currentFiles].filter(file => prFiles.has(file));
        
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
};

/**
 * Merge changes from Repository A into Repository B and create a Pull Request
 * WITHOUT using Claude AI - just uses the diff directly
 * 
 * @param {string} diffText - Git diff between local and remote Repository A
 * @param {string} latestCommit - Latest commit hash from Repository A
 * @param {Array} commitMessages - Array of commit objects with hash, message, and date
 * @returns {Promise<Object>} Result object with success status and PR URL
 */
export const mergeAndCreatePRNoClaude = async (diffText, latestCommit, commitMessages = []) => {
    console.log("Running PR Generator (No Claude)...");

    try {
        if (!diffText || diffText.trim() === "") {
            console.log("No new changes found in A.");
            return { success: false, reason: "No changes" };
        }

        console.log("Extracting changed files...");
        const changedFilesMap = extractChangedFiles(diffText);
        console.log(`Found ${changedFilesMap.size} changed file(s):`);
        
        // Log file operations
        for (const [filePath, fileInfo] of changedFilesMap.entries()) {
            console.log(`  - ${filePath} (${fileInfo.operation})`);
        }

        // Get list of files in current commit
        const currentFiles = new Set(changedFilesMap.keys());
        
        // Check for conflicts with open PRs
        console.log("\n🔍 Checking for file conflicts with open pull requests...");
        const openPRs = await getOpenPullRequests();
        
        if (openPRs.length > 0) {
            const conflictCheck = checkFileConflicts(currentFiles, openPRs);
            
            if (conflictCheck.hasConflict) {
                console.error("\n❌ File conflicts detected with open pull requests:");
                for (const conflict of conflictCheck.conflictingPRs) {
                    console.error(`\n  PR #${conflict.prNumber}: ${conflict.prTitle}`);
                    console.error(`  URL: ${conflict.prUrl}`);
                    console.error(`  Conflicting files (${conflict.conflictingFiles.length}):`);
                    conflict.conflictingFiles.forEach(file => {
                        console.error(`    - ${file}`);
                    });
                }
                console.error("\n🛑 Stopping processing to avoid conflicts.");
                return { 
                    success: false, 
                    reason: "File conflicts with open PRs",
                    conflictingPRs: conflictCheck.conflictingPRs,
                };
            } else {
                console.log("✅ No file conflicts found with open pull requests.");
            }
        } else {
            console.log("✅ No open pull requests found.");
        }

        // Helper function to create commit URL
        const createCommitUrl = (commitHash) => {
            const repoAUrl = process.env.REPO_A_URL;
            if (!repoAUrl) return null;
            
            // Remove .git suffix if present
            const baseUrl = repoAUrl.replace(/\.git$/, '');
            
            // Handle different Git hosting platforms
            if (baseUrl.includes('github.com')) {
                return `${baseUrl}/commit/${commitHash}`;
            } else if (baseUrl.includes('gitlab.com') || baseUrl.includes('gitlab')) {
                return `${baseUrl}/-/commit/${commitHash}`;
            } else if (baseUrl.includes('bitbucket.org')) {
                return `${baseUrl}/commits/${commitHash}`;
            } else {
                return `${baseUrl}/commit/${commitHash}`;
            }
        };

        // Generate PR title and description from commit messages
        let title = "Auto-merge from Repository A";
        let description = "This PR contains changes automatically merged from Repository A.\n\n";
        
        if (commitMessages && commitMessages.length > 0) {
            if (commitMessages.length === 1) {
                const commit = commitMessages[0];
                const messageLines = commit.message.trim().split('\n');
                title = messageLines[0] || title;
                
                const commitHashShort = commit.hash.substring(0, 7);
                const commitUrl = createCommitUrl(commit.hash);
                
                description += `## 📝 Commit from Repository A\n\n`;
                if (commitUrl) {
                    description += `- ${title} ([${commitHashShort}](${commitUrl}))\n\n`;
                } else {
                    description += `- ${title} (\`${commitHashShort}\`)\n\n`;
                }
                
                if (messageLines.length > 1) {
                    const messageBody = messageLines.slice(1).filter(line => line.trim()).join('\n');
                    if (messageBody) {
                        description += `\`\`\`\n${messageBody}\n\`\`\`\n`;
                    }
                }
            } else {
                description += `## 📝 Commits from Repository A\n\n`;
                description += `This PR includes changes from **${commitMessages.length} commits**:\n\n`;
                
                commitMessages.forEach((commit, idx) => {
                    const commitHashShort = commit.hash.substring(0, 7);
                    const commitUrl = createCommitUrl(commit.hash);
                    
                    const messageLines = commit.message.trim().split('\n');
                    const messageTitle = messageLines[0];
                    const messageBody = messageLines.slice(1).filter(line => line.trim()).join('\n');
                    
                    if (commitUrl) {
                        description += `${idx + 1}. ${messageTitle} ([${commitHashShort}](${commitUrl}))\n\n`;
                    } else {
                        description += `${idx + 1}. ${messageTitle} (\`${commitHashShort}\`)\n\n`;
                    }
                    
                    if (messageBody) {
                        description += `   \`\`\`\n   ${messageBody.replace(/\n/g, '\n   ')}\n   \`\`\`\n\n`;
                    }
                });
                
                // Use first commit message as title
                title = commitMessages[0].message.split('\n')[0] || title;
            }
        }
        
        description += `\n---\n\n**Note**: This PR was created automatically without AI assistance. The diff from Repository A is applied directly.`;

        console.log("\n📝 Creating PR on GitHub...");
        console.log(`Title: ${title}`);
        
        // Use the diff directly as the patch (no Claude processing)
        const patch = diffText;
        const prUrl = await createPRonGitHub(title, description, patch);

        if (prUrl) {
            console.log(`✅ Successfully created PR: ${prUrl}`);
            return { success: true, prUrl, latestCommit };
        } else {
            console.log("⚠️ No changes after merge, PR not created");
            return { success: true, prUrl: null, latestCommit, reason: "No changes" };
        }
    } catch (err) {
        console.error("❌ Error in mergeAndCreatePRNoClaude:", err);
        return { success: false, error: err.message };
    }
};

