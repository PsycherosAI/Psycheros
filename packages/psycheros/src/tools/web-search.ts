/**
 * Web Search Tool Implementation
 *
 * Provides web search capability using Tavily or Brave Search APIs.
 * The provider and API keys are read from WebSearchSettings stored
 * in the EntityConfig.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import type { WebSearchSettings } from "../llm/web-search-settings.ts";

// =============================================================================
// Search Provider Implementations
// =============================================================================

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Search using the Tavily API.
 */
async function searchTavily(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<SearchResult[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tavily API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    results?: Array<{ title: string; url: string; content: string }>;
  };

  return (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

/**
 * Search using the Brave Search API.
 */
async function searchBrave(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(maxResults),
  });

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": apiKey,
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Brave API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    web?: {
      results?: Array<{ title: string; url: string; description: string }>;
    };
  };

  return (data.web?.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
}

// =============================================================================
// Tool Definition
// =============================================================================

/**
 * The web_search tool enables searching the web for current information.
 *
 * Supports two providers:
 * - Tavily: AI-optimized search API
 * - Brave: General web search API
 *
 * The provider and API key are determined by WebSearchSettings
 * stored in the entity configuration.
 */
export const webSearchTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for current information. I use this when I need up-to-date facts, news, or information that may not be in my training data.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to look up",
          },
          max_results: {
            type: "number",
            description: "Maximum number of results to return (default: 5)",
          },
        },
        required: ["query"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const query = args.query;
    if (typeof query !== "string" || query.trim() === "") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: web_search requires a non-empty 'query' argument",
        isError: true,
      };
    }

    const maxResults =
      typeof args.max_results === "number" && args.max_results > 0
        ? Math.min(args.max_results, 10)
        : 5;

    // Read provider config from EntityConfig
    const webSearchSettings = ctx.config.webSearchSettings as
      | WebSearchSettings
      | undefined;
    if (!webSearchSettings) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Error: Web search is not configured. Enable it in Settings > Web Search.",
        isError: true,
      };
    }

    const { provider } = webSearchSettings;

    try {
      let results: SearchResult[];

      switch (provider) {
        case "tavily": {
          const apiKey = webSearchSettings.tavilyApiKey;
          if (!apiKey) {
            return {
              toolCallId: ctx.toolCallId,
              content:
                "Error: Tavily API key not configured. Set TAVILY_API_KEY in Settings > Web Search.",
              isError: true,
            };
          }
          results = await searchTavily(query, maxResults, apiKey);
          break;
        }
        case "brave": {
          const apiKey = webSearchSettings.braveApiKey;
          if (!apiKey) {
            return {
              toolCallId: ctx.toolCallId,
              content:
                "Error: Brave API key not configured. Set BRAVE_SEARCH_API_KEY in Settings > Web Search.",
              isError: true,
            };
          }
          results = await searchBrave(query, maxResults, apiKey);
          break;
        }
        default:
          return {
            toolCallId: ctx.toolCallId,
            content: `Error: Unknown web search provider '${provider}'`,
            isError: true,
          };
      }

      if (results.length === 0) {
        return {
          toolCallId: ctx.toolCallId,
          content: `No results found for "${query}".`,
        };
      }

      // Format results for the LLM
      const formatted = results.map((r, i) =>
        `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`
      ).join("\n\n");

      return {
        toolCallId: ctx.toolCallId,
        content: `Search results for "${query}":\n\n${formatted}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      return {
        toolCallId: ctx.toolCallId,
        content: `Error performing web search: ${errorMessage}`,
        isError: true,
      };
    }
  },
};
