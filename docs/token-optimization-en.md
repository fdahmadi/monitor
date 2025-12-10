# Token Optimization

## 📋 Summary

This documentation explains the changes made to prevent **Rate Limit** (429) and **Invalid Request** (400) errors in the Claude API. Main issues:
- Requests were consuming more than the allowed limit of 450,000 tokens per minute
- Prompts were exceeding the API hard limit of 200,000 tokens per request

## 🔍 Main Problem

When many files were changed (e.g., 32 files), all file contents along with the diff were sent to Claude, which caused:
- Token count to exceed the allowed limit (450k/min) → `429 Rate Limit Error`
- Prompt to exceed API hard limit (200k tokens) → `400 Invalid Request Error`
- Commit processing to stop

## 🆕 Version 2.0.0 Changes

### New Improvements:
- ✅ Reduced limits to respect API hard limit (200k tokens)
- ✅ Filter translation files **BEFORE reading** (16 files → 2 files)
- ✅ Exclude auto-generated files (`/generated/`, `*.generated.ts`)
- ✅ Truncate large diffs (>500KB)
- ✅ Stricter check for API hard limit

### New Default Settings:
- `MAX_TOKENS_PER_REQUEST`: 180k (below 200k API limit)
- `MAX_FILE_SIZE`: 30KB (reduced from 50KB)
- `MAX_FILES_TO_PROCESS`: 10 (reduced from 20)
- `MAX_DIFF_SIZE`: 500KB (new)

## ✅ Implemented Solutions

### 1. File Size Limiting

**Problem:** Large files (like translation JSON files) can consume thousands of tokens.

**Solution:**
- Files larger than 30KB are automatically truncated
- Translation files (`/lang/*.json`) only send the first 5000 characters
- Truncation happens at a reasonable point (e.g., last complete line)
- Diffs larger than 500KB are truncated

**Code:**
```javascript
const MAX_FILE_SIZE = 30000; // 30KB default
const MAX_DIFF_SIZE = 500000; // 500KB default
const truncateContent = (content, maxSize) => {
    if (content.length <= maxSize) return content;
    // Truncate at reasonable point (newline)
    // ...
}
```

### 2. Smart File Filtering

**Problem:** Processing all files even if they're unnecessary.

**Solution:**
- Translation files are filtered **BEFORE reading** (only 1 sample per category)
- If more than 10 files have changed, only the most important ones are processed
- Auto-generated files (`/generated/`, `*.generated.ts`) are completely excluded
- Prioritization:
  1. **High Priority:** Code files (`.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.graphql`)
  2. **Medium Priority:** Configuration files and other files
  3. **Low Priority:** Translation files (`/lang/*.json`)

**Code:**
```javascript
const MAX_FILES_TO_PROCESS = 10; // Default
// Filter translation files BEFORE reading
const filterTranslationFilesBeforeReading = (filesMap) => {
    // Keep only 1 sample per category (front/back)
    // ...
}
const filterAndPrioritizeFiles = (filesFromA, filesFromB, diffText) => {
    // Prioritize source code files over translation files
    // ...
}
```

### 3. Token Estimation & Limiting

**Problem:** We didn't know how many tokens would be consumed before sending.

**Solution:**
- Token count is estimated before sending
- Maximum 180,000 tokens per request (below 200k API hard limit for safety)
- Error is thrown if estimate exceeds 190k (before sending to API)
- Strict check for API hard limit (200k tokens)

**Code:**
```javascript
const MAX_TOKENS_PER_REQUEST = 180000; // Safe limit below 200k API hard limit
if (totalEstimatedTokens > 190000) {
    throw new Error('Too close to API hard limit (200k)');
}
const estimateTokens = (text) => {
    // Rough estimate: ~3.5 chars per token
    return Math.ceil(text.length / 3.5);
}
```

### 4. Retry with Exponential Backoff

**Problem:** If a rate limit error occurred, the request would completely fail.

**Solution:**
- Automatic retry on 429 errors
- Delay between retries increases exponentially
- Maximum 3 retry attempts
- Uses API's `retry-after` header

**Code:**
```javascript
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 60000; // 1 minute

// Exponential backoff: delay * (2 ^ retryAttempt)
const backoffDelay = delayMs * Math.pow(2, retryAttempt);
```

### 5. Filter Translation Files Before Reading

**Problem:** Translation files (18+ files) were all being read and consuming too many tokens.

**Solution:**
- Translation files are filtered **BEFORE reading from disk**
- Only one sample per category (front/back) is read
- Priority given to `en.json`, otherwise alphabetically
- Other translation files are filtered and explained in PR description

**Code:**
```javascript
export const filterTranslationFilesBeforeReading = (filesMap) => {
    // Filter translation files BEFORE reading from disk
    // Keep only 1 sample per category (front/back)
    // ...
}
```

**Result:**
- 18 translation files → 2 files (16 files filtered)
- Significant reduction in token usage

### 6. Diff Truncation

**Problem:** Large diffs can consume thousands of tokens.

**Solution:**
- Diffs larger than 500KB are truncated
- Truncation happens before sending to API

**Code:**
```javascript
const MAX_DIFF_SIZE = 500000; // 500KB default
if (diffText.length > MAX_DIFF_SIZE) {
    truncatedDiff = diffText.substring(0, MAX_DIFF_SIZE) + '\n... [diff truncated]';
}
```

### 7. Filtering Unnecessary Files

**Problem:** Build files, node_modules, etc. were also being processed.

**Solution:**
- Files in `node_modules/`, `dist/`, `build/`, and `.git/` are filtered
- Auto-generated files (`/generated/`, `*.generated.ts`) are completely excluded
- Translation files are handled specially (filtered before reading)

**Code:**
```javascript
const shouldExcludeFile = (filePath) => {
    if (filePath.includes('/generated/') || 
        filePath.endsWith('.generated.ts') ||
        filePath.includes('node_modules/') || 
        filePath.includes('dist/') || 
        filePath.includes('build/') ||
        filePath.includes('.git/')) {
        return true;
    }
    return false;
}
```

## ⚙️ Configurable Settings

All these limits are configurable through environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_TOKENS_PER_REQUEST` | 180000 | Maximum tokens per request (below 200k API limit) |
| `MAX_FILE_SIZE` | 30000 | Maximum file size (characters) |
| `MAX_FILES_TO_PROCESS` | 10 | Maximum number of files per request |
| `MAX_DIFF_SIZE` | 500000 | Maximum diff size (characters) |
| `RETRY_MAX_ATTEMPTS` | 3 | Number of retry attempts |
| `RETRY_BASE_DELAY_MS` | 60000 | Base delay for retry (milliseconds) |

### Example Settings in `.env`:

```bash
# For large commits, reduce the number of files
MAX_FILES_TO_PROCESS=8

# If you still get errors, reduce tokens further
MAX_TOKENS_PER_REQUEST=150000

# For smaller files, reduce the size
MAX_FILE_SIZE=20000

# For large diffs, reduce the size
MAX_DIFF_SIZE=300000
```

## 📊 Results

After applying these changes:

✅ **Large files are automatically truncated**
- Translation files only send a small sample (filtered before reading)
- Files larger than 30KB are truncated
- Diffs larger than 500KB are truncated
- Auto-generated files are completely excluded

✅ **Automatic retry on rate limit errors**
- Smart delay with exponential backoff
- Uses `retry-after` header from API

✅ **Only the most important files are processed**
- Translation files are filtered before reading (16 files → 2 files)
- Maximum 10 files are processed
- Priority given to code files
- Translation files have low priority

✅ **Token count is controlled before sending**
- Accurate estimation before sending
- Warning if approaching the limit
- Error if too close to API hard limit (200k)

## 🔧 How to Use

1. **Default Settings:** Without changes, the code works with default settings
2. **Custom Settings:** If needed, configure environment variables in `.env`
3. **Monitoring:** Logs display token estimation

## 📝 Example Log

```
🌐 Filtered 16 translation file(s) BEFORE reading - keeping only 1 sample per category (front/back)
🚫 Excluded 1 auto-generated/build file(s)
📊 Estimated token usage: ~125000 tokens
📋 Selected 10 files for processing (skipped 6 files)
⚠️ Estimated tokens (175000) is within safe limit (180000)
```

## 🚨 Important Notes

1. **Translation Files:** Only one sample per category (front/back) is processed. Others need to be updated manually
2. **API Hard Limit:** Claude API accepts maximum 200,000 tokens per request. Default settings (180k) are below this limit for safety
3. **Large Commits:** For very large commits (50+ files), reduce `MAX_FILES_TO_PROCESS` to 8 or less
4. **Auto-generated Files:** Files in `/generated/` and `*.generated.ts` are automatically excluded

## 🔄 Future Improvements

- [ ] Batch processing for very large commits
- [ ] More accurate tokenizer for token estimation
- [ ] Caching results for similar files
- [ ] Support for binary files

---

**Created:** 2025-12-10  
**Last Updated:** 2025-12-10  
**Version:** 2.0.0

