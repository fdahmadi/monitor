import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { createGit } from "./gitUtils.js";

const client = new Anthropic({
    apiKey: process.env.CLAUDE_API_KEY,
});

// Configuration for rate limit handling
const MAX_TOKENS_PER_REQUEST = parseInt(process.env.MAX_TOKENS_PER_REQUEST || "180000", 10); // Safe limit below 200k (API hard limit)
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || "30000", 10); // Max chars per file (default 30KB)
const MAX_FILES_TO_PROCESS = parseInt(process.env.MAX_FILES_TO_PROCESS || "10", 10); // Max files per request
const MAX_DIFF_SIZE = parseInt(process.env.MAX_DIFF_SIZE || "500000", 10); // Max diff size (500KB)
const RETRY_MAX_ATTEMPTS = parseInt(process.env.RETRY_MAX_ATTEMPTS || "3", 10);
const RETRY_BASE_DELAY_MS = parseInt(process.env.RETRY_BASE_DELAY_MS || "60000", 10); // 1 minute base delay

// Simple token estimator: ~4 characters per token (rough estimate for Claude)
const estimateTokens = (text) => {
    if (!text) return 0;
    // Rough estimate: 4 chars = 1 token, but add some buffer
    return Math.ceil(text.length / 3.5);
};

// Check if file should be excluded (auto-generated or build files)
const shouldExcludeFile = (filePath) => {
    // Exclude auto-generated files
    if (filePath.includes('/generated/') || 
        filePath.endsWith('.generated.ts') ||
        filePath.includes('node_modules/') || 
        filePath.includes('dist/') || 
        filePath.includes('build/') ||
        filePath.includes('.git/')) {
        return true;
    }
    return false;
};

// Check if file should be truncated (e.g., large files)
const shouldTruncateFile = (filePath, content) => {
    // Always truncate very large files (over MAX_FILE_SIZE)
    if (content && content.length > MAX_FILE_SIZE) {
        return true;
    }
    return false;
};

// Truncate content if too large
const truncateContent = (content, maxSize = MAX_FILE_SIZE) => {
    if (!content || content.length <= maxSize) return content;
    
    // Try to truncate at a reasonable point (e.g., at a newline)
    const truncated = content.substring(0, maxSize);
    const lastNewline = truncated.lastIndexOf('\n');
    if (lastNewline > maxSize * 0.8) {
        return truncated.substring(0, lastNewline) + '\n... [truncated - file too large]';
    }
    return truncated + '\n... [truncated - file too large]';
};

const runCmd = (cmd, cwd) => {
    return new Promise((resolve, reject) => {
        exec(cmd, { cwd }, (err, stdout, stderr) => {
            if (err) {
                // Better error handling - include both stderr and stdout for debugging
                const errorMsg = stderr?.trim() || stdout?.trim() || err.message || err.toString();
                const fullError = new Error(errorMsg);
                fullError.originalError = err;
                fullError.stdout = stdout?.trim();
                fullError.stderr = stderr?.trim();
                return reject(fullError);
            }
            resolve(stdout.trim());
        });
    });
};

export const getDiffFromA = async () => {
    const repoPath = process.env.REPO_A_PATH;
    const branch = process.env.REPO_A_BRANCH;
    return runCmd(`git diff HEAD~1 HEAD`, repoPath);
};

// Extract changed files and their operation types (new, deleted, modified, renamed)
export const extractChangedFiles = (diffText) => {
    const files = new Map(); // Map of file path -> { operation: 'new'|'deleted'|'modified'|'renamed', pathA, pathB }
    
    // Regex to match: diff --git a/path b/path
    // Handles:
    // - Standard format: diff --git a/file.txt b/file.txt
    // - New files: diff --git a/dev/null b/newfile.txt
    // - Deleted files: diff --git a/file.txt b/dev/null
    // - Quoted paths with spaces: diff --git a/"file name.txt" b/"file name.txt"
    const regex = /^diff --git (?:a\/([^\s"]+)|a\/"([^"]+)") (?:b\/([^\s"]+)|b\/"([^"]+)")\s*$/gm;
    let match;
    
    while ((match = regex.exec(diffText)) !== null) {
        // Extract paths - handle both quoted and unquoted
        // match[1] = unquoted pathA, match[2] = quoted pathA
        // match[3] = unquoted pathB, match[4] = quoted pathB
        const pathA = match[1] || match[2] || '';
        const pathB = match[3] || match[4] || '';
        
        if (!pathA && !pathB) continue; // Skip if we couldn't extract paths
        
        // Determine the actual file path and operation type
        let actualPath;
        let operation;
        
        if (pathA === '/dev/null' || pathA === 'null' || !pathA) {
            // New file (created in A)
            actualPath = pathB;
            operation = 'new';
        } else if (pathB === '/dev/null' || pathB === 'null' || !pathB) {
            // Deleted file
            actualPath = pathA;
            operation = 'deleted';
        } else if (pathA !== pathB) {
            // Renamed or moved file (different paths)
            actualPath = pathB; // Use destination path
            operation = 'renamed';
        } else {
            // Modified file (same path)
            actualPath = pathB;
            operation = 'modified';
        }
        
        files.set(actualPath, { operation, pathA: pathA || '/dev/null', pathB: pathB || '/dev/null' });
    }
    
    return files;
};

// Read files from repository B
export const readFilesFromB = async (filesMap) => {
    const repoB = process.env.REPO_B_PATH;
    const result = {};

    for (const [filePath, fileInfo] of filesMap.entries()) {
        const fullPath = path.join(repoB, filePath);
        try {
            let content = await readFile(fullPath, "utf8");
            
            // Truncate large files
            if (shouldTruncateFile(filePath, content)) {
                // For translation files, keep only first 5000 chars
                if (filePath.includes('/lang/') && filePath.endsWith('.json')) {
                    content = truncateContent(content, 5000);
                } else {
                    // For other large files, truncate to MAX_FILE_SIZE
                    content = truncateContent(content, MAX_FILE_SIZE);
                }
            }
            
            result[filePath] = { content, operation: fileInfo.operation };
        } catch {
            // File doesn't exist in B (normal for new files)
            result[filePath] = { content: null, operation: fileInfo.operation };
        }
    }
    return result;
};

// Read files from repository A (especially for new files)
export const readFilesFromA = async (filesMap) => {
    const repoA = process.env.REPO_A_PATH;
    const result = {};

    for (const [filePath, fileInfo] of filesMap.entries()) {
        // For new files, read from A to get the content
        if (fileInfo.operation === 'new') {
            const fullPath = path.join(repoA, filePath);
            try {
                let content = await readFile(fullPath, "utf8");
                
                // Truncate large files
                if (shouldTruncateFile(filePath, content)) {
                    // For translation files, keep only first 5000 chars
                    if (filePath.includes('/lang/') && filePath.endsWith('.json')) {
                        content = truncateContent(content, 5000);
                    } else {
                        // For other large files, truncate to MAX_FILE_SIZE
                        content = truncateContent(content, MAX_FILE_SIZE);
                    }
                }
                
                result[filePath] = { content, operation: fileInfo.operation };
            } catch (err) {
                console.warn(`Could not read new file from A: ${filePath}`, err.message);
                result[filePath] = { content: null, operation: fileInfo.operation };
            }
        } else {
            // For modified/deleted files, we can optionally read from A too
            const fullPath = path.join(repoA, filePath);
            try {
                let content = await readFile(fullPath, "utf8");
                
                // Truncate large files
                if (shouldTruncateFile(filePath, content)) {
                    // For translation files, keep only first 5000 chars
                    if (filePath.includes('/lang/') && filePath.endsWith('.json')) {
                        content = truncateContent(content, 5000);
                    } else {
                        // For other large files, truncate to MAX_FILE_SIZE
                        content = truncateContent(content, MAX_FILE_SIZE);
                    }
                }
                
                result[filePath] = { content, operation: fileInfo.operation };
            } catch {
                result[filePath] = { content: null, operation: fileInfo.operation };
            }
        }
    }
    return result;
};

// Check if file is a translation file
const isTranslationFile = (filePath) => {
    return filePath.includes('/lang/') && filePath.endsWith('.json');
};

// Filter translation files BEFORE reading them (to save memory and tokens)
export const filterTranslationFilesBeforeReading = (filesMap) => {
    const translationFiles = new Map(); // category -> [{ filePath, language, fileInfo }]
    const nonTranslationFiles = new Map();
    const filteredTranslationFiles = new Map();
    const skippedTranslationFiles = [];
    
    // Separate translation files from others, and exclude auto-generated files
    const excludedFiles = [];
    for (const [filePath, fileInfo] of filesMap.entries()) {
        // Exclude auto-generated and build files
        if (shouldExcludeFile(filePath)) {
            excludedFiles.push(filePath);
            console.log(`   🚫 Excluding auto-generated/build file: ${filePath}`);
            continue;
        }
        
        const info = getTranslationFileInfo(filePath);
        if (info) {
            // Group by category (back/front)
            if (!translationFiles.has(info.category)) {
                translationFiles.set(info.category, []);
            }
            translationFiles.get(info.category).push({ ...info, fileInfo });
        } else {
            nonTranslationFiles.set(filePath, fileInfo);
        }
    }
    
    if (excludedFiles.length > 0) {
        console.log(`🚫 Excluded ${excludedFiles.length} auto-generated/build file(s)`);
    }
    
    // For each category, keep only one sample (prefer 'en.json' if available, otherwise first one)
    for (const [category, files] of translationFiles.entries()) {
        // Sort: prefer 'en.json', then alphabetically
        files.sort((a, b) => {
            if (a.language === 'en') return -1;
            if (b.language === 'en') return 1;
            return a.language.localeCompare(b.language);
        });
        
        // Keep only the first one (preferred sample)
        const sample = files[0];
        filteredTranslationFiles.set(sample.filePath, sample.fileInfo);
        
        // Collect skipped files
        if (files.length > 1) {
            const skipped = files.slice(1).map(f => f.language).join(', ');
            skippedTranslationFiles.push(...files.slice(1).map(f => f.filePath));
            console.log(`   📝 Translation files (${category}): Keeping ${sample.language}.json, skipping ${files.length - 1} other(s): ${skipped}`);
        }
    }
    
    // Combine non-translation files with filtered translation files
    const filteredMap = new Map([...nonTranslationFiles, ...filteredTranslationFiles]);
    
    return {
        filteredMap,
        skippedTranslationFiles
    };
};

// Get translation file category (front/back) and language code
const getTranslationFileInfo = (filePath) => {
    if (!isTranslationFile(filePath)) return null;
    
    // Match patterns like: .../lang/back/en.json or .../lang/front/de.json
    const match = filePath.match(/\/lang\/(back|front)\/([^\/]+)\.json$/);
    if (match) {
        return {
            category: match[1], // 'back' or 'front'
            language: match[2], // 'en', 'de', 'fr', etc.
            filePath
        };
    }
    return null;
};

// Filter translation files - keep only one sample per category (front/back)
const filterTranslationFiles = (filePaths) => {
    const translationFiles = new Map(); // category -> { filePath, language }
    const nonTranslationFiles = [];
    const filteredTranslationFiles = [];
    
    // Separate translation files from others
    for (const filePath of filePaths) {
        const info = getTranslationFileInfo(filePath);
        if (info) {
            // Group by category (back/front)
            if (!translationFiles.has(info.category)) {
                translationFiles.set(info.category, []);
            }
            translationFiles.get(info.category).push(info);
        } else {
            nonTranslationFiles.push(filePath);
        }
    }
    
    // For each category, keep only one sample (prefer 'en.json' if available, otherwise first one)
    for (const [category, files] of translationFiles.entries()) {
        // Sort: prefer 'en.json', then alphabetically
        files.sort((a, b) => {
            if (a.language === 'en') return -1;
            if (b.language === 'en') return 1;
            return a.language.localeCompare(b.language);
        });
        
        // Keep only the first one (preferred sample)
        const sample = files[0];
        filteredTranslationFiles.push(sample.filePath);
        
        // Log skipped files
        if (files.length > 1) {
            const skipped = files.slice(1).map(f => f.language).join(', ');
            console.log(`   📝 Translation files (${category}): Keeping ${sample.language}.json, skipping ${files.length - 1} other(s): ${skipped}`);
        }
    }
    
    // Collect all skipped translation files (all except the selected sample from each category)
    const skippedTranslationFiles = [];
    for (const [category, files] of translationFiles.entries()) {
        if (files.length > 1) {
            // Skip the first one (selected sample), add the rest
            skippedTranslationFiles.push(...files.slice(1).map(info => info.filePath));
        }
    }
    
    return {
        selected: [...nonTranslationFiles, ...filteredTranslationFiles],
        skippedTranslationFiles
    };
};

// Filter and prioritize files to reduce token usage
const filterAndPrioritizeFiles = (filesFromA, filesFromB, diffText) => {
    const filePaths = Object.keys(filesFromA);
    
    // First, filter translation files - keep only one sample per category
    const { selected: filesAfterTranslationFilter, skippedTranslationFiles } = filterTranslationFiles(filePaths);
    
    if (skippedTranslationFiles.length > 0) {
        console.log(`🌐 Filtered ${skippedTranslationFiles.length} translation file(s) - keeping only 1 sample per category (front/back)`);
    }
    
    // If we still have too many files, prioritize important ones
    if (filesAfterTranslationFilter.length > MAX_FILES_TO_PROCESS) {
        console.log(`⚠️ Too many files (${filesAfterTranslationFilter.length}), filtering to most important ${MAX_FILES_TO_PROCESS}...`);
        
        // Priority order:
        // 1. Source code files (not translation files)
        // 2. Configuration files
        // 3. Translation files (lowest priority)
        
        const prioritized = filesAfterTranslationFilter
            .map(filePath => {
                const priority = 
                    isTranslationFile(filePath) ? 3 : // Translation files - lowest
                    (filePath.endsWith('.ts') || filePath.endsWith('.tsx') || 
                     filePath.endsWith('.js') || filePath.endsWith('.jsx') ||
                     filePath.endsWith('.py') || filePath.endsWith('.graphql')) ? 1 : // Source code - highest
                    2; // Other files - medium
                
                return { filePath, priority };
            })
            .sort((a, b) => a.priority - b.priority)
            .slice(0, MAX_FILES_TO_PROCESS)
            .map(item => item.filePath);
        
        console.log(`📋 Selected ${prioritized.length} files for processing (skipped ${filesAfterTranslationFilter.length - prioritized.length} files)`);
        return { selected: prioritized, skippedTranslationFiles };
    }
    
    return { selected: filesAfterTranslationFilter, skippedTranslationFiles };
};

export const generatePRviaClaude = async (diffText, filesFromA, filesFromB, commitMessages = [], retryAttempt = 0, skippedTranslationFilesFromCaller = []) => {
    const repoAUrl = process.env.REPO_A_URL;
    const repoBUrl = process.env.REPO_B_URL;
    const model = process.env.CLAUDE_MODEL || "claude-3-5-sonnet-20241022";

    // Truncate diff if too large
    let truncatedDiff = diffText;
    if (diffText.length > MAX_DIFF_SIZE) {
        console.log(`⚠️ Diff too large (${diffText.length} chars), truncating to ${MAX_DIFF_SIZE} chars...`);
        truncatedDiff = diffText.substring(0, MAX_DIFF_SIZE) + '\n... [diff truncated - too large]';
    }

    // Filter files to reduce token usage (if not already filtered)
    const { selected: selectedFiles, skippedTranslationFiles: skippedFromFilter } = filterAndPrioritizeFiles(filesFromA, filesFromB, truncatedDiff);
    
    // Use skippedTranslationFiles from caller if provided, otherwise use from filter
    const skippedTranslationFiles = skippedTranslationFilesFromCaller.length > 0 
        ? skippedTranslationFilesFromCaller 
        : skippedFromFilter;
    
    // Build file information section (only for selected files)
    const fileInfoSections = [];
    let totalEstimatedTokens = estimateTokens(truncatedDiff);
    
    for (const filePath of selectedFiles) {
        const fileA = filesFromA[filePath];
        const fileB = filesFromB[filePath];
        const operation = fileA.operation || fileB.operation || 'modified';
        
        let section = `
FILE: ${filePath}
OPERATION: ${operation}
`;
        
        if (operation === 'new') {
            section += `-------------
This is a NEW file created in Repository A.

Content from Repository A:
${fileA.content || "(could not read file)"}

Current state in Repository B:
(file does not exist - should be created)
`;
        } else if (operation === 'deleted') {
            section += `-------------
This file was DELETED in Repository A.

Current state in Repository B:
${fileB.content || "(file not found in B)"}

Note: Consider whether this file should be deleted in B or kept.
`;
        } else {
            // Modified file
            section += `-------------
Content from Repository A (after changes):
${fileA.content || "(could not read from A)"}

Current state in Repository B:
${fileB.content || "(file not found in B)"}
`;
        }
        
        totalEstimatedTokens += estimateTokens(section);
        fileInfoSections.push(section);
    }
    
    // Check if we're approaching token limit (hard limit is 200k)
    if (totalEstimatedTokens > MAX_TOKENS_PER_REQUEST) {
        console.warn(`⚠️ Estimated tokens (${totalEstimatedTokens}) exceeds safe limit (${MAX_TOKENS_PER_REQUEST})`);
        console.warn(`   API hard limit is 200,000 tokens. Consider reducing MAX_FILES_TO_PROCESS or MAX_FILE_SIZE.`);
        
        // If still too high, throw error to prevent API rejection
        if (totalEstimatedTokens > 190000) {
            throw new Error(`Estimated tokens (${totalEstimatedTokens}) too close to API hard limit (200k). Please reduce MAX_FILES_TO_PROCESS or MAX_FILE_SIZE.`);
        }
    }

    // Add note about filtered files if any were skipped
    let fileNote = '';
    const allFiles = Object.keys(filesFromA);
    const skippedNonTranslationFiles = allFiles.filter(f => 
        !selectedFiles.includes(f) && !skippedTranslationFiles.includes(f)
    );
    
    // Add note about translation files
    if (skippedTranslationFiles.length > 0) {
        // Group skipped translation files by category
        const skippedByCategory = {};
        for (const filePath of skippedTranslationFiles) {
            const info = getTranslationFileInfo(filePath);
            if (info) {
                if (!skippedByCategory[info.category]) {
                    skippedByCategory[info.category] = [];
                }
                skippedByCategory[info.category].push(info.language);
            }
        }
        
        fileNote += `\n\n🌐 TRANSLATION FILES NOTE:\n`;
        fileNote += `Only one sample translation file per category (front/back) was included in this request.\n`;
        fileNote += `The same changes should be applied to ALL other language files in the same category.\n\n`;
        
        for (const [category, languages] of Object.entries(skippedByCategory)) {
            fileNote += `- ${category}/: Sample file included. Apply same changes to: ${languages.join(', ')}\n`;
        }
        fileNote += `\nPlease review the git diff and apply the same translation changes to all language files.\n`;
    }
    
    // Add note about other skipped files
    if (skippedNonTranslationFiles.length > 0) {
        fileNote += `\n\nNOTE: ${skippedNonTranslationFiles.length} other file(s) were skipped due to size limits. Please review the git diff for complete changes.\n`;
        fileNote += `Skipped files: ${skippedNonTranslationFiles.slice(0, 10).join(', ')}${skippedNonTranslationFiles.length > 10 ? '...' : ''}\n`;
    }

    const prompt = `
You are an AI expert in code merging and git patch generation.

Repository A URL: ${repoAUrl}
Repository B URL: ${repoBUrl}

Latest changes in Repository A (Git Diff):
-------------------------
${truncatedDiff}

Detailed file information:
-------------------------
${fileInfoSections.join("\n\n")}
${fileNote}
Task:
Generate the best possible Pull Request patch that intelligently merges
changes from A into B, preserving any custom modifications in B.

CRITICAL PATCH FORMAT REQUIREMENTS:
The patch MUST be a valid unified diff format that can be applied with 'git apply'. 
Follow these EXACT rules:

1. For MODIFIED files, use this format:
   diff --git a/path/to/file b/path/to/file
   index <hash1>..<hash2> <mode>
   --- a/path/to/file
   +++ b/path/to/file
   @@ -<old_start>,<old_lines> +<new_start>,<new_lines> @@
   <context lines>
   -<removed lines>
   +<added lines>
   <context lines>

2. For NEW files, use this format:
   diff --git a/dev/null b/path/to/newfile
   new file mode 100644
   index 0000000..<hash> <mode>
   --- /dev/null
   +++ b/path/to/newfile
   @@ -0,0 +1,<lines> @@
   +<file content lines>

3. For DELETED files, use this format:
   diff --git a/path/to/file b/dev/null
   deleted file mode 100644
   index <hash>..0000000 <mode>
   --- a/path/to/file
   +++ /dev/null
   @@ -1,<lines> +0,0 @@
   -<file content lines>

4. IMPORTANT:
   - EVERY line of code MUST have a leading '+' or '-' or ' ' (space for context)
   - Include proper @@ hunk headers with correct line numbers
   - Include enough context lines (at least 3 lines before and after changes)
   - The patch MUST be complete and valid - git apply will reject incomplete patches

EXAMPLE of a valid patch for a modified file:
\`\`\`
diff --git a/example.js b/example.js
index abc1234..def5678 100644
--- a/example.js
+++ b/example.js
@@ -1,5 +1,6 @@
 function hello() {
-  console.log("Hello");
+  console.log("Hello World");
+  console.log("Updated");
 }
\`\`\`

Return your response in the following EXACT format:
---
TITLE: [Your PR title here]
---
DESCRIPTION: [Your PR description here]
---
PATCH:
[Complete valid git unified diff - must be applyable with 'git apply']
---
`;

    try {
        const res = await client.messages.create({
            model,
            max_tokens: 16384,
            messages: [{ role: "user", content: prompt }],
        });

        return res.content[0].text;
    } catch (error) {
        // Handle rate limit errors with retry logic
        if (error.status === 429 && retryAttempt < RETRY_MAX_ATTEMPTS) {
            const retryAfter = error.headers?.get('retry-after') || 
                              error.headers?.['retry-after'] || 
                              String(RETRY_BASE_DELAY_MS / 1000);
            const delaySeconds = parseInt(retryAfter, 10);
            const delayMs = delaySeconds * 1000;
            
            // Use exponential backoff: delay * (2 ^ retryAttempt)
            const backoffDelay = delayMs * Math.pow(2, retryAttempt);
            
            console.warn(`\n⚠️ Rate limit hit. Waiting ${Math.round(backoffDelay / 1000)} seconds before retry ${retryAttempt + 1}/${RETRY_MAX_ATTEMPTS}...`);
            console.warn(`   Error: ${error.message}`);
            
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
            
            // Retry with same parameters
            return generatePRviaClaude(diffText, filesFromA, filesFromB, commitMessages, retryAttempt + 1);
        }
        
        // Re-throw if not a rate limit error or max retries reached
        throw error;
    }
};

// Parse Claude's response to extract title, description, and patch
export const parseClaudeResponse = (response) => {
    // Try to match the structured format first
    const titleMatch = response.match(/TITLE:\s*(.+?)(?=\n---|\nDESCRIPTION:|$)/s);
    const descMatch = response.match(/DESCRIPTION:\s*(.+?)(?=\n---|\nPATCH:|$)/s);
    
    // Improved regex to capture patch - look for PATCH: and capture until end or next ---
    // Also handle cases where PATCH might be in markdown code blocks
    let patchMatch = response.match(/PATCH:\s*([\s\S]+?)(?=\n---\s*$|\n---\s*\n|$)/s);
    
    // If not found, try to find it after DESCRIPTION or in code blocks
    if (!patchMatch) {
        // Try to find patch in code blocks
        const codeBlockMatch = response.match(/```(?:diff|patch|text)?\n([\s\S]+?)```/);
        if (codeBlockMatch && codeBlockMatch[1].includes('diff --git')) {
            patchMatch = { 1: codeBlockMatch[1] };
        }
    }
    
    // If still not found, try finding patch section more flexibly
    if (!patchMatch) {
        const patchSectionMatch = response.match(/(?:PATCH|Patch):\s*\n([\s\S]+?)(?=\n\n|\n---|$)/);
        if (patchSectionMatch) {
            patchMatch = patchSectionMatch;
        }
    }
    
    let title = titleMatch ? titleMatch[1].trim() : "Merge changes from Repository A";
    let description = descMatch ? descMatch[1].trim() : "Automated merge of changes from Repository A using AI.";
    let patch = patchMatch ? patchMatch[1].trim() : null;
    
    // Fallback: try to extract patch if format is different
    if (!patch) {
        const lines = response.split('\n');
        let patchStart = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('diff --git') || 
                (lines[i].startsWith('---') && i + 1 < lines.length && lines[i + 1].startsWith('+++'))) {
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
        // Remove code block markers
        patch = patch.replace(/^```[\w]*\n/gm, '').replace(/\n```$/gm, '').trim();
        patch = patch.replace(/^```[a-z]*/gm, '').replace(/```$/gm, '').trim();
        // Remove any remaining markdown formatting
        patch = patch.replace(/^\*\*\*.*\*\*\*\n/gm, '').trim();
    }
    
    // Validate patch has basic structure
    if (patch && !patch.match(/^diff --git|^---|^Index:|^\*\*\*/m)) {
        console.warn("⚠️ Warning: Patch format might be invalid - no standard diff markers found");
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
        
        // Log patch preview for debugging
        console.log(`\n📝 Patch preview (first 500 chars):`);
        console.log(patch.substring(0, 500) + (patch.length > 500 ? '...' : ''));
        
        // Track if patch was applied with rejects (for PR description)
        let appliedWithRejects = false;
        
        // Apply patch
        try {
            // Use absolute path and proper escaping for cross-platform compatibility
            const normalizedPath = path.resolve(patchFile).replace(/\\/g, '/');
            console.log(`\n🔧 Applying patch: ${normalizedPath}`);
            
            // Clean up any existing .rej files first
            try {
                await runCmd(`find . -name "*.rej" -delete 2>/dev/null || true`, repoBPath);
            } catch {}
            
            let patchApplied = false;
            
            // Strategy 1: Try with 3-way merge (best for when files differ)
            try {
                await runCmd(`git apply --3way --ignore-whitespace "${normalizedPath}"`, repoBPath);
                console.log(`✅ Patch applied successfully with --3way`);
                patchApplied = true;
            } catch (apply3wayError) {
                console.log(`⚠️ 3-way apply failed, trying other methods...`);
                
                // Strategy 2: Try with reject (applies what it can, rejects what it can't)
                // --reject will apply what it can and create .rej files for what it can't
                // It may exit with error code, so we need to handle that
                try {
                    // Try apply with reject - command may exit with error even if partial apply succeeded
                    const result = await runCmd(`git apply --reject --ignore-whitespace "${normalizedPath}" 2>&1; exit 0`, repoBPath);
                    // Check result for any useful info
                    if (result && result.includes('error:')) {
                        console.log(`Reject strategy had some errors (this is expected if files differ)`);
                    }
                } catch (rejectCmdError) {
                    // Command may fail, but that's OK - check for actual results below
                    // Even if command fails, partial apply might have succeeded
                }
                
                // Check if any files were actually modified or if we got rejects
                const statusCheck = await git.status();
                const hasChanges = statusCheck.files && statusCheck.files.length > 0;
                
                let rejectCheck = '';
                try {
                    rejectCheck = await runCmd(`find . -name "*.rej" 2>/dev/null || true`, repoBPath);
                } catch {}
                const hasRejects = rejectCheck && rejectCheck.trim().length > 0;
                
                if (hasChanges || hasRejects) {
                    if (hasRejects) {
                        console.log(`⚠️ Patch applied with some rejects (partial apply)`);
                        console.log(`Rejected parts in: ${rejectCheck.trim()}`);
                        appliedWithRejects = true;
                    } else {
                        console.log(`✅ Patch applied successfully with reject strategy`);
                    }
                    patchApplied = true;
                }
                
                // If reject strategy didn't work, try other methods
                if (!patchApplied) {
                    console.log(`⚠️ Reject strategy found no changes. Trying whitespace fixes...`);
                    
                    // Strategy 3: Try with whitespace fixes
                    try {
                        await runCmd(`git apply --ignore-whitespace --whitespace=fix "${normalizedPath}"`, repoBPath);
                        console.log(`✅ Patch applied successfully with whitespace fixes`);
                        patchApplied = true;
                    } catch (whitespaceError) {
                        console.log(`⚠️ Whitespace fix failed, trying ignore-whitespace only...`);
                        
                        // Strategy 4: Just ignore whitespace
                        try {
                            await runCmd(`git apply --ignore-whitespace "${normalizedPath}"`, repoBPath);
                            console.log(`✅ Patch applied successfully with ignore-whitespace`);
                            patchApplied = true;
                        } catch (ignoreError) {
                            // Strategy 5: Last resort - basic apply
                            console.log(`⚠️ All methods failed. Trying basic apply as last resort...`);
                            await runCmd(`git apply "${normalizedPath}"`, repoBPath);
                            console.log(`✅ Patch applied successfully with basic apply`);
                            patchApplied = true;
                        }
                    }
                }
            }
            
            if (!patchApplied) {
                throw new Error("All patch apply strategies failed");
            }
            
            // Double-check for .rej files (partial applies)
            try {
                const rejectFiles = await runCmd(`find . -name "*.rej" 2>/dev/null || true`, repoBPath);
                if (rejectFiles && rejectFiles.trim()) {
                    console.log(`⚠️ Warning: Some parts of the patch were rejected:`);
                    console.log(rejectFiles);
                    appliedWithRejects = true;
                }
            } catch {}
            
            // Verify we have actual changes to commit
            const verifyStatus = await git.status();
            if (verifyStatus.files.length === 0) {
                console.log(`⚠️ Warning: No files changed after patch application`);
                // This is OK if we had rejects - we'll handle it later
            }
        } catch (applyError) {
            // Clean up patch file
            try {
                await unlink(patchFile);
            } catch {}
            
            // Better error reporting - handle different error types
            let errorMsg = 'Unknown error';
            if (typeof applyError === 'string') {
                errorMsg = applyError;
            } else if (applyError instanceof Error) {
                errorMsg = applyError.message || applyError.toString();
            } else if (applyError) {
                errorMsg = applyError.message || 
                          applyError.stderr || 
                          applyError.stdout || 
                          String(applyError);
            }
            
            console.error(`\n❌ Patch apply error details:`);
            console.error(`Error message: ${errorMsg}`);
            if (applyError && applyError.stderr) {
                console.error(`STDERR: ${applyError.stderr}`);
            }
            if (applyError && applyError.stdout) {
                console.error(`STDOUT: ${applyError.stdout}`);
            }
            if (applyError && applyError.stack) {
                console.error(`Stack: ${applyError.stack}`);
            }
            
            // Save patch file for debugging (with error suffix)
            try {
                const errorPatchFile = path.join(repoBPath, `temp-patch-${timestamp}.error.patch`);
                await writeFile(errorPatchFile, patch, "utf8");
                console.error(`\n💾 Failed patch saved to: ${errorPatchFile}`);
            } catch (saveErr) {
                console.warn("Could not save error patch file:", saveErr.message);
            }
            
            throw new Error(`Failed to apply patch: ${errorMsg}`);
        }
        
        // Clean up patch file
        try {
            await unlink(patchFile);
        } catch (cleanupError) {
            console.warn("Could not clean up patch file:", cleanupError.message);
        }
        
        // Check if there are any changes
        const status = await git.status();
        
        // Clean up .rej files - they're just rejection info, not actual changes
        // First, find and read .rej files for PR description
        let rejectDetails = '';
        if (appliedWithRejects) {
            try {
                const rejectFiles = await runCmd(`find . -name "*.rej" 2>/dev/null || true`, repoBPath);
                if (rejectFiles && rejectFiles.trim()) {
                    const rejectFileList = rejectFiles.trim().split('\n').filter(f => f.trim());
                    rejectDetails = `\n\n⚠️ **Parts of the patch could not be automatically applied**\n\n`;
                    rejectDetails += `The following files had conflicts and need manual review:\n`;
                    
                    for (const rejectFile of rejectFileList) {
                        try {
                            // Handle both relative and absolute paths from find command
                            const rejectFilePath = rejectFile.startsWith('/') 
                                ? rejectFile 
                                : path.join(repoBPath, rejectFile.replace(/^\.\//, ''));
                            const rejectContent = await readFile(rejectFilePath, 'utf8');
                            // Limit content to first 500 chars to avoid huge PR descriptions
                            const preview = rejectContent.substring(0, 500);
                            // Show relative path in PR description
                            const relativePath = rejectFile.replace(/^\.\//, '');
                            rejectDetails += `\n**${relativePath}** (first 500 chars):\n\`\`\`\n${preview}${rejectContent.length > 500 ? '...' : ''}\n\`\`\`\n`;
                        } catch (readErr) {
                            rejectDetails += `\n**${rejectFile}** (could not read file: ${readErr.message})\n`;
                        }
                    }
                    
                    rejectDetails += `\nPlease review these rejected parts and apply them manually if needed.`;
                }
            } catch (err) {
                console.warn("Could not read reject files:", err.message);
            }
        }
        
        // Remove .rej files before staging (they're not meant to be committed)
        try {
            await runCmd(`find . -name "*.rej" -delete 2>/dev/null || true`, repoBPath);
            console.log(`🧹 Cleaned up .rej files before commit`);
        } catch (cleanupErr) {
            console.warn("Could not clean up .rej files:", cleanupErr.message);
        }
        
        // Re-check status after cleanup
        const finalStatus = await git.status();
        const actualFiles = finalStatus.files.filter(file => !file.path.endsWith('.rej'));
        
        if (actualFiles.length === 0) {
            // No changes, delete branch and return
            await git.checkout(repoBBranch);
            await git.deleteLocalBranch(branchName);
            console.log("No changes after applying patch, skipping PR creation");
            return null;
        }
        
        // Add reject details to description
        if (appliedWithRejects) {
            description += rejectDetails || `\n\n⚠️ **Note**: Some parts of the patch could not be automatically applied. Please review the changes carefully and check for any conflicts.`;
        }
        
        // Stage all changes (excluding .rej files which are now deleted)
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

