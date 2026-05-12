/**
 * Shell Tool Implementation
 *
 * Provides shell command execution capability for the entity.
 * Uses Deno.Command for secure subprocess management.
 */

import type { ToolResult } from "../types.ts";
import type { ShellToolArgs, Tool, ToolContext } from "./types.ts";

/** Default timeout for shell commands in milliseconds */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Type guard for validating command argument.
 */
function isValidCommand(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Type guard for optional string argument.
 */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * Type guard for optional positive number argument.
 */
function isOptionalPositiveNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && value > 0);
}

/**
 * Parse and validate shell tool arguments.
 *
 * @param args - Raw arguments from the tool call
 * @returns Validated ShellToolArgs
 * @throws Error if required arguments are missing or invalid
 */
function parseArgs(args: Record<string, unknown>): ShellToolArgs {
  const { command, workingDir, timeout } = args;

  if (!isValidCommand(command)) {
    throw new Error("Shell tool requires a non-empty 'command' argument");
  }

  if (!isOptionalString(workingDir)) {
    throw new Error("'workingDir' must be a string if provided");
  }

  if (!isOptionalPositiveNumber(timeout)) {
    throw new Error("'timeout' must be a positive number if provided");
  }

  // Type guards have narrowed these types - no assertions needed
  return {
    command: command.trim(),
    workingDir,
    timeout,
  };
}

/**
 * Execute a shell command and capture its output.
 *
 * @param args - The validated shell tool arguments
 * @param toolCallId - The ID of the tool call for result tracking
 * @returns ToolResult with command output
 */
async function executeCommand(
  args: ShellToolArgs,
  toolCallId: string,
): Promise<ToolResult> {
  const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS;

  // Use shell to execute the command (allows pipes, redirects, etc.)
  const command = new Deno.Command("sh", {
    args: ["-c", args.command],
    cwd: args.workingDir,
    stdout: "piped",
    stderr: "piped",
  });

  // Create abort controller for timeout
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    // Spawn the process
    const process = command.spawn();

    // Race between process completion and timeout
    const result = await Promise.race([
      process.output(),
      new Promise<never>((_, reject) => {
        abortController.signal.addEventListener("abort", () => {
          process.kill("SIGTERM");
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, { once: true });
      }),
    ]);

    clearTimeout(timeoutId);

    // Decode output
    const decoder = new TextDecoder();
    const stdout = decoder.decode(result.stdout);
    const stderr = decoder.decode(result.stderr);

    // Build result content
    const parts: string[] = [];

    if (stdout.length > 0) {
      parts.push(stdout);
    }

    if (stderr.length > 0) {
      parts.push(`[stderr]\n${stderr}`);
    }

    if (result.code !== 0) {
      parts.push(`[exit code: ${result.code}]`);
    }

    const content = parts.length > 0 ? parts.join("\n") : "(no output)";

    return {
      toolCallId,
      content,
      isError: result.code !== 0,
    };
  } catch (error) {
    clearTimeout(timeoutId);

    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      toolCallId,
      content: `Error executing command: ${errorMessage}`,
      isError: true,
    };
  }
}

/**
 * The shell tool enables executing shell commands.
 *
 * Features:
 * - Executes commands via sh -c for full shell functionality
 * - Captures both stdout and stderr
 * - Handles non-zero exit codes gracefully
 * - Supports configurable timeout (default 30s)
 * - Supports custom working directory
 */
export const shellTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "shell",
      description:
        "Execute a shell command and return the output. I use this to run any command-line operation including file operations, git commands, build tools, and more.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          workingDir: {
            type: "string",
            description: "Optional working directory for the command",
          },
          timeout: {
            type: "number",
            description:
              "Optional timeout in milliseconds (default: 30000). Commands exceeding this will be terminated.",
          },
        },
        required: ["command"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    try {
      const parsedArgs = parseArgs(args);
      return await executeCommand(parsedArgs, ctx.toolCallId);
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      return {
        toolCallId: ctx.toolCallId,
        content: `Error: ${errorMessage}`,
        isError: true,
      };
    }
  },
};
