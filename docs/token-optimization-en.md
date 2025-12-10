# Token Optimization

## 📋 Summary

This documentation explains the changes made to prevent **Rate Limit** (429) errors in the Claude API. The main issue was that requests were consuming more than the allowed limit of 450,000 tokens per minute.

## 🔍 Main Problem

When many files were changed (e.g., 32 files), all file contents along with the diff were sent to Claude, which caused:
- Token count to exceed the allowed limit (450k/min)
- `429 Rate Limit Error` to occur
- Commit processing to stop

## ✅ Implemented Solutions

### 1. File Size Limiting

**Problem:** Large files (like translation JSON files) can consume thousands of tokens.

**Solution:**
- Files larger than 50KB are automatically truncated
- Translation files (`/lang/*.json`) only send the first 5000 characters
- Truncation happens at a reasonable point (e.g., last complete line)

**Code:**
```javascript
const MAX_FILE_SIZE = 50000; // 50KB default
const truncateContent = (content, maxSize) => {
    if (content.length <= maxSize) return content;
    // Truncate at reasonable point (newline)
    // ...
}
```

### 2. Smart File Filtering

**Problem:** Processing all files even if they're unnecessary.

**Solution:**
- If more than 20 files have changed, only the most important ones are processed
- Prioritization:
  1. **High Priority:** Code files (`.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.graphql`)
  2. **Medium Priority:** Configuration files and other files
  3. **Low Priority:** Translation files (`/lang/*.json`)

**Code:**
```javascript
const MAX_FILES_TO_PROCESS = 20; // Default
const filterAndPrioritizeFiles = (filesFromA, filesFromB, diffText) => {
    // Prioritize source code files over translation files
    // ...
}
```

### 3. Token Estimation & Limiting

**Problem:** We didn't know how many tokens would be consumed before sending.

**Solution:**
- Token count is estimated before sending
- Maximum 400,000 tokens per request (below 450k limit for safety)
- Warning is displayed if estimate exceeds the limit

**Code:**
```javascript
const MAX_TOKENS_PER_REQUEST = 400000; // Safe limit below 450k
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

### 5. Filtering Unnecessary Files

**Problem:** Build files, node_modules, etc. were also being processed.

**Solution:**
- Files in `node_modules/`, `dist/`, `build/`, and `.git/` are filtered
- Translation files are handled specially

**Code:**
```javascript
const shouldFilterFile = (filePath, content) => {
    if (filePath.includes('node_modules/') || 
        filePath.includes('dist/') || 
        filePath.includes('build/') ||
        filePath.includes('.git/')) {
        return true;
    }
    // ...
}
```

## ⚙️ Configurable Settings

All these limits are configurable through environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_TOKENS_PER_REQUEST` | 400000 | Maximum tokens per request |
| `MAX_FILE_SIZE` | 50000 | Maximum file size (characters) |
| `MAX_FILES_TO_PROCESS` | 20 | Maximum number of files per request |
| `RETRY_MAX_ATTEMPTS` | 3 | Number of retry attempts |
| `RETRY_BASE_DELAY_MS` | 60000 | Base delay for retry (milliseconds) |

### Example Settings in `.env`:

```bash
# For large commits, reduce the number of files
MAX_FILES_TO_PROCESS=15

# If you still get errors, reduce tokens further
MAX_TOKENS_PER_REQUEST=350000

# For smaller files, reduce the size
MAX_FILE_SIZE=30000
```

## 📊 Results

After applying these changes:

✅ **Large files are automatically truncated**
- Translation files only send a small sample
- Files larger than 50KB are truncated

✅ **Automatic retry on rate limit errors**
- Smart delay with exponential backoff
- Uses `retry-after` header from API

✅ **Only the most important files are processed**
- Priority given to code files
- Translation files have low priority

✅ **Token count is controlled before sending**
- Accurate estimation before sending
- Warning if approaching the limit

## 🔧 How to Use

1. **Default Settings:** Without changes, the code works with default settings
2. **Custom Settings:** If needed, configure environment variables in `.env`
3. **Monitoring:** Logs display token estimation

## 📝 Example Log

```
📊 Estimated token usage: ~125000 tokens
📋 Selected 20 files for processing (skipped 12 files)
⚠️ Estimated tokens (380000) is within safe limit (400000)
```

## 🚨 Important Notes

1. **Translation Files:** If you have important changes in translation files, you may need to increase `MAX_FILES_TO_PROCESS`
2. **Large Commits:** For very large commits (50+ files), batch processing may be needed
3. **Rate Limit:** If you still get errors, reduce `MAX_TOKENS_PER_REQUEST`

## 🔄 Future Improvements

- [ ] Batch processing for very large commits
- [ ] More accurate tokenizer for token estimation
- [ ] Caching results for similar files
- [ ] Support for binary files

---

**Created:** 2025-12-10  
**Version:** 1.0.0

