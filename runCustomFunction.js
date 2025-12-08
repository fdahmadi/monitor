import {
    getDiffFromA,
    extractChangedFiles,
    readFilesFromB,
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
        const changedFiles = extractChangedFiles(diffText);
        console.log(`Found ${changedFiles.length} changed file(s):`, changedFiles);

        console.log("Reading files from Repository B...");
        const filesFromB = await readFilesFromB(changedFiles);

        console.log("Sending to Claude for intelligent merge...");
        const claudeResponse = await generatePRviaClaude(diffText, filesFromB);

        console.log("Parsing Claude response...");
        const { title, description, patch } = parseClaudeResponse(claudeResponse);

        if (!patch) {
            console.error("❌ Could not extract patch from Claude response");
            console.log("Claude response:", claudeResponse);
            return { success: false, reason: "No patch extracted" };
        }

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

