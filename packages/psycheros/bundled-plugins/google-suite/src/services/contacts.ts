/**
 * Google People API wrapper.
 *
 * Wraps https://people.googleapis.com/v1/. Methods take a GoogleClient and
 * return typed results. Errors throw GoogleApiError (re-exported from
 * calendar.ts).
 *
 * People API shape quirks:
 *   - Most fields (names, emailAddresses, phoneNumbers, organizations) are
 *     ARRAYS of objects, each with a `metadata.primary: boolean` flag.
 *     Callers usually want the primary one — `primaryEmail()`, `primaryPhone()`
 *     helpers extract them.
 *   - Listing requires a `personFields` mask naming which fields to return.
 *     We default to a useful set; callers can override.
 *   - Updates require an `updatePersonFields` mask naming which fields are
 *     being modified. The mask must match what's in the body or the request
 *     silently no-ops.
 *   - `resourceName` (e.g. "people/c123") is the stable ID — use it for
 *     read/update/delete.
 *
 * Scope: `contacts` covers read/write of the user's "myContacts" group. Other
 * contact groups (otherContacts, directory) need additional scopes — out of
 * scope for v1.
 */

import type { GoogleClient } from "../client/google-client.ts";
import { GoogleApiError } from "./calendar.ts";

export { GoogleApiError };

const PEOPLE_API_BASE = "https://people.googleapis.com/v1";

/** Default personFields for list/read — covers the fields tools typically need. */
const DEFAULT_PERSON_FIELDS = [
  "names",
  "emailAddresses",
  "phoneNumbers",
  "organizations",
  "photos",
  "biographies",
  "birthdays",
] as const;
const DEFAULT_PERSON_FIELDS_STR = DEFAULT_PERSON_FIELDS.join(",");

export interface PersonMetadata {
  primary?: boolean;
  source?: { type?: string; id?: string };
}

export interface PersonName {
  displayName?: string;
  familyName?: string;
  givenName?: string;
  middleName?: string;
  honorificPrefix?: string;
  metadata?: PersonMetadata;
}

export interface PersonEmail {
  value: string;
  type?: string;
  displayName?: string;
  metadata?: PersonMetadata;
}

export interface PersonPhone {
  value: string;
  type?: string;
  metadata?: PersonMetadata;
}

export interface PersonOrganization {
  name?: string;
  title?: string;
  department?: string;
  metadata?: PersonMetadata;
}

export interface PersonBirthday {
  date?: { year?: number; month?: number; day?: number };
  metadata?: PersonMetadata;
}

export interface PersonBiography {
  value?: string;
  contentType?: "TEXT_PLAIN" | "TEXT_HTML";
  metadata?: PersonMetadata;
}

export interface PersonPhoto {
  url?: string;
  default?: boolean;
  metadata?: PersonMetadata;
}

export interface Contact {
  resourceName: string;
  names?: PersonName[];
  emailAddresses?: PersonEmail[];
  phoneNumbers?: PersonPhone[];
  organizations?: PersonOrganization[];
  birthdays?: PersonBirthday[];
  biographies?: PersonBiography[];
  photos?: PersonPhoto[];
}

export interface ListContactsOptions {
  /** Required personFields mask. Defaults to a broad set. */
  personFields?: string;
  /** Page token from a prior response. */
  pageToken?: string;
  maxResults?: number;
  /** Order clause, e.g. "LAST_NAME_ASCENDING" or "FIRST_NAME_ASCENDING". */
  sortOrder?: string;
}

export interface ListContactsResult {
  contacts: Contact[];
  nextPageToken?: string;
  totalItems?: number;
}

export interface NewContact {
  givenName?: string;
  familyName?: string;
  emailAddresses?: Array<{ value: string; type?: string }>;
  phoneNumbers?: Array<{ value: string; type?: string }>;
  organizations?: Array<{ name?: string; title?: string; department?: string }>;
  biography?: string;
}

export interface UpdateContactFields {
  givenName?: string;
  familyName?: string;
  emailAddresses?: Array<{ value: string; type?: string }>;
  phoneNumbers?: Array<{ value: string; type?: string }>;
  organizations?: Array<{ name?: string; title?: string; department?: string }>;
  biography?: string;
}

const MAX_LIST_RESULTS_CAP = 1000;
const DEFAULT_LIST_RESULTS = 50;

/**
 * List contacts in the user's "myContacts" group. Sorted alphabetically
 * by default. Returns a subset of fields based on the personFields mask.
 */
export async function listContacts(
  client: GoogleClient,
  opts: ListContactsOptions = {},
): Promise<ListContactsResult> {
  const url = new URL(`${PEOPLE_API_BASE}/people/me/connections`);
  const personFields = opts.personFields ?? DEFAULT_PERSON_FIELDS_STR;
  url.searchParams.set("personFields", personFields);
  const maxResults = opts.maxResults !== undefined
    ? Math.min(Math.max(1, opts.maxResults), MAX_LIST_RESULTS_CAP)
    : DEFAULT_LIST_RESULTS;
  url.searchParams.set("pageSize", String(maxResults));
  if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);
  if (opts.sortOrder) url.searchParams.set("sortOrder", opts.sortOrder);

  const data = await client.fetchJson<{
    connections?: Contact[];
    nextPageToken?: string;
    totalItems?: number;
  }>(url.toString());
  return {
    contacts: data.connections ?? [],
    nextPageToken: data.nextPageToken,
    totalItems: data.totalItems,
  };
}

/**
 * Get a single contact by resourceName. Default personFields returns the
 * broad set; override for narrower responses.
 */
export async function getContact(
  client: GoogleClient,
  resourceName: string,
  opts: { personFields?: string } = {},
): Promise<Contact> {
  const personFields = opts.personFields ?? DEFAULT_PERSON_FIELDS_STR;
  const url = new URL(
    `${PEOPLE_API_BASE}/${encodeURIComponent(resourceName)}?personFields=${
      encodeURIComponent(personFields)
    }`,
  );
  return await client.fetchJson<Contact>(url.toString());
}

/**
 * Create a contact in the user's "myContacts" group. At least one field
 * must be provided (Google rejects empty contacts).
 */
export async function createContact(
  client: GoogleClient,
  contact: NewContact,
): Promise<Contact> {
  const body = serializeNewContact(contact);
  return await client.fetchJson<Contact>(
    `${PEOPLE_API_BASE}/people:createContact?personFields=${DEFAULT_PERSON_FIELDS_STR}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

/**
 * Update an existing contact. Only fields in `updatePersonFields` are
 * modified — others are untouched. The mask MUST match the body or the
 * request silently no-ops.
 */
export async function updateContact(
  client: GoogleClient,
  resourceName: string,
  fields: UpdateContactFields,
): Promise<Contact> {
  const { body, mask } = serializeUpdate(fields);
  if (!mask) {
    throw new GoogleApiError(
      "updateContact requires at least one field to update",
      400,
    );
  }
  const url = new URL(
    `${PEOPLE_API_BASE}/${encodeURIComponent(resourceName)}:updateContact`,
  );
  url.searchParams.set("updatePersonFields", mask);
  url.searchParams.set("personFields", DEFAULT_PERSON_FIELDS_STR);
  return await client.fetchJson<Contact>(url.toString(), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Delete a contact permanently. There's no "trash" — deletion is
 * irreversible (unlike Gmail/Drive).
 */
export async function deleteContact(
  client: GoogleClient,
  resourceName: string,
): Promise<void> {
  const response = await client.fetch(
    `${PEOPLE_API_BASE}/${encodeURIComponent(resourceName)}:deleteContact`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 204) {
    const body = await response.text();
    throw new GoogleApiError(
      `delete ${response.status}: ${body}`,
      response.status,
      body,
    );
  }
}

// ============================================================
// Helpers for extracting primary fields from the array-of-objects shape.
// ============================================================

export function primaryEmail(contact: Contact): string | undefined {
  const primary = contact.emailAddresses?.find((e) => e.metadata?.primary);
  return primary?.value ?? contact.emailAddresses?.[0]?.value;
}

export function primaryPhone(contact: Contact): string | undefined {
  const primary = contact.phoneNumbers?.find((p) => p.metadata?.primary);
  return primary?.value ?? contact.phoneNumbers?.[0]?.value;
}

export function primaryOrganization(
  contact: Contact,
): PersonOrganization | undefined {
  const primary = contact.organizations?.find((o) => o.metadata?.primary);
  return primary ?? contact.organizations?.[0];
}

export function displayName(contact: Contact): string | undefined {
  const primary = contact.names?.find((n) => n.metadata?.primary);
  return primary?.displayName ?? contact.names?.[0]?.displayName;
}

function serializeNewContact(c: NewContact): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (c.givenName || c.familyName) {
    body.names = [{
      givenName: c.givenName,
      familyName: c.familyName,
      displayName: [c.givenName, c.familyName].filter(Boolean).join(" "),
    }];
  }
  if (c.emailAddresses && c.emailAddresses.length > 0) {
    const emails = c.emailAddresses.map((e) => ({
      value: e.value,
      type: e.type,
      metadata: { primary: false },
    }));
    emails[0].metadata = { primary: true };
    body.emailAddresses = emails;
  }
  if (c.phoneNumbers && c.phoneNumbers.length > 0) {
    const phones = c.phoneNumbers.map((p) => ({
      value: p.value,
      type: p.type,
      metadata: { primary: false },
    }));
    phones[0].metadata = { primary: true };
    body.phoneNumbers = phones;
  }
  if (c.organizations && c.organizations.length > 0) {
    const orgs = c.organizations.map((o) => ({
      name: o.name,
      title: o.title,
      department: o.department,
      metadata: { primary: false },
    }));
    orgs[0].metadata = { primary: true };
    body.organizations = orgs;
  }
  if (c.biography) {
    body.biographies = [{ value: c.biography, contentType: "TEXT_PLAIN" }];
  }
  return body;
}

function serializeUpdate(
  fields: UpdateContactFields,
): { body: Record<string, unknown>; mask: string } {
  const body: Record<string, unknown> = {};
  const maskParts: string[] = [];

  if (fields.givenName !== undefined || fields.familyName !== undefined) {
    body.names = [{
      givenName: fields.givenName,
      familyName: fields.familyName,
      displayName: [fields.givenName, fields.familyName].filter(Boolean).join(
        " ",
      ),
    }];
    maskParts.push("names");
  }
  if (fields.emailAddresses !== undefined) {
    const emails = fields.emailAddresses.map((e) => ({
      value: e.value,
      type: e.type,
      metadata: { primary: false },
    }));
    if (emails.length > 0) emails[0].metadata = { primary: true };
    body.emailAddresses = emails;
    maskParts.push("emailAddresses");
  }
  if (fields.phoneNumbers !== undefined) {
    const phones = fields.phoneNumbers.map((p) => ({
      value: p.value,
      type: p.type,
      metadata: { primary: false },
    }));
    if (phones.length > 0) phones[0].metadata = { primary: true };
    body.phoneNumbers = phones;
    maskParts.push("phoneNumbers");
  }
  if (fields.organizations !== undefined) {
    const orgs = fields.organizations.map((o) => ({
      name: o.name,
      title: o.title,
      department: o.department,
      metadata: { primary: false },
    }));
    if (orgs.length > 0) orgs[0].metadata = { primary: true };
    body.organizations = orgs;
    maskParts.push("organizations");
  }
  if (fields.biography !== undefined) {
    body.biographies = [{ value: fields.biography, contentType: "TEXT_PLAIN" }];
    maskParts.push("biographies");
  }

  return { body, mask: maskParts.join(",") };
}
