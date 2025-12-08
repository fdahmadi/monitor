import {
    getDiffFromA,
    extractChangedFiles,
    readFilesFromB,
    readFilesFromA,
    generatePRviaClaude,
    parseClaudeResponse,
    createPRonGitHub,
} from "./createSmartPR.js";

export const runCustomFunction = async (diffText, latestCommit) => {
    console.log("Running Smart PR Generator...");

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

        console.log("Reading files from Repository A...");
        const filesFromA = await readFilesFromA(changedFilesMap);

        console.log("Reading files from Repository B...");
        const filesFromB = await readFilesFromB(changedFilesMap);

        console.log("Sending to Claude for intelligent merge...");
        const claudeResponse = await generatePRviaClaude(diffText, filesFromA, filesFromB);

        console.log("Parsing Claude response...");
        let { title, description, patch } = parseClaudeResponse(claudeResponse);

        if (!patch) {
            console.error("❌ Could not extract patch from Claude response");
            console.log("Claude response (first 2000 chars):", claudeResponse.substring(0, 2000));
            return { success: false, reason: "No patch extracted" };
        }

        // Validate patch format more strictly
        const hasDiffHeader = patch.includes('diff --git');
        const hasFileMarkers = patch.includes('---') && patch.includes('+++');
        const hasContent = patch.includes('@@') || patch.match(/^[\+\- ]/m);
        
        const isValidPatch = hasDiffHeader && hasFileMarkers && hasContent;
        
        if (!isValidPatch) {
            console.error("❌ Invalid patch format from Claude");
            console.log("Patch validation details:");
            console.log(`  - Has 'diff --git': ${hasDiffHeader}`);
            console.log(`  - Has '---' and '+++': ${hasFileMarkers}`);
            console.log(`  - Has content ('@@' or '+/-' lines): ${hasContent}`);
            console.log("Patch preview (first 1000 chars):", patch.substring(0, 1000));
            console.log("\n⚠️ Attempting to use original diff as fallback...");
            
            // Log full Claude response for debugging (first 3000 chars)
            console.log("\n🔍 Full Claude response (first 3000 chars) for debugging:");
            console.log(claudeResponse.substring(0, 3000));
            
            // Fallback: try to use the original diff if Claude's patch is invalid
            if (diffText && diffText.trim().length > 0) {
                console.log("Using original diff as patch (paths should already be correct)");
                patch = diffText;
            } else {
                return { success: false, reason: "Invalid patch format and no fallback available" };
            }
        }

        // Check for minimum required patch structure
        const patchLines = patch.split('\n').filter(line => line.trim().length > 0);
        if (patchLines.length < 5) {
            console.error("❌ Invalid patch format - patch too short to be valid");
            console.log("Patch content:", patch);
            return { success: false, reason: "Patch too short" };
        }

        console.log(`✅ Patch extracted and validated (${patch.length} chars, ${patchLines.length} lines)`);
        console.log("Creating PR on GitHub...");
        const prUrl = await createPRonGitHub(title, description, patch);

        if (prUrl) {
            console.log(`✅ Successfully created PR: ${prUrl}`);
            return { success: true, prUrl, latestCommit };
        } else {
            console.log("⚠️ No changes after merge, PR not created");
            return { success: true, prUrl: null, latestCommit, reason: "No changes" };
        }
    } catch (err) {
        console.error("❌ Error in runCustomFunction:", err);
        return { success: false, error: err.message };
    }
};

