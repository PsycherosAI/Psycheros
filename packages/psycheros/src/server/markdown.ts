import { marked } from "marked";
import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";

// Create a DOM for DOMPurify to work with
const jsdom = new JSDOM("");
const purify = DOMPurify(jsdom.window);

// Configure marked for Deno-compatible settings
marked.setOptions({
  breaks: false, // Use standard markdown line break rules
  gfm: true, // GitHub Flavored Markdown
});

/**
 * Strip XML tags emitted by the LLM that shouldn't be displayed.
 * Removes <t>timestamp</t> tags entirely, and strips non-HTML XML wrappers.
 */
function stripEntityXml(text: string): string {
  const htmlTags = new Set([
    "a",
    "b",
    "i",
    "u",
    "p",
    "br",
    "hr",
    "em",
    "ol",
    "ul",
    "li",
    "td",
    "th",
    "tr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "pre",
    "code",
    "del",
    "sub",
    "sup",
    "img",
    "div",
    "span",
    "strong",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "blockquote",
    "caption",
    "details",
    "summary",
    "section",
    "article",
    "header",
    "footer",
  ]);
  let result = text;
  // Remove <t>...</t> timestamp tags entirely (tag + content)
  result = result.replace(/<t>[^<]*<\/t>\s*/g, "");
  // Remove other non-HTML XML tags (preserve inner content)
  result = result.replace(/<\/?([a-z_][a-z0-9_-]*)\b[^>]*>/gi, (match, tag) => {
    return htmlTags.has(tag.toLowerCase()) ? match : "";
  });
  // Collapse excessive whitespace left by removals
  result = result.replace(/[ \t]{3,}/g, " ");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result;
}

/**
 * Parse markdown to sanitized HTML.
 * Strips LLM XML artifacts first, then uses DOMPurify to prevent XSS.
 *
 * @param text - Raw markdown text
 * @returns Sanitized HTML string
 */
export function renderMarkdown(text: string): string {
  if (!text) return "";
  const cleaned = stripEntityXml(text);
  if (!cleaned.trim()) return "";
  const html = marked.parse(cleaned) as string;
  return purify.sanitize(html);
}
