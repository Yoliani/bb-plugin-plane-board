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
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  KEY_SLOTS,
  MAX_ACCOUNTS,
  freeKeySlot,
  uniqueId,
  type StoredAccount,
} from "./lib/accounts";
import {
  createWorkItem,
  getProject,
  getWorkItem,
  listComments,
  listLabels,
  listMembers,
  listProjects,
  listStates,
  listWorkItems,
  resolveUrls,
  updateWorkItem,
  workItemUrl,
  type PlaneConfig,
  type PlaneMember,
  type PlaneNamed,
  type PlaneProject,
  type PlaneState,
} from "./lib/plane";

const ACCOUNTS_KEY = "accounts";

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
    }),
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
      const [detail, comments] = await Promise.all([
        getWorkItem(config, projectId, itemId),
        // Comments need their own token scope, so a denial shows the rest of
        // the work item rather than failing the whole preview.
        listComments(config, projectId, itemId).then(
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
      };
    },

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

  const usage = [
    "Usage:",
    "  bb plane-board accounts                   List the configured connections",
    "  bb plane-board check [--account <id>]     Verify a connection's key and workspace",
    "  bb plane-board projects [--account <id>]  List an account's projects",
    "",
    "Accounts are added and edited in the Accounts panel on the plugin's settings",
    "page. --account defaults to the first ready connection; --json for raw output.",
  ].join("\n");

  bb.cli.register({
    name: "plane-board",
    summary: "Check the Plane connections used by the board",
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
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const accountFlag = argv.indexOf("--account");
      const requested = accountFlag === -1 ? null : (argv[accountFlag + 1] ?? null);
      const rest = argv.filter(
        (arg, index) =>
          arg !== "--json" &&
          (accountFlag === -1 || (index !== accountFlag && index !== accountFlag + 1)),
      );
      const [command] = rest;

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
