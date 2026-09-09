// Plane REST API v1 client (server-side only — it carries the API key).
//
// Works against Plane Cloud (https://api.plane.so) and against a self-hosted
// instance at any URL; `/api/v1` is appended to whatever root is configured.
// Auth is the `X-API-Key` header from Profile settings -> Personal access
// tokens. The API allows 60 requests per minute per key, so callers should
// cache the slow-moving lookups (states, labels, members).

const CLOUD_API_URL = "https://api.plane.so";
const CLOUD_WEB_URL = "https://app.plane.so";

export interface PlaneConfig {
  apiKey: string;
  /** Server root, e.g. https://api.plane.so or https://plane.example.com */
  rootUrl: string;
  workspace: string;
  /** Where the web UI lives, for permalinks. */
  webUrl: string;
}

export interface PlaneProject {
  id: string;
  name: string;
  identifier: string;
}

export interface PlaneState {
  id: string;
  name: string;
  color: string;
  /** backlog | unstarted | started | completed | cancelled */
  group: string;
  sequence: number;
}

export interface PlaneNamed {
  id: string;
  name: string;
  color: string | null;
}

export interface PlaneMember {
  id: string;
  name: string;
}

export interface PlaneWorkItem {
  id: string;
  name: string;
  sequenceId: number;
  priority: string;
  stateId: string | null;
  assigneeIds: string[];
  labelIds: string[];
  startDate: string | null;
  targetDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** One work item with the fields the preview shows and the list omits. */
export interface PlaneWorkItemDetail extends PlaneWorkItem {
  /** The description as plain text; Plane stores it as HTML. */
  description: string;
}

export interface PlaneComment {
  id: string;
  actorId: string | null;
  createdAt: string | null;
  text: string;
  isInternal: boolean;
}

/** A Plane error a handler can turn into a message instead of a stack trace. */
export class PlaneError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PlaneError";
  }
}

/**
 * Normalize the configured server root, defaulting to Plane Cloud. Plane Cloud
 * serves the API from api.plane.so and the UI from app.plane.so; a self-hosted
 * instance usually serves both from one host, so the root is the better guess
 * there unless the operator says otherwise.
 */
export function resolveUrls(rootUrlSetting: string, webUrlSetting: string) {
  const rootUrl = (rootUrlSetting.trim() || CLOUD_API_URL).replace(/\/+$/, "");
  const explicitWeb = webUrlSetting.trim().replace(/\/+$/, "");
  if (explicitWeb !== "") return { rootUrl, webUrl: explicitWeb };
  let host = "";
  try {
    host = new URL(rootUrl).hostname;
  } catch {
    // A malformed root is reported by the first request; fall through.
  }
  return { rootUrl, webUrl: host === "api.plane.so" ? CLOUD_WEB_URL : rootUrl };
}

/**
 * Call the API. Paths are relative to /api/v1 and must end with a slash: Plane
 * redirects slashless paths and drops the method on the way.
 */
async function request(
  config: PlaneConfig,
  path: string,
  options: {
    method?: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<unknown> {
  const { method = "GET", query, body, signal } = options;
  const url = new URL(`${config.rootUrl}/api/v1${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { "X-API-Key": config.apiKey };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new PlaneError(`Could not reach ${url.origin}: ${detail}`, 0);
  }

  if (response.status === 429) {
    const reset = response.headers.get("X-RateLimit-Reset");
    const wait =
      reset === null
        ? null
        : Math.max(0, Number(reset) - Math.floor(Date.now() / 1000));
    throw new PlaneError(
      `Rate limited by Plane (60 requests/minute per key)${wait === null ? "" : `; retry in ~${wait}s`}.`,
      429,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new PlaneError(
      "Plane rejected the API key. Check the key and that it can read this workspace.",
      response.status,
    );
  }
  if (!response.ok) {
    const text = await response.text();
    throw new PlaneError(
      `Plane returned ${response.status} for ${method} ${url.pathname}: ${text.slice(0, 300)}`,
      response.status,
    );
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text === "" ? null : JSON.parse(text);
}

/**
 * Follow Plane's cursor pagination until `limit` results are collected.
 * Endpoints that answer with a bare array are passed through unchanged.
 */
async function paginate(
  config: PlaneConfig,
  path: string,
  options: {
    query?: Record<string, string | number | undefined>;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Record<string, unknown>[]> {
  const { query = {}, limit = 100, signal } = options;
  const results: Record<string, unknown>[] = [];
  let cursor: string | undefined;

  while (results.length < limit) {
    const perPage = Math.min(100, limit - results.length);
    const page = (await request(config, path, {
      query: { ...query, per_page: perPage, cursor },
      signal,
    })) as
      | Record<string, unknown>[]
      | {
          results?: Record<string, unknown>[];
          next_cursor?: string;
          next_page_results?: boolean;
        }
      | null;

    if (Array.isArray(page)) return page.slice(0, limit);
    if (page === null) break;

    results.push(...(page.results ?? []));
    if (page.next_page_results !== true || page.next_cursor === undefined) break;
    cursor = page.next_cursor;
  }

  return results.slice(0, limit);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function workspacePath(config: PlaneConfig): string {
  return `/workspaces/${encodeURIComponent(config.workspace)}`;
}

function projectPath(config: PlaneConfig, projectId: string): string {
  return `${workspacePath(config)}/projects/${encodeURIComponent(projectId)}`;
}

export async function listProjects(
  config: PlaneConfig,
  signal?: AbortSignal,
): Promise<PlaneProject[]> {
  const rows = await paginate(config, `${workspacePath(config)}/projects/`, {
    limit: 200,
    signal,
  });
  return rows.map((row) => ({
    id: text(row.id),
    name: text(row.name),
    identifier: text(row.identifier),
  }));
}

export async function getProject(
  config: PlaneConfig,
  projectId: string,
  signal?: AbortSignal,
): Promise<PlaneProject> {
  const row = (await request(config, `${projectPath(config, projectId)}/`, {
    signal,
  })) as Record<string, unknown>;
  return {
    id: text(row.id),
    name: text(row.name),
    identifier: text(row.identifier),
  };
}

export async function listStates(
  config: PlaneConfig,
  projectId: string,
  signal?: AbortSignal,
): Promise<PlaneState[]> {
  const rows = await paginate(config, `${projectPath(config, projectId)}/states/`, {
    limit: 100,
    signal,
  });
  return rows.map((row) => ({
    id: text(row.id),
    name: text(row.name),
    color: text(row.color),
    group: text(row.group),
    sequence: typeof row.sequence === "number" ? row.sequence : 0,
  }));
}

export async function listLabels(
  config: PlaneConfig,
  projectId: string,
  signal?: AbortSignal,
): Promise<PlaneNamed[]> {
  const rows = await paginate(config, `${projectPath(config, projectId)}/labels/`, {
    limit: 200,
    signal,
  });
  return rows.map((row) => ({
    id: text(row.id),
    name: text(row.name),
    color: text(row.color) === "" ? null : text(row.color),
  }));
}

/**
 * Project members, for showing assignee names on cards. Listing members needs a
 * wider token scope than reading work items does, so callers treat a failure
 * here as "no names available" rather than a broken board.
 */
export async function listMembers(
  config: PlaneConfig,
  projectId: string,
  signal?: AbortSignal,
): Promise<PlaneMember[]> {
  const rows = await paginate(
    config,
    `${projectPath(config, projectId)}/project-members/`,
    { limit: 200, signal },
  );
  return rows.map((row) => {
    const member = (row.member ?? row) as Record<string, unknown>;
    return {
      id: text(member.id) || text(row.member_id) || text(row.id),
      name:
        text(member.display_name) ||
        text(member.email) ||
        text(member.first_name) ||
        text(member.id),
    };
  });
}

function nullableText(value: unknown): string | null {
  const parsed = text(value);
  return parsed === "" ? null : parsed;
}

function toWorkItem(row: Record<string, unknown>): PlaneWorkItem {
  return {
    id: text(row.id),
    name: text(row.name),
    sequenceId: typeof row.sequence_id === "number" ? row.sequence_id : 0,
    priority: text(row.priority) || "none",
    stateId: nullableText(row.state),
    assigneeIds: stringList(row.assignees),
    labelIds: stringList(row.labels),
    startDate: nullableText(row.start_date),
    targetDate: nullableText(row.target_date),
    createdAt: nullableText(row.created_at),
    updatedAt: nullableText(row.updated_at),
  };
}

/**
 * Strip Plane's stored HTML down to readable plain text. Descriptions and
 * comments are rendered as text rather than markup, so nothing from Plane is
 * ever injected into the BB frontend as HTML.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plane serves a stripped copy of the description; fall back to the HTML. */
function toPlainText(row: Record<string, unknown>, htmlKey: string, strippedKey: string): string {
  const stripped = text(row[strippedKey]).trim();
  return stripped === "" ? htmlToText(text(row[htmlKey])) : stripped;
}

export async function listWorkItems(
  config: PlaneConfig,
  projectId: string,
  limit: number,
  signal?: AbortSignal,
): Promise<PlaneWorkItem[]> {
  const rows = await paginate(config, `${projectPath(config, projectId)}/work-items/`, {
    query: { order_by: "-updated_at" },
    limit,
    signal,
  });
  return rows.map(toWorkItem);
}

/** One work item in full. The list endpoint omits the description. */
export async function getWorkItem(
  config: PlaneConfig,
  projectId: string,
  workItemId: string,
  signal?: AbortSignal,
): Promise<PlaneWorkItemDetail> {
  const row = (await request(
    config,
    `${projectPath(config, projectId)}/work-items/${encodeURIComponent(workItemId)}/`,
    { signal },
  )) as Record<string, unknown>;
  return {
    ...toWorkItem(row),
    description: toPlainText(row, "description_html", "description_stripped"),
  };
}

export async function listComments(
  config: PlaneConfig,
  projectId: string,
  workItemId: string,
  signal?: AbortSignal,
): Promise<PlaneComment[]> {
  const rows = await paginate(
    config,
    `${projectPath(config, projectId)}/work-items/${encodeURIComponent(workItemId)}/comments/`,
    { limit: 100, signal },
  );
  return rows.map((row) => ({
    id: text(row.id),
    actorId: nullableText(row.actor),
    createdAt: nullableText(row.created_at),
    text: toPlainText(row, "comment_html", "comment_stripped"),
    isInternal: text(row.access).toUpperCase() === "INTERNAL",
  }));
}

export async function updateWorkItem(
  config: PlaneConfig,
  projectId: string,
  workItemId: string,
  patch: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<PlaneWorkItem> {
  const row = (await request(
    config,
    `${projectPath(config, projectId)}/work-items/${encodeURIComponent(workItemId)}/`,
    { method: "PATCH", body: patch, signal },
  )) as Record<string, unknown>;
  return toWorkItem(row);
}

export async function createWorkItem(
  config: PlaneConfig,
  projectId: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<PlaneWorkItem> {
  const row = (await request(config, `${projectPath(config, projectId)}/work-items/`, {
    method: "POST",
    body,
    signal,
  })) as Record<string, unknown>;
  return toWorkItem(row);
}

/**
 * Web permalink for a work item. The UI still uses /issues/ paths even though
 * the API moved to /work-items/.
 */
export function workItemUrl(
  config: PlaneConfig,
  projectId: string,
  workItemId: string,
): string {
  return `${config.webUrl}/${config.workspace}/projects/${projectId}/issues/${workItemId}`;
}
