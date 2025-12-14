import "dotenv/config";
import { createOrchestrator } from "./orchestrator.js";
import logger from "./logger.js";
import { BaseError } from "./errors.js";

/**
 * Main application entry point
 * Uses the refactored orchestrator to coordinate all services
 */
async function main() {
  try {
    logger.info("Starting repository synchronization process");
    
    // Create and run the orchestrator
    const orchestrator = createOrchestrator();
    const result = await orchestrator.run();
    
    // Exit with appropriate code
    process.exit(result.success ? 0 : 1);
  } catch (err) {
    // Handle errors appropriately
    if (err instanceof BaseError) {
      logger.error("Application error", {
        name: err.name,
        message: err.message,
        code: err.code,
        details: err.details,
      });
    } else {
      logger.error("Unexpected error", {
        error: err.message,
        stack: err.stack,
      });
    }
    
    // Exit with error code
    process.exit(1);
  }
}

// Run the main function
main();
