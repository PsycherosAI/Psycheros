/**
 * Psycheros Constants
 *
 * Shared configuration constants used across modules.
 *
 * @module
 */

// =============================================================================
// Validation Limits
// =============================================================================

/** Maximum length for conversation titles */
export const MAX_TITLE_LENGTH = 50;

// =============================================================================
// Request Body Limits
// =============================================================================

/** Maximum request body size for JSON/form endpoints (1MB) */
export const MAX_REQUEST_BODY_SIZE = 1 * 1024 * 1024;

/**
 * Maximum request body size for file upload endpoints.
 * Self-hosted software — no artificial cap on user uploads.
 */
export const MAX_UPLOAD_BODY_SIZE = Infinity;

// =============================================================================
// SSE Streaming
// =============================================================================

/** Maximum size for SSE message data in bytes (100KB) */
export const MAX_SSE_MESSAGE_SIZE = 100 * 1024;

/** Truncation message appended when SSE data is truncated */
export const SSE_TRUNCATION_SUFFIX = "\n... [truncated]";
