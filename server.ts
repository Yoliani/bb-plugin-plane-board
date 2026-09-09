// bb-plugin-plane-board — backend entry.
//
// Holds the Plane API keys and every call to Plane: the frontend never sees a
// key and never talks to a Plane host directly. app.tsx reaches this over the
// RPC contract below; `bb plane-board` reaches the same helpers from a shell.
//
// One install can hold several Plane connections — a Cloud account and a
// self-hosted instance, say. They are edited in the Accounts panel on the
// plugin's settings page, stored in this plugin's kv, and their API keys are
// held in `secret` settings so they stay in the 0600 secrets file. Because
// secret settings are declared once per load, keys live in a fixed pool of
// slots that accounts claim (see lib/accounts.ts).
import { resolve as resolvePath } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { flagValue, hasFlag, parseArgv } from "./lib/cli-args";
import {
  KEY_SLOTS,
  MAX_ACCOUNTS,
  freeKeySlot,
  uniqueId,
  type StoredAccount,
} from "./lib/accounts";
import {
  createComment,
  createWorkItem,
  fetchAttachment,
  findWorkItemByKey,
  getProject,
  getWorkItem,
  listAttachments,
  listComments,
  listLabels,
  listMembers,
  listProjects,
  listStates,
  listWorkItems,
  parseWorkItemKey,
  resolveUrls,
  searchWorkItems,
  textToHtml,
  updateWorkItem,
  workItemUrl,
  type PlaneAttachment,
  type PlaneConfig,
  type PlaneMember,
  type PlaneNamed,
  type PlaneProject,
  type PlaneState,
} from "./lib/plane";
import {
  renderSeedPrompt,
  renderWorkItem,
  type WorkItemContext,
} from "./lib/work-item-text";

const ACCOUNTS_KEY = "accounts";

/** kv prefix for the BB threads delegated from one work item. */
const THREADS_KEY_PREFIX = "threads:";

/** How many work items the composer's mention menu offers. */
const MENTION_LIMIT = 12;

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  identifier: z.string(),
});

const stateSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  group: z.string(),
  sequence: z.number(),
});

const namedSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});

const memberSchema = z.object({ id: z.string(), name: z.string() });

const workItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  sequenceId: z.number(),
  priority: z.string(),
  stateId: z.string().nullable(),
  assigneeIds: z.array(z.string()),
  labelIds: z.array(z.string()),
  startDate: z.string().nullable(),
  targetDate: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  url: z.string(),
});

const commentSchema = z.object({
  id: z.string(),
  actorId: z.string().nullable(),
  createdAt: z.string().nullable(),
  text: z.string(),
  isInternal: z.boolean(),
});

const attachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().nullable(),
  contentType: z.string(),
  createdAt: z.string().nullable(),
  /** This plugin's own download URL; the browser has no Plane API key. */
  url: z.string(),
});

/** Enough of a work item to name it in a card or a mention row. */
const cardSchema = z.object({
  accountId: z.string(),
  projectId: z.string(),
  itemId: z.string(),
  /** The human key, e.g. "GA-724". */
  key: z.string(),
  name: z.string(),
  url: z.string(),
  priority: z.string(),
  stateName: z.string().nullable(),
  stateColor: z.string().nullable(),
});

/** A BB thread delegated from a work item. */
const linkedThreadSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  /** The thread's live status, or "deleted" when it is gone. */
  status: z.string(),
  createdAt: z.string(),
});

/** A BB project a work item can be delegated into. */
const bbProjectSchema = z.object({ id: z.string(), name: z.string() });

/** One connection as the frontend sees it — never carrying the key itself. */
const accountInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  serverUrl: z.string(),
  workspace: z.string(),
  webUrl: z.string(),
  defaultProject: z.string(),
  /** Whether an API key is stored, not what it is. */
  hasKey: z.boolean(),
  /** True when the account has both a workspace and a key, so it can be used. */
  ready: z.boolean(),
});

/** The editable half of an account. `id` is null when creating one. */
const accountDraftSchema = z
  .object({
    id: z.string().min(1).nullable(),
    label: z.string().trim().min(1).max(64),
    serverUrl: z.string().trim().max(300),
    workspace: z.string().trim().max(120),
    webUrl: z.string().trim().max(300),
    defaultProject: z.string().trim().max(120),
    /** Null leaves a stored key alone; "" clears it. */
    apiKey: z.string().max(500).nullable(),
  })
  .strict();

export type BoardWorkItem = z.infer<typeof workItemSchema>;
export type BoardComment = z.infer<typeof commentSchema>;
export type BoardAttachment = z.infer<typeof attachmentSchema>;
export type BoardCard = z.infer<typeof cardSchema>;
export type BoardLinkedThread = z.infer<typeof linkedThreadSchema>;
export type BoardBbProject = z.infer<typeof bbProjectSchema>;
export type BoardState = z.infer<typeof stateSchema>;
export type BoardLabel = z.infer<typeof namedSchema>;
export type BoardMember = z.infer<typeof memberSchema>;
export type BoardProject = z.infer<typeof projectSchema>;
export type BoardAccount = z.infer<typeof accountInfoSchema>;
export type AccountDraft = z.infer<typeof accountDraftSchema>;

const accountInput = z.object({ accountId: z.string().min(1) });

export const rpcContract = defineRpcContract({
  accounts_list: {
    input: z.null(),
    output: z.object({
      accounts: z.array(accountInfoSchema),
      /** How many more accounts fit; the key-slot pool is fixed. */
      remainingSlots: z.number(),
    }),
  },
  account_save: {
    input: accountDraftSchema,
    output: z.object({ account: accountInfoSchema }),
  },
  account_remove: {
    input: accountInput.strict(),
    output: z.object({ removed: z.boolean() }),
  },
  account_test: {
    input: accountInput.strict(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  projects_list: {
    input: accountInput.strict(),
    output: z.object({ projects: z.array(projectSchema) }),
  },
  board_load: {
    input: accountInput.extend({ projectId: z.string().min(1) }).strict(),
    output: z.object({
      project: projectSchema,
      states: z.array(stateSchema),
      labels: z.array(namedSchema),
      members: z.array(memberSchema),
      items: z.array(workItemSchema),
      truncated: z.boolean(),
    }),
  },
  item_detail: {
    input: accountInput
      .extend({ projectId: z.string().min(1), itemId: z.string().min(1) })
      .strict(),
    output: z.object({
      item: workItemSchema,
      description: z.string(),
      comments: z.array(commentSchema),
      commentsAvailable: z.boolean(),
      attachments: z.array(attachmentSchema),
      attachmentsAvailable: z.boolean(),
    }),
  },
  /** Resolve "GA-724" to a card. Used by the ::plane message directive. */
  item_by_key: {
    input: z.object({ key: z.string().min(1) }).strict(),
    output: z.object({ card: cardSchema.nullable() }),
  },
  /** BB projects a work item can be delegated into. */
  bb_projects: {
    input: z.null(),
    output: z.object({ projects: z.array(bbProjectSchema) }),
  },
  item_delegate: {
    input: accountInput
      .extend({
        projectId: z.string().min(1),
        itemId: z.string().min(1),
        bbProjectId: z.string().min(1),
        instructions: z.string().max(4000),
      })
      .strict(),
    output: z.object({ thread: linkedThreadSchema }),
  },
  item_threads: {
    input: z.object({ itemId: z.string().min(1) }).strict(),
    output: z.object({ threads: z.array(linkedThreadSchema) }),
  },
  item_move: {
    input: accountInput
      .extend({
        projectId: z.string().min(1),
        itemId: z.string().min(1),
        stateId: z.string().min(1),
      })
      .strict(),
    output: workItemSchema,
  },
  item_create: {
    input: accountInput
      .extend({
        projectId: z.string().min(1),
        stateId: z.string().min(1),
        name: z.string().trim().min(1).max(255),
      })
      .strict(),
    output: workItemSchema,
  },
});

/** Realtime channel app.tsx refetches a board on; the payload names the project. */
const BOARD_CHANGED = "board-changed";

/**
 * Realtime channel for connection changes. Kept separate from BOARD_CHANGED and
 * debounced, because BB autosaves the settings form as it is typed in: a burst
 * of writes must not become a burst of board reloads.
 */
const CONFIG_CHANGED = "config-changed";

const CONFIG_CHANGED_DEBOUNCE_MS = 400;

/** How long the slow-moving project lookups are reused (Plane allows 60 req/min). */
const LOOKUP_TTL_MS = 5 * 60 * 1000;

interface Lookups {
  project: PlaneProject;
  states: PlaneState[];
  labels: PlaneNamed[];
  members: PlaneMember[];
  fetchedAt: number;
}

export default async function plugin(bb: BbPluginApi) {
  async function readAccounts(): Promise<StoredAccount[]> {
    return (await bb.storage.kv.get<StoredAccount[]>(ACCOUNTS_KEY)) ?? [];
  }
  async function writeAccounts(accounts: StoredAccount[]): Promise<void> {
    await bb.storage.kv.set(ACCOUNTS_KEY, accounts);
  }

  const stored = await readAccounts();

  const generalSetting = bb.settings.define({
    maxItems: {
      type: "number",
      label: "Work items per board",
      experimental_schema: z.number().int().min(50).max(1000),
      default: 200,
    },
  });

  // Fields from the versions before the Accounts panel. Read once to seed kv,
  // then left empty; they will be removed in a later version.
  const legacySetting = bb.settings.define({
    accounts: {
      type: "string",
      label: "Accounts JSON (moved to the Accounts panel)",
      experimental_multiline: true,
      default: "",
    },
  });

  if (stored.length === 0) {
    const raw = (await legacySetting.get()).accounts.trim();
    if (raw !== "" && raw !== "[]") {
      try {
        const parsed: unknown = JSON.parse(raw);
        const migrated: StoredAccount[] = (Array.isArray(parsed) ? parsed : [])
          .slice(0, MAX_ACCOUNTS)
          .map((entry, index) => {
            const row = entry as Record<string, unknown>;
            const id = typeof row.id === "string" ? row.id : `account_${index + 1}`;
            return {
              id,
              label: typeof row.label === "string" ? row.label : id,
              serverUrl: typeof row.serverUrl === "string" ? row.serverUrl : "",
              workspace: typeof row.workspace === "string" ? row.workspace : "",
              webUrl: typeof row.webUrl === "string" ? row.webUrl : "",
              defaultProject:
                typeof row.defaultProject === "string" ? row.defaultProject : "",
              // The old scheme named the first account's key `apiKey` too, so
              // the migrated account keeps the key already stored for it.
              keySetting: KEY_SLOTS[index] ?? KEY_SLOTS[0],
            };
          });
        if (migrated.length > 0) {
          await writeAccounts(migrated);
          stored.push(...migrated);
          bb.log.info(`migrated ${migrated.length} account(s) into the Accounts panel`);
        }
      } catch (cause) {
        bb.log.warn(`could not migrate the Accounts JSON setting: ${String(cause)}`);
      }
      await legacySetting.experimental_set({ accounts: null });
    }
  }

  // The key slots are declared up front so the Accounts panel can store a new
  // account's key without a reload. Each is labelled with whichever account
  // holds it, which is why this runs after the migration above.
  const keyDescriptors: Record<string, { type: "string"; label: string; secret: true }> = {};
  for (const slot of KEY_SLOTS) {
    const holder = stored.find((account) => account.keySetting === slot);
    keyDescriptors[slot] = {
      type: "string",
      label:
        holder === undefined ? `API key — unused slot (${slot})` : `API key — ${holder.label}`,
      secret: true,
    };
  }
  const keySettings = bb.settings.define(keyDescriptors);

  const lookupCache = new Map<string, Lookups>();

  let configChangedTimer: ReturnType<typeof setTimeout> | null = null;
  const publishConfigChanged = () => {
    if (configChangedTimer !== null) clearTimeout(configChangedTimer);
    configChangedTimer = setTimeout(() => {
      configChangedTimer = null;
      bb.realtime.publish(CONFIG_CHANGED, {});
    }, CONFIG_CHANGED_DEBOUNCE_MS);
  };

  const onSettingsChanged = () => {
    lookupCache.clear();
    publishConfigChanged();
  };
  generalSetting.onChange(onSettingsChanged);
  keySettings.onChange(onSettingsChanged);

  async function readKey(account: StoredAccount): Promise<string> {
    if (!KEY_SLOTS.includes(account.keySetting)) return "";
    const keys = await keySettings.get();
    return String(keys[account.keySetting] ?? "").trim();
  }

  /** The connection for one account, or null when it has no key or workspace. */
  async function readConfig(accountId: string): Promise<PlaneConfig | null> {
    const account = (await readAccounts()).find((candidate) => candidate.id === accountId);
    if (account === undefined) return null;
    const apiKey = await readKey(account);
    if (apiKey === "" || account.workspace === "") return null;
    const { rootUrl, webUrl } = resolveUrls(account.serverUrl, account.webUrl);
    return { apiKey, workspace: account.workspace, rootUrl, webUrl };
  }

  async function requireConfig(accountId: string): Promise<PlaneConfig> {
    const config = await readConfig(accountId);
    if (config === null) {
      throw new Error(
        `Account '${accountId}' is not ready. Give it a workspace slug and an API key in the Accounts panel.`,
      );
    }
    return config;
  }

  async function toInfo(account: StoredAccount): Promise<BoardAccount> {
    const apiKey = await readKey(account);
    return {
      id: account.id,
      label: account.label,
      serverUrl: account.serverUrl,
      workspace: account.workspace,
      webUrl: account.webUrl,
      defaultProject: account.defaultProject,
      hasKey: apiKey !== "",
      ready: apiKey !== "" && account.workspace !== "",
    };
  }

  async function getLookups(config: PlaneConfig, projectId: string): Promise<Lookups> {
    const key = `${config.rootUrl}/${config.workspace}/${projectId}`;
    const cached = lookupCache.get(key);
    if (cached !== undefined && Date.now() - cached.fetchedAt < LOOKUP_TTL_MS) {
      return cached;
    }
    const [project, states, labels, members] = await Promise.all([
      getProject(config, projectId),
      listStates(config, projectId),
      listLabels(config, projectId).catch(() => []),
      // Member listing needs a wider token scope than work items do; without it
      // cards fall back to showing nothing rather than failing the board.
      listMembers(config, projectId).catch(() => []),
    ]);
    const lookups: Lookups = { project, states, labels, members, fetchedAt: Date.now() };
    lookupCache.set(key, lookups);
    return lookups;
  }

  const withUrl = (
    config: PlaneConfig,
    projectId: string,
    item: Omit<BoardWorkItem, "url">,
  ): BoardWorkItem => ({ ...item, url: workItemUrl(config, projectId, item.id) });

  /** Every account that has both a workspace and a key, with its connection. */
  async function readyConnections(): Promise<{ account: StoredAccount; config: PlaneConfig }[]> {
    const accounts = await readAccounts();
    const pairs = await Promise.all(
      accounts.map(async (account) => ({ account, config: await readConfig(account.id) })),
    );
    return pairs.flatMap(({ account, config }) =>
      config === null ? [] : [{ account, config }],
    );
  }

  /**
   * Find the work item a key like "GA-724" names. With no account given, every
   * ready connection is tried in order and the first match wins — two Plane
   * instances can both have a "GA" project, and the board cannot know which
   * one an agent meant.
   */
  async function resolveKey(
    key: string,
    accountId: string | null = null,
  ): Promise<{ account: StoredAccount; config: PlaneConfig; projectId: string; itemId: string; identifier: string; sequenceId: number } | null> {
    if (parseWorkItemKey(key) === null) return null;
    const connections = await readyConnections();
    const searched =
      accountId === null
        ? connections
        : connections.filter((entry) => entry.account.id === accountId);
    for (const { account, config } of searched) {
      // A key that is not in this workspace is a miss, not a failure: the next
      // connection may have it.
      const hit = await findWorkItemByKey(config, key).catch(() => null);
      if (hit !== null) {
        return {
          account,
          config,
          projectId: hit.projectId,
          itemId: hit.id,
          identifier: hit.projectIdentifier,
          sequenceId: hit.sequenceId,
        };
      }
    }
    return null;
  }

  /**
   * The whole work item as an agent reads it — properties, description,
   * comments, attachments. Shared by @-mentions, delegation seed prompts, and
   * `bb plane-board show`, so the three cannot drift apart.
   */
  async function buildContext(
    config: PlaneConfig,
    projectId: string,
    itemId: string,
  ): Promise<WorkItemContext> {
    const [lookups, detail, comments, attachments] = await Promise.all([
      getLookups(config, projectId),
      getWorkItem(config, projectId, itemId),
      listComments(config, projectId, itemId).catch(() => []),
      listAttachments(config, projectId, itemId).catch((): PlaneAttachment[] => []),
    ]);
    const members = new Map(lookups.members.map((member) => [member.id, member.name]));
    const labels = new Map(lookups.labels.map((label) => [label.id, label.name]));
    const state =
      detail.stateId === null
        ? null
        : (lookups.states.find((candidate) => candidate.id === detail.stateId) ?? null);
    return {
      key: `${lookups.project.identifier}-${detail.sequenceId}`,
      title: detail.name,
      url: workItemUrl(config, projectId, itemId),
      projectName: lookups.project.name,
      stateName: state?.name ?? null,
      priority: detail.priority,
      labels: detail.labelIds.flatMap((id) => {
        const name = labels.get(id);
        return name === undefined ? [] : [name];
      }),
      assignees: detail.assigneeIds.flatMap((id) => {
        const name = members.get(id);
        return name === undefined ? [] : [name];
      }),
      startDate: detail.startDate,
      targetDate: detail.targetDate,
      updatedAt: detail.updatedAt,
      description: detail.description,
      comments: comments.map((comment) => ({
        author:
          comment.actorId === null
            ? "Someone"
            : (members.get(comment.actorId) ?? "Someone"),
        createdAt: comment.createdAt,
        text: comment.text,
      })),
      attachments: attachments.map((attachment) => ({
        name: attachment.name,
        size: attachment.size,
      })),
    };
  }

  // --- delegated threads -------------------------------------------------
  //
  // A work item's threads live in this plugin's kv, keyed by the Plane work
  // item id. Plane has no field to hold them, and putting a BB thread id in a
  // Plane comment would leak BB's internals into a shared tracker.

  interface StoredLink {
    threadId: string;
    title: string;
    createdAt: string;
  }

  async function readLinks(itemId: string): Promise<StoredLink[]> {
    return (await bb.storage.kv.get<StoredLink[]>(`${THREADS_KEY_PREFIX}${itemId}`)) ?? [];
  }

  /** Each stored link with the thread's live status, newest first. */
  async function hydrateLinks(itemId: string) {
    const links = await readLinks(itemId);
    const rows = await Promise.all(
      links.map(async (link) => {
        // A deleted thread still has a link; say so rather than dropping it,
        // so a card does not quietly forget work that was done.
        const thread = await bb.sdk.threads
          .get({ threadId: link.threadId })
          .catch(() => null);
        return {
          threadId: link.threadId,
          title: thread?.title ?? link.title,
          status: thread === null ? "deleted" : thread.status,
          createdAt: link.createdAt,
        };
      }),
    );
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const anyReady = await Promise.all(
    stored.map(async (account) => (await readConfig(account.id)) !== null),
  );
  if (!anyReady.includes(true)) {
    bb.status.needsConfiguration(
      "Add a Plane connection in the Accounts panel on this plugin's settings page.",
    );
  }

  /** Create or update one account, and store its key when the draft carries one. */
  async function saveAccount(draft: AccountDraft): Promise<BoardAccount> {
    const accounts = await readAccounts();
    const existing =
      draft.id === null ? undefined : accounts.find((candidate) => candidate.id === draft.id);

    if (draft.id !== null && existing === undefined) {
      throw new Error(`No account '${draft.id}'.`);
    }

    let account: StoredAccount;
    if (existing === undefined) {
      if (accounts.length >= MAX_ACCOUNTS) {
        throw new Error(
          `This plugin holds at most ${MAX_ACCOUNTS} accounts. Remove one before adding another.`,
        );
      }
      const slot = freeKeySlot(accounts);
      if (slot === null) throw new Error("No API key slot is free.");
      account = {
        id: uniqueId(
          draft.label,
          accounts.map((candidate) => candidate.id),
        ),
        label: draft.label,
        serverUrl: draft.serverUrl,
        workspace: draft.workspace,
        webUrl: draft.webUrl,
        defaultProject: draft.defaultProject,
        keySetting: slot,
      };
      accounts.push(account);
    } else {
      // The id is stable once created: board URLs point at it.
      existing.label = draft.label;
      existing.serverUrl = draft.serverUrl;
      existing.workspace = draft.workspace;
      existing.webUrl = draft.webUrl;
      existing.defaultProject = draft.defaultProject;
      account = existing;
    }

    // A null key means "leave whatever is stored"; "" clears it.
    if (draft.apiKey !== null) {
      await keySettings.experimental_set({
        [account.keySetting]: draft.apiKey.trim() === "" ? null : draft.apiKey.trim(),
      });
    }

    await writeAccounts(accounts);
    lookupCache.clear();
    publishConfigChanged();
    return toInfo(account);
  }

  /** Remove one account and release the key slot it held. */
  async function removeAccount(accountId: string): Promise<boolean> {
    const accounts = await readAccounts();
    const target = accounts.find((candidate) => candidate.id === accountId);
    if (target === undefined) return false;
    // Free the key slot too, or it stays claimed and unreachable.
    await keySettings.experimental_set({ [target.keySetting]: null });
    await writeAccounts(accounts.filter((candidate) => candidate.id !== accountId));
    lookupCache.clear();
    publishConfigChanged();
    return true;
  }

  /** Ask Plane whether this account's key and workspace actually work. */
  async function testAccount(accountId: string): Promise<{ ok: boolean; message: string }> {
    try {
      const config = await requireConfig(accountId);
      const projects = await listProjects(config);
      return {
        ok: true,
        message: `Reached ${config.workspace} at ${config.rootUrl} — ${projects.length} project${projects.length === 1 ? "" : "s"}.`,
      };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  // The browser holds no Plane API key, so an attachment is served through this
  // plugin: the route re-fetches it from Plane with the account's key and
  // streams the bytes back. "local" auth means only the BB app can reach it.
  const ATTACHMENT_PATH = "/attachment";

  function attachmentUrl(
    accountId: string,
    projectId: string,
    itemId: string,
    attachmentId: string,
  ): string {
    const query = new URLSearchParams({
      account: accountId,
      project: projectId,
      item: itemId,
      id: attachmentId,
    });
    return `/api/v1/plugins/${bb.pluginId}/http${ATTACHMENT_PATH}?${query.toString()}`;
  }

  bb.http.route("GET", ATTACHMENT_PATH, async (context) => {
    const accountId = context.req.query("account") ?? "";
    const projectId = context.req.query("project") ?? "";
    const itemId = context.req.query("item") ?? "";
    const attachmentId = context.req.query("id") ?? "";
    if (accountId === "" || projectId === "" || itemId === "" || attachmentId === "") {
      return new Response("account, project, item and id are all required", {
        status: 400,
      });
    }

    try {
      const config = await requireConfig(accountId);
      const attachment = (await listAttachments(config, projectId, itemId)).find(
        (candidate) => candidate.id === attachmentId,
      );
      if (attachment === undefined) {
        return new Response("No such attachment on this work item.", { status: 404 });
      }
      const upstream = await fetchAttachment(config, projectId, itemId, attachmentId);
      return new Response(upstream.body, {
        headers: {
          "Content-Type":
            attachment.contentType === ""
              ? (upstream.headers.get("Content-Type") ?? "application/octet-stream")
              : attachment.contentType,
          // Named, but shown inline: the preview renders images in place.
          "Content-Disposition": `inline; filename="${attachment.name.replace(/["\\]/g, "")}"`,
          // Attachment bytes never change under their id, but the URL carries
          // an account, so keep it out of any shared cache.
          "Cache-Control": "private, max-age=300",
        },
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      bb.log.warn(`attachment ${attachmentId}: ${message}`);
      return new Response(message, { status: 502 });
    }
  });

  bb.rpc.register(rpcContract, {
    accounts_list: async () => {
      const accounts = await readAccounts();
      return {
        accounts: await Promise.all(accounts.map(toInfo)),
        remainingSlots: Math.max(0, MAX_ACCOUNTS - accounts.length),
      };
    },

    account_save: async (draft) => ({ account: await saveAccount(draft) }),

    account_remove: async ({ accountId }) => ({ removed: await removeAccount(accountId) }),

    account_test: ({ accountId }) => testAccount(accountId),

    projects_list: async ({ accountId }) => {
      const config = await requireConfig(accountId);
      return { projects: await listProjects(config) };
    },

    board_load: async ({ accountId, projectId }) => {
      const config = await requireConfig(accountId);
      const { maxItems } = await generalSetting.get();
      const [lookups, items] = await Promise.all([
        getLookups(config, projectId),
        listWorkItems(config, projectId, maxItems),
      ]);
      return {
        project: lookups.project,
        states: lookups.states,
        labels: lookups.labels,
        members: lookups.members,
        items: items.map((item) => withUrl(config, projectId, item)),
        // Plane's list endpoint takes no state filter, so a project bigger than
        // the cap shows its most recently updated slice. Say so in the UI.
        truncated: items.length >= maxItems,
      };
    },

    item_detail: async ({ accountId, projectId, itemId }) => {
      const config = await requireConfig(accountId);
      const [detail, comments, attachments] = await Promise.all([
        getWorkItem(config, projectId, itemId),
        // Comments need their own token scope, so a denial shows the rest of
        // the work item rather than failing the whole preview.
        listComments(config, projectId, itemId).then(
          (rows) => ({ rows, available: true }),
          () => ({ rows: [], available: false }),
        ),
        listAttachments(config, projectId, itemId).then(
          (rows) => ({ rows, available: true }),
          () => ({ rows: [], available: false }),
        ),
      ]);
      const { description, ...item } = detail;
      return {
        item: withUrl(config, projectId, item),
        description,
        comments: comments.rows,
        commentsAvailable: comments.available,
        attachments: attachments.rows.map((attachment) => ({
          ...attachment,
          url: attachmentUrl(accountId, projectId, itemId, attachment.id),
        })),
        attachmentsAvailable: attachments.available,
      };
    },

    item_by_key: async ({ key }) => {
      const found = await resolveKey(key);
      if (found === null) return { card: null };
      const { config, projectId, itemId, identifier } = found;
      const [lookups, item] = await Promise.all([
        getLookups(config, projectId),
        getWorkItem(config, projectId, itemId),
      ]);
      const state =
        item.stateId === null
          ? null
          : (lookups.states.find((candidate) => candidate.id === item.stateId) ?? null);
      return {
        card: {
          accountId: found.account.id,
          projectId,
          itemId,
          key: `${identifier}-${item.sequenceId}`,
          name: item.name,
          url: workItemUrl(config, projectId, itemId),
          priority: item.priority,
          stateName: state?.name ?? null,
          stateColor: state?.color ?? null,
        },
      };
    },

    bb_projects: async () => {
      const projects = await bb.sdk.projects.list();
      return { projects: projects.map((project) => ({ id: project.id, name: project.name })) };
    },

    item_delegate: async ({ accountId, projectId, itemId, bbProjectId, instructions }) => {
      const config = await requireConfig(accountId);
      const context = await buildContext(config, projectId, itemId);
      const thread = await bb.sdk.threads.spawn({
        projectId: bbProjectId,
        // The project's own default environment and execution settings, so a
        // delegation behaves like a thread started by hand in that project.
        environment: { type: "project-default" },
        title: `${context.key} — ${context.title}`,
        prompt: renderSeedPrompt(context, instructions),
      });
      const link = {
        threadId: thread.id,
        title: thread.title ?? context.key,
        createdAt: new Date().toISOString(),
      };
      await bb.storage.kv.set(`${THREADS_KEY_PREFIX}${itemId}`, [
        ...(await readLinks(itemId)),
        link,
      ]);
      bb.realtime.publish(BOARD_CHANGED, { projectId });
      return { thread: { ...link, status: thread.status } };
    },

    item_threads: async ({ itemId }) => ({ threads: await hydrateLinks(itemId) }),

    item_move: async ({ accountId, projectId, itemId, stateId }) => {
      const config = await requireConfig(accountId);
      const item = await updateWorkItem(config, projectId, itemId, { state: stateId });
      bb.realtime.publish(BOARD_CHANGED, { projectId });
      return withUrl(config, projectId, item);
    },

    item_create: async ({ accountId, projectId, stateId, name }) => {
      const config = await requireConfig(accountId);
      const item = await createWorkItem(config, projectId, { name, state: stateId });
      bb.realtime.publish(BOARD_CHANGED, { projectId });
      return withUrl(config, projectId, item);
    },
  });

  // Typing `@` in the composer offers work items; picking one resolves the
  // whole ticket into the message as agent-visible context at send time. The
  // host time-boxes `search` to 2s and isolates its failures, so a slow Plane
  // instance quietly contributes nothing rather than breaking the menu.
  bb.ui.registerMentionProvider({
    id: "work-items",
    label: "Plane",
    async search({ query }) {
      if (query.trim() === "") return [];
      const connections = await readyConnections();
      const perAccount = await Promise.all(
        connections.map(async ({ account, config }) => {
          const hits = await searchWorkItems(config, query, MENTION_LIMIT).catch(() => []);
          return hits.map((hit) => {
            const key = `${hit.projectIdentifier}-${hit.sequenceId}`;
            return {
              // The host namespaces this behind the provider id; account ids
              // are slugs, so "|" cannot occur inside one of the three parts.
              id: `${account.id}|${hit.projectId}|${hit.id}`,
              title: hit.name,
              subtitle: connections.length > 1 ? `${key} · ${account.label}` : key,
            };
          });
        }),
      );
      return perAccount.flat().slice(0, MENTION_LIMIT);
    },
    async resolve(itemId) {
      const [accountId, projectId, workItemId] = itemId.split("|");
      if (accountId === undefined || projectId === undefined || workItemId === undefined) {
        throw new Error(`Unrecognized Plane mention '${itemId}'.`);
      }
      const config = await requireConfig(accountId);
      return { context: renderWorkItem(await buildContext(config, projectId, workItemId)) };
    },
  });

  const usage = [
    "Usage:",
    "  bb plane-board accounts                    List the configured connections",
    "  bb plane-board check                       Verify a connection's key and workspace",
    "  bb plane-board projects                    List an account's projects",
    "",
    "  bb plane-board search <query>              Search work items across the workspace",
    "  bb plane-board list                        List a project's work items",
    "  bb plane-board show <KEY>                  One work item, in full",
    "  bb plane-board create <title>              File a work item",
    "  bb plane-board update <KEY>                Change state, priority, or title",
    "  bb plane-board comment <KEY> <text>        Add a comment",
    "  bb plane-board attachment list <KEY>       List a work item's files",
    "  bb plane-board attachment get <KEY> <name> --out <path>",
    "  bb plane-board delegate <KEY> --bb-project <id>",
    "                                             Start a BB thread on a work item",
    "  bb plane-board threads <KEY>               Threads delegated from a work item",
    "",
    "Options:",
    "  --account <id>        Which connection to use (default: first ready one)",
    "  --project <ref>       Project UUID, identifier (GA), or name",
    "  --state <name>        State name, or a group: backlog, unstarted, started,",
    "                        completed, cancelled",
    "  --priority <p>        urgent, high, medium, low, none",
    "  --title <text>        New title, for update",
    "  --description <text>  Description, for create",
    "  --instructions <text> What the delegated thread should do",
    "  --limit <n>           Row cap (default 50 for list, 20 for search)",
    "  --out <path>          Where attachment get writes the file",
    "  --json                Machine-readable output",
    "",
    "Accounts are added and edited in the Accounts panel on the plugin's settings",
    "page. A KEY is a work-item key like GA-724.",
  ].join("\n");

  const PRIORITIES = ["urgent", "high", "medium", "low", "none"];

  bb.cli.register({
    name: "plane-board",
    summary: "Read and write Plane work items, and delegate them to agents",
    commands: [
      {
        name: "accounts",
        summary: "List the configured connections",
        usage: "bb plane-board accounts [--json]",
      },
      {
        name: "check",
        summary: "Verify a connection's API key and workspace",
        usage: "bb plane-board check [--account <id>] [--json]",
      },
      {
        name: "projects",
        summary: "List an account's projects",
        usage: "bb plane-board projects [--account <id>] [--json]",
      },
      {
        name: "search",
        summary: "Search work items across the workspace",
        usage: "bb plane-board search <query> [--limit <n>] [--json]",
      },
      {
        name: "list",
        summary: "List a project's work items",
        usage:
          "bb plane-board list [--project <ref>] [--state <name>] [--limit <n>] [--json]",
      },
      {
        name: "show",
        summary: "One work item, with its description, comments and attachments",
        usage: "bb plane-board show <KEY> [--json]",
      },
      {
        name: "create",
        summary: "File a work item",
        usage:
          "bb plane-board create <title> [--project <ref>] [--state <name>] [--priority <p>] [--description <text>] [--json]",
      },
      {
        name: "update",
        summary: "Change a work item's state, priority, or title",
        usage:
          "bb plane-board update <KEY> [--state <name>] [--priority <p>] [--title <text>] [--json]",
      },
      {
        name: "comment",
        summary: "Add a comment to a work item",
        usage: "bb plane-board comment <KEY> <text> [--json]",
      },
      {
        name: "attachment",
        summary: "List or download a work item's files",
        usage:
          "bb plane-board attachment list <KEY> | attachment get <KEY> <name> --out <path>",
      },
      {
        name: "delegate",
        summary: "Start a BB thread seeded with a work item",
        usage:
          "bb plane-board delegate <KEY> --bb-project <id> [--instructions <text>] [--json]",
      },
      {
        name: "threads",
        summary: "The BB threads delegated from a work item",
        usage: "bb plane-board threads <KEY> [--json]",
      },
    ],
    async run(argv, ctx) {
      const parsed = parseArgv(argv);
      const json = hasFlag(parsed, "json");
      const requested = flagValue(parsed, "account");
      const [command, ...rest] = parsed.positionals;

      /** The named account, or the first one that can actually be used. */
      async function pickAccount(): Promise<StoredAccount> {
        const accounts = await readAccounts();
        if (accounts.length === 0) {
          throw new Error(
            "No accounts yet. Add one in the Accounts panel on this plugin's settings page.",
          );
        }
        if (requested !== null) {
          const named = accounts.find((account) => account.id === requested);
          if (named === undefined) {
            throw new Error(
              `No account '${requested}'. Known: ${accounts.map((a) => a.id).join(", ")}`,
            );
          }
          return named;
        }
        for (const account of accounts) {
          if ((await readConfig(account.id)) !== null) return account;
        }
        throw new Error("No account has both a workspace slug and an API key yet.");
      }

      /** A project UUID, identifier (`GA`), or name, resolved to its UUID. */
      async function resolveProject(
        config: PlaneConfig,
        account: StoredAccount,
      ): Promise<PlaneProject> {
        const ref = flagValue(parsed, "project") ?? account.defaultProject;
        const projects = await listProjects(config);
        if (ref === "") {
          if (projects.length === 1 && projects[0] !== undefined) return projects[0];
          throw new Error(
            `--project is required. Known: ${projects.map((p) => p.identifier).join(", ")}`,
          );
        }
        const needle = ref.trim().toLowerCase();
        const match =
          projects.find((project) => project.id === ref) ??
          projects.find((project) => project.identifier.toLowerCase() === needle) ??
          projects.find((project) => project.name.toLowerCase() === needle);
        if (match === undefined) {
          throw new Error(
            `No project '${ref}'. Known: ${projects.map((p) => `${p.identifier} (${p.name})`).join(", ")}`,
          );
        }
        return match;
      }

      /** Resolve a KEY argument, or explain what went wrong. */
      async function requireItem(key: string | undefined) {
        if (key === undefined) throw new Error("A work-item key is required, e.g. GA-724.");
        if (parseWorkItemKey(key) === null) {
          throw new Error(`'${key}' is not a work-item key. Keys look like GA-724.`);
        }
        const found = await resolveKey(key, requested);
        if (found === null) {
          throw new Error(
            `No work item ${key.toUpperCase()} in ${requested === null ? "any configured workspace" : `account '${requested}'`}.`,
          );
        }
        return found;
      }

      /** A state name or group, resolved against one project's states. */
      function resolveState(states: PlaneState[], name: string): PlaneState {
        const needle = name.trim().toLowerCase();
        const match =
          states.find((state) => state.name.toLowerCase() === needle) ??
          states.find((state) => state.group.toLowerCase() === needle);
        if (match === undefined) {
          throw new Error(
            `No state '${name}'. Known: ${states.map((state) => state.name).join(", ")}`,
          );
        }
        return match;
      }

      function requirePriority(value: string): string {
        const priority = value.trim().toLowerCase();
        if (!PRIORITIES.includes(priority)) {
          throw new Error(`Priority must be one of: ${PRIORITIES.join(", ")}`);
        }
        return priority;
      }

      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };

          case "accounts": {
            const accounts = await readAccounts();
            const rows = await Promise.all(accounts.map(toInfo));
            if (json) return { exitCode: 0, stdout: JSON.stringify(rows) };
            return {
              exitCode: 0,
              stdout:
                rows.length === 0
                  ? "No accounts yet. Add one in the Accounts panel on this plugin's settings page."
                  : rows
                      .map(
                        (row) =>
                          `${row.ready ? "✓" : "✗"} ${row.id}\t${row.label}\t${row.workspace === "" ? "(no workspace)" : row.workspace}\t${resolveUrls(row.serverUrl, row.webUrl).rootUrl}`,
                      )
                      .join("\n"),
            };
          }

          case "check": {
            const account = await pickAccount();
            const config = await requireConfig(account.id);
            const projects = await listProjects(config);
            if (json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  account: account.id,
                  rootUrl: config.rootUrl,
                  webUrl: config.webUrl,
                  workspace: config.workspace,
                  projects: projects.length,
                }),
              };
            }
            return {
              exitCode: 0,
              stdout: [
                `Account:   ${account.id} (${account.label})`,
                `Server:    ${config.rootUrl}`,
                `Web UI:    ${config.webUrl}`,
                `Workspace: ${config.workspace}`,
                `Key:       ${config.apiKey.slice(0, 12)}…`,
                `Projects:  ${projects.length}`,
              ].join("\n"),
            };
          }

          case "projects": {
            const account = await pickAccount();
            const config = await requireConfig(account.id);
            const projects = await listProjects(config);
            if (json) return { exitCode: 0, stdout: JSON.stringify(projects) };
            return {
              exitCode: 0,
              stdout:
                projects.length === 0
                  ? "No projects in this workspace."
                  : projects
                      .map((project) => `${project.identifier}\t${project.name}\t${project.id}`)
                      .join("\n"),
            };
          }

          case "search": {
            const query = rest.join(" ").trim();
            if (query === "") throw new Error("A search query is required.");
            const account = await pickAccount();
            const config = await requireConfig(account.id);
            const limit = Number(flagValue(parsed, "limit") ?? 20);
            const hits = await searchWorkItems(config, query, limit);
            if (json) return { exitCode: 0, stdout: JSON.stringify(hits) };
            return {
              exitCode: 0,
              stdout:
                hits.length === 0
                  ? `No work items matched '${query}'.`
                  : hits
                      .map(
                        (hit) =>
                          `${hit.projectIdentifier}-${hit.sequenceId}\t${hit.name}`,
                      )
                      .join("\n"),
            };
          }

          case "list": {
            const account = await pickAccount();
            const config = await requireConfig(account.id);
            const project = await resolveProject(config, account);
            const limit = Number(flagValue(parsed, "limit") ?? 50);
            const stateFilter = flagValue(parsed, "state");
            // Plane's list endpoint takes no state filter, so filtering means
            // fetching a wider slice of the most recently updated items and
            // narrowing it here. Without this, `--state x --limit 5` would
            // filter the 5 newest items rather than find 5 in that state.
            const fetchLimit =
              stateFilter === null ? limit : Math.min(500, Math.max(limit * 10, 200));
            const [lookups, items] = await Promise.all([
              getLookups(config, project.id),
              listWorkItems(config, project.id, fetchLimit),
            ]);
            const states = new Map(lookups.states.map((state) => [state.id, state]));
            const wanted =
              stateFilter === null ? null : resolveState(lookups.states, stateFilter);
            const rows = items
              .filter((item) => wanted === null || item.stateId === wanted.id)
              .slice(0, limit)
              .map((item) => ({
                key: `${project.identifier}-${item.sequenceId}`,
                name: item.name,
                state: item.stateId === null ? null : (states.get(item.stateId)?.name ?? null),
                priority: item.priority,
                url: workItemUrl(config, project.id, item.id),
              }));
            if (json) return { exitCode: 0, stdout: JSON.stringify(rows) };
            return {
              exitCode: 0,
              stdout:
                rows.length === 0
                  ? "No work items matched."
                  : rows
                      .map(
                        (row) =>
                          `${row.key}\t${row.state ?? "-"}\t${row.priority}\t${row.name}`,
                      )
                      .join("\n"),
            };
          }

          case "show": {
            const found = await requireItem(rest[0]);
            const context = await buildContext(found.config, found.projectId, found.itemId);
            if (json) return { exitCode: 0, stdout: JSON.stringify(context) };
            return { exitCode: 0, stdout: renderWorkItem(context) };
          }

          case "create": {
            const title = rest.join(" ").trim();
            if (title === "") throw new Error("A title is required.");
            const account = await pickAccount();
            const config = await requireConfig(account.id);
            const project = await resolveProject(config, account);
            const lookups = await getLookups(config, project.id);
            const stateName = flagValue(parsed, "state");
            const priority = flagValue(parsed, "priority");
            const description = flagValue(parsed, "description");
            const body: Record<string, unknown> = { name: title };
            if (stateName !== null) body.state = resolveState(lookups.states, stateName).id;
            if (priority !== null) body.priority = requirePriority(priority);
            if (description !== null) body.description_html = textToHtml(description);
            const item = await createWorkItem(config, project.id, body);
            bb.realtime.publish(BOARD_CHANGED, { projectId: project.id });
            const key = `${project.identifier}-${item.sequenceId}`;
            const url = workItemUrl(config, project.id, item.id);
            if (json) {
              return { exitCode: 0, stdout: JSON.stringify({ key, id: item.id, url }) };
            }
            return { exitCode: 0, stdout: `${key}\t${item.name}\n${url}` };
          }

          case "update": {
            const found = await requireItem(rest[0]);
            const lookups = await getLookups(found.config, found.projectId);
            const stateName = flagValue(parsed, "state");
            const priority = flagValue(parsed, "priority");
            const title = flagValue(parsed, "title");
            const patch: Record<string, unknown> = {};
            if (stateName !== null) patch.state = resolveState(lookups.states, stateName).id;
            if (priority !== null) patch.priority = requirePriority(priority);
            if (title !== null) patch.name = title;
            if (Object.keys(patch).length === 0) {
              throw new Error("Nothing to update. Pass --state, --priority, or --title.");
            }
            const item = await updateWorkItem(
              found.config,
              found.projectId,
              found.itemId,
              patch,
            );
            bb.realtime.publish(BOARD_CHANGED, { projectId: found.projectId });
            const key = `${found.identifier}-${item.sequenceId}`;
            const state =
              item.stateId === null
                ? null
                : (lookups.states.find((candidate) => candidate.id === item.stateId) ?? null);
            if (json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  key,
                  name: item.name,
                  state: state?.name ?? null,
                  priority: item.priority,
                }),
              };
            }
            return {
              exitCode: 0,
              stdout: `${key}\t${state?.name ?? "-"}\t${item.priority}\t${item.name}`,
            };
          }

          case "comment": {
            const found = await requireItem(rest[0]);
            const text = rest.slice(1).join(" ").trim();
            if (text === "") throw new Error("A comment body is required.");
            const comment = await createComment(
              found.config,
              found.projectId,
              found.itemId,
              text,
            );
            if (json) return { exitCode: 0, stdout: JSON.stringify(comment) };
            return {
              exitCode: 0,
              stdout: `Commented on ${found.identifier}-${found.sequenceId}.`,
            };
          }

          case "attachment": {
            const [action, key, ...nameParts] = rest;
            if (action === "list") {
              const found = await requireItem(key);
              const attachments = await listAttachments(
                found.config,
                found.projectId,
                found.itemId,
              );
              if (json) return { exitCode: 0, stdout: JSON.stringify(attachments) };
              return {
                exitCode: 0,
                stdout:
                  attachments.length === 0
                    ? "No attachments."
                    : attachments
                        .map(
                          (attachment) =>
                            `${attachment.name}\t${attachment.size ?? "?"}\t${attachment.contentType}`,
                        )
                        .join("\n"),
              };
            }
            if (action === "get") {
              const found = await requireItem(key);
              const wanted = nameParts.join(" ").trim();
              const out = flagValue(parsed, "out");
              if (wanted === "") throw new Error("An attachment name is required.");
              if (out === null) throw new Error("--out <path> is required.");
              const attachments = await listAttachments(
                found.config,
                found.projectId,
                found.itemId,
              );
              const matches = attachments.filter(
                (attachment) => attachment.name === wanted,
              );
              if (matches.length === 0) {
                throw new Error(
                  `No attachment named '${wanted}'. Found: ${attachments.map((a) => a.name).join(", ") || "(none)"}`,
                );
              }
              if (matches.length > 1) {
                throw new Error(`${matches.length} attachments are named '${wanted}'.`);
              }
              const attachment = matches[0];
              if (attachment === undefined) throw new Error("No attachment matched.");
              const response = await fetchAttachment(
                found.config,
                found.projectId,
                found.itemId,
                attachment.id,
              );
              const bytes = Buffer.from(await response.arrayBuffer());
              // `--out` is resolved against the directory the CLI was invoked
              // from, and written on BB's primary host.
              const path = resolvePath(ctx.cwd ?? process.cwd(), out);
              await bb.sdk.files.write({
                path,
                content: bytes.toString("base64"),
                contentEncoding: "base64",
                createParents: true,
              });
              if (json) {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({ path, bytes: bytes.byteLength }),
                };
              }
              return { exitCode: 0, stdout: `Wrote ${bytes.byteLength} bytes to ${path}` };
            }
            throw new Error("Usage: bb plane-board attachment list|get <KEY> …");
          }

          case "delegate": {
            const found = await requireItem(rest[0]);
            const bbProjectId = flagValue(parsed, "bb-project");
            if (bbProjectId === null) {
              const projects = await bb.sdk.projects.list();
              throw new Error(
                `--bb-project <id> is required. Known: ${projects.map((p) => `${p.id} (${p.name})`).join(", ")}`,
              );
            }
            const context = await buildContext(found.config, found.projectId, found.itemId);
            const thread = await bb.sdk.threads.spawn({
              projectId: bbProjectId,
              environment: { type: "project-default" },
              title: `${context.key} — ${context.title}`,
              prompt: renderSeedPrompt(context, flagValue(parsed, "instructions") ?? ""),
            });
            await bb.storage.kv.set(`${THREADS_KEY_PREFIX}${found.itemId}`, [
              ...(await readLinks(found.itemId)),
              {
                threadId: thread.id,
                title: thread.title ?? context.key,
                createdAt: new Date().toISOString(),
              },
            ]);
            bb.realtime.publish(BOARD_CHANGED, { projectId: found.projectId });
            if (json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ threadId: thread.id, key: context.key }),
              };
            }
            return {
              exitCode: 0,
              stdout: `Started ${thread.id} on ${context.key}.`,
            };
          }

          case "threads": {
            const found = await requireItem(rest[0]);
            const threads = await hydrateLinks(found.itemId);
            if (json) return { exitCode: 0, stdout: JSON.stringify(threads) };
            return {
              exitCode: 0,
              stdout:
                threads.length === 0
                  ? "No threads have been delegated from this work item."
                  : threads
                      .map((row) => `${row.threadId}\t${row.status}\t${row.title}`)
                      .join("\n"),
            };
          }
        }
      } catch (cause) {
        return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.onDispose(() => {
    if (configChangedTimer !== null) clearTimeout(configChangedTimer);
    lookupCache.clear();
  });
}
