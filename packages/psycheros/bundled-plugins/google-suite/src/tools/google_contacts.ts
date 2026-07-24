/**
 * google_contacts omni-tool — all Contacts operations in one tool.
 *
 * Action parameter selects the operation; per-action args vary. Replaces the
 * five-tool split (list_contacts / read_contact / create_contact /
 * update_contact / delete_contact) for consistency with the rest of the
 * google-suite plugin (one tool per service).
 *
 * Contacts has no prompt hook — contact list doesn't change turn-to-turn.
 * Entity queries on demand.
 *
 * Deletion is permanent (no trash, unlike Gmail/Drive). Update is REPLACE
 * not MERGE for array fields. Both warnings are surfaced in the description.
 */

import type { Tool } from "../../../../src/tools/types.ts";
import { getGoogleClient } from "../plugin-state.ts";
import {
  type Contact,
  createContact,
  deleteContact,
  displayName,
  getContact,
  GoogleApiError,
  listContacts,
  primaryEmail,
  primaryOrganization,
  primaryPhone,
  updateContact,
} from "../services/contacts.ts";

interface ContactsArgs {
  action?: "list" | "read" | "create" | "update" | "delete";
  // list args
  max_results?: number;
  page_token?: string;
  sort_order?: "LAST_NAME_ASCENDING" | "FIRST_NAME_ASCENDING";
  // read / update / delete args
  resource_name?: string;
  // create / update args
  given_name?: string;
  family_name?: string;
  email_addresses?: Array<{ value: string; type?: string }>;
  phone_numbers?: Array<{ value: string; type?: string }>;
  organizations?: Array<{ name?: string; title?: string; department?: string }>;
  biography?: string;
}

const MAX_LIST_RESULTS_CAP = 1000;
const DEFAULT_LIST_RESULTS = 50;

export const googleContactsTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "google_contacts",
      description:
        "Manage my user's Google Contacts. Pass `action`: 'list' (paginated " +
        "contacts), 'read' (full details by resourceName), 'create' (new " +
        "contact), 'update' (patch fields — arrays REPLACE not merge), " +
        "'delete' (PERMANENT — no trash). I use this to look up contact info, " +
        "add people, or update details when the user asks.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "read", "create", "update", "delete"],
            description: "Operation to perform.",
          },
          max_results: {
            type: "integer",
            description:
              `list: page size. Default ${DEFAULT_LIST_RESULTS}, max ${MAX_LIST_RESULTS_CAP}.`,
          },
          page_token: {
            type: "string",
            description: "list: nextPageToken from a prior response.",
          },
          sort_order: {
            type: "string",
            enum: ["LAST_NAME_ASCENDING", "FIRST_NAME_ASCENDING"],
            description: "list: sort order.",
          },
          resource_name: {
            type: "string",
            description:
              "read/update/delete: contact resourceName (e.g. 'people/c123') — from list result.",
          },
          given_name: {
            type: "string",
            description: "create/update: first name.",
          },
          family_name: {
            type: "string",
            description: "create/update: last name.",
          },
          email_addresses: {
            type: "array",
            description:
              "create/update: emails. First becomes primary. On update, REPLACES existing.",
            items: {
              type: "object",
              properties: {
                value: { type: "string" },
                type: {
                  type: "string",
                  description: "'work' | 'home' | 'mobile' | 'other'.",
                },
              },
              required: ["value"],
            },
          },
          phone_numbers: {
            type: "array",
            description:
              "create/update: phones. First becomes primary. On update, REPLACES existing.",
            items: {
              type: "object",
              properties: {
                value: { type: "string" },
                type: { type: "string" },
              },
              required: ["value"],
            },
          },
          organizations: {
            type: "array",
            description:
              "create/update: org affiliations. On update, REPLACES existing.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                title: { type: "string" },
                department: { type: "string" },
              },
            },
          },
          biography: {
            type: "string",
            description: "create/update: free-text notes.",
          },
        },
        required: ["action"],
      },
    },
  },

  async execute(args, ctx) {
    const client = getGoogleClient();
    if (!client?.isConfigured()) {
      return notConnectedResult(ctx.toolCallId);
    }
    const parsed = args as ContactsArgs;
    switch (parsed.action) {
      case "list":
        return doList(parsed, ctx.toolCallId);
      case "read":
        return doRead(parsed, ctx.toolCallId);
      case "create":
        return doCreate(parsed, ctx.toolCallId);
      case "update":
        return doUpdate(parsed, ctx.toolCallId);
      case "delete":
        return doDelete(parsed, ctx.toolCallId);
      default:
        return {
          toolCallId: ctx.toolCallId,
          content: `Missing or invalid action "${
            parsed.action ?? "(missing)"
          }". Use one of: list, read, create, update, delete.`,
          isError: true,
        };
    }
  },
};

async function doList(args: ContactsArgs, toolCallId: string) {
  const client = getGoogleClient()!;
  try {
    const result = await listContacts(client, {
      maxResults: args.max_results,
      pageToken: args.page_token,
      sortOrder: args.sort_order,
    });
    if (result.contacts.length === 0) {
      return {
        toolCallId,
        content: "No contacts found. Use action='create' to add one.",
      };
    }
    const lines = result.contacts.map(formatContactLine);
    const more = result.nextPageToken
      ? "\n\nMore contacts available — pass page_token to fetch the next page."
      : "";
    return {
      toolCallId,
      content: `Found ${result.contacts.length} contact(s):\n${
        lines.join("\n")
      }${more}`,
    };
  } catch (error) {
    return errorResult(toolCallId, "list contacts", error);
  }
}

async function doRead(args: ContactsArgs, toolCallId: string) {
  if (!args.resource_name?.trim()) {
    return missingField(toolCallId, "resource_name");
  }
  const client = getGoogleClient()!;
  try {
    const contact = await getContact(client, args.resource_name);
    return {
      toolCallId,
      content: formatFullContact(contact),
    };
  } catch (error) {
    return errorResult(toolCallId, "read contact", error);
  }
}

async function doCreate(args: ContactsArgs, toolCallId: string) {
  const hasAny = args.given_name || args.family_name ||
    (args.email_addresses && args.email_addresses.length > 0) ||
    (args.phone_numbers && args.phone_numbers.length > 0) ||
    args.biography ||
    (args.organizations && args.organizations.length > 0);
  if (!hasAny) {
    return {
      toolCallId,
      content:
        "Empty contact — provide at least a name, email, phone, organization, or biography.",
      isError: true,
    };
  }
  const client = getGoogleClient()!;
  try {
    const created = await createContact(client, {
      givenName: args.given_name,
      familyName: args.family_name,
      emailAddresses: args.email_addresses,
      phoneNumbers: args.phone_numbers,
      organizations: args.organizations,
      biography: args.biography,
    });
    const name = displayName(created) ?? "(unnamed)";
    const email = primaryEmail(created);
    const emailLine = email ? `, email: ${email}` : "";
    return {
      toolCallId,
      content:
        `Created contact "${name}" (resource: ${created.resourceName}${emailLine}).`,
    };
  } catch (error) {
    return errorResult(toolCallId, "create contact", error);
  }
}

async function doUpdate(args: ContactsArgs, toolCallId: string) {
  if (!args.resource_name?.trim()) {
    return missingField(toolCallId, "resource_name");
  }
  const client = getGoogleClient()!;
  try {
    const updated = await updateContact(client, args.resource_name, {
      givenName: args.given_name,
      familyName: args.family_name,
      emailAddresses: args.email_addresses,
      phoneNumbers: args.phone_numbers,
      organizations: args.organizations,
      biography: args.biography,
    });
    const name = displayName(updated) ?? "(unnamed)";
    return {
      toolCallId,
      content: `Updated contact "${name}" (${updated.resourceName}).`,
    };
  } catch (error) {
    return errorResult(toolCallId, "update contact", error);
  }
}

async function doDelete(args: ContactsArgs, toolCallId: string) {
  if (!args.resource_name?.trim()) {
    return missingField(toolCallId, "resource_name");
  }
  const client = getGoogleClient()!;
  try {
    await deleteContact(client, args.resource_name);
    return {
      toolCallId,
      content: `Deleted contact ${args.resource_name}.`,
    };
  } catch (error) {
    return errorResult(toolCallId, "delete contact", error);
  }
}

function formatContactLine(contact: Contact): string {
  const name = displayName(contact) ?? "(unnamed)";
  const email = primaryEmail(contact);
  const phone = primaryPhone(contact);
  const org = primaryOrganization(contact);
  const parts = [`  - ${name} (${contact.resourceName})`];
  if (email) parts.push(`    email: ${email}`);
  if (phone) parts.push(`    phone: ${phone}`);
  if (org) {
    const orgParts = [org.name, org.title].filter(Boolean).join(" / ");
    if (orgParts) parts.push(`    org: ${orgParts}`);
  }
  return parts.join("\n");
}

function formatFullContact(contact: Contact): string {
  const lines: string[] = [];
  const primaryName = contact.names?.find((n) => n.metadata?.primary) ??
    contact.names?.[0];
  if (primaryName) {
    lines.push(`Name: ${primaryName.displayName ?? "(no display name)"}`);
  }
  if (contact.emailAddresses && contact.emailAddresses.length > 0) {
    lines.push(`Emails (${contact.emailAddresses.length}):`);
    for (const e of contact.emailAddresses) {
      const primary = e.metadata?.primary ? " (primary)" : "";
      const type = e.type ? ` [${e.type}]` : "";
      lines.push(`  - ${e.value}${type}${primary}`);
    }
  }
  if (contact.phoneNumbers && contact.phoneNumbers.length > 0) {
    lines.push(`Phones (${contact.phoneNumbers.length}):`);
    for (const p of contact.phoneNumbers) {
      const primary = p.metadata?.primary ? " (primary)" : "";
      const type = p.type ? ` [${p.type}]` : "";
      lines.push(`  - ${p.value}${type}${primary}`);
    }
  }
  if (contact.organizations && contact.organizations.length > 0) {
    lines.push(`Organizations:`);
    for (const o of contact.organizations) {
      const primary = o.metadata?.primary ? " (primary)" : "";
      const parts = [o.name, o.title, o.department].filter(Boolean).join(" / ");
      lines.push(`  - ${parts}${primary}`);
    }
  }
  if (contact.biographies && contact.biographies.length > 0) {
    lines.push(`Notes:`);
    for (const b of contact.biographies) {
      if (b.value) lines.push(`  - ${b.value}`);
    }
  }
  if (lines.length === 0) {
    return `Contact ${contact.resourceName} has no populated fields.`;
  }
  lines.push(`Resource: ${contact.resourceName}`);
  return lines.join("\n");
}

function missingField(toolCallId: string, field: string) {
  return {
    toolCallId,
    content: `Missing required field for this action: ${field}.`,
    isError: true,
  };
}

function notConnectedResult(toolCallId: string) {
  return {
    toolCallId,
    content:
      "Google Suite is not connected. Ask the operator to configure it in Settings → Plugins → Google Suite.",
    isError: true,
  };
}

function errorResult(toolCallId: string, op: string, error: unknown) {
  const message = error instanceof GoogleApiError
    ? `People API error (${error.status}): ${error.message}`
    : error instanceof Error
    ? error.message
    : String(error);
  return {
    toolCallId,
    content: `Failed to ${op}: ${message}`,
    isError: true,
  };
}
