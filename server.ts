// bb-plugin-plane-board — backend entry.
//
// Holds the Plane API keys and every call to Plane: the frontend never sees a
// key and never talks to a Plane host directly. app.tsx reaches this over the
// RPC contract below; `bb plane-board` reaches the same helpers from a shell.
//
// One install can hold several Plane connections — a Cloud account and a
// self-hosted instance, say. The non-secret half of each lives in the
// `accounts` JSON setting; the key half is one `secret` setting per account,
// so keys stay in the 0600 secrets file rather than the database.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
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

/** The account every install starts with; its key keeps the plain `apiKey` name. */
const DEFAULT_ACCOUNT_ID = "default";

/**
 * One connection's non-secret half. Ids are restricted because each one becomes
 * a settings key.
 */
const accountSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_]{0,31}$/, "id must be lowercase letters, digits, or _"),
    label: z.string().trim().min(1).max(64),
    serverUrl: z.string().trim().default("https://api.plane.so"),
    workspace: z.string().trim().default(""),
    webUrl: z.string().trim().default(""),
    defaultProject: z.string().trim().default(""),
  })
  .strict();

type Account = z.infer<typeof accountSchema>;

const accountsSchema = z.array(accountSchema).max(20);

function parseAccounts(raw: string): Account[] {
  const parsed = accountsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "invalid accounts");
  const ids = new Set<string>();
  for (const account of parsed.data) {
    if (ids.has(account.id)) throw new Error(`duplicate account id '${account.id}'`);
    ids.add(account.id);
  }
  return parsed.data;
}

/** The settings key holding an account's API key. */
function keySettingName(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? "apiKey" : `apiKey_${accountId}`;
}

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

/** One connection as the board sees it — never carrying the key itself. */
const accountInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  workspace: z.string(),
  rootUrl: z.string(),
  defaultProject: z.string(),
  /** False when the account has no API key yet, or no workspace slug. */
  ready: z.boolean(),
});

export type BoardWorkItem = z.infer<typeof workItemSchema>;
export type BoardComment = z.infer<typeof commentSchema>;
export type BoardState = z.infer<typeof stateSchema>;
export type BoardLabel = z.infer<typeof namedSchema>;
export type BoardMember = z.infer<typeof memberSchema>;
export type BoardProject = z.infer<typeof projectSchema>;
export type BoardAccount = z.infer<typeof accountInfoSchema>;

const accountInput = z.object({ accountId: z.string().min(1) });

export const rpcContract = defineRpcContract({
  config_read: {
    input: z.null(),
    output: z.object({
      accounts: z.array(accountInfoSchema),
      /** The accounts setting could not be parsed; the message says why. */
      error: z.string().nullable(),
    }),
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
  // Read the account list first: its ids decide which key settings exist.
  const accountsSetting = bb.settings.define({
    accounts: {
      type: "string",
      label: "Accounts",
      description:
        'JSON array of Plane connections: {"id","label","serverUrl","workspace","webUrl","defaultProject"}. Reload the plugin after adding one, so its API key field appears.',
      experimental_multiline: true,
      experimental_schema: z.string().refine((value) => {
        try {
          parseAccounts(value);
          return true;
        } catch {
          return false;
        }
      }, "Accounts must be a JSON array of connections"),
      default: JSON.stringify(
        [
          {
            id: DEFAULT_ACCOUNT_ID,
            label: "Plane",
            serverUrl: "https://api.plane.so",
            workspace: "",
            webUrl: "",
            defaultProject: "",
          },
        ],
        null,
        2,
      ),
    },
  });

  // Fields from the single-account version. Read once to seed `accounts`, then
  // left empty; they will be removed in a later version.
  const legacySetting = bb.settings.define({
    workspace: { type: "string", label: "Workspace slug (moved to Accounts)", default: "" },
    serverUrl: { type: "string", label: "Server URL (moved to Accounts)", default: "" },
    webUrl: { type: "string", label: "Web UI URL (moved to Accounts)", default: "" },
    defaultProject: {
      type: "string",
      label: "Default project (moved to Accounts)",
      default: "",
    },
  });

  const generalSetting = bb.settings.define({
    maxItems: {
      type: "number",
      label: "Work items per board",
      experimental_schema: z.number().int().min(50).max(1000),
      default: 200,
    },
  });

  /** The accounts as stored, or the parse error to report to the board. */
  async function readAccounts(): Promise<{ accounts: Account[]; error: string | null }> {
    const { accounts } = await accountsSetting.get();
    try {
      return { accounts: parseAccounts(accounts), error: null };
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return { accounts: [], error: `The Accounts setting is not valid: ${detail}` };
    }
  }

  // One-time migration off the single-account fields. The default account keeps
  // the `apiKey` settings name, so a configured key survives untouched.
  const legacy = await legacySetting.get();
  if (legacy.workspace !== "" || legacy.serverUrl !== "") {
    const { accounts } = await readAccounts();
    const target = accounts.find((account) => account.id === DEFAULT_ACCOUNT_ID);
    if (target !== undefined && target.workspace === "") {
      target.workspace = legacy.workspace;
      if (legacy.serverUrl !== "") target.serverUrl = legacy.serverUrl;
      target.webUrl = legacy.webUrl;
      target.defaultProject = legacy.defaultProject;
      await accountsSetting.experimental_set({ accounts: JSON.stringify(accounts, null, 2) });
      bb.log.info(`migrated the single-account settings into account '${DEFAULT_ACCOUNT_ID}'`);
    }
    await legacySetting.experimental_set({
      workspace: null,
      serverUrl: null,
      webUrl: null,
      defaultProject: null,
    });
  }

  // Descriptors are fixed for the life of a load, so the key fields come from
  // the account ids stored right now. `default` is always present, which is why
  // an install with no accounts still has somewhere to put a key.
  const { accounts: definedAccounts } = await readAccounts();
  const keyDescriptors: Record<string, { type: "string"; label: string; secret: true }> = {};
  for (const id of new Set([DEFAULT_ACCOUNT_ID, ...definedAccounts.map((a) => a.id)])) {
    const label = definedAccounts.find((account) => account.id === id)?.label ?? id;
    keyDescriptors[keySettingName(id)] = {
      type: "string",
      label: `API key — ${label}`,
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
  accountsSetting.onChange(onSettingsChanged);
  generalSetting.onChange(onSettingsChanged);
  keySettings.onChange(onSettingsChanged);

  /**
   * The connection for one account, or null when it has no key or no workspace.
   * Settings are re-read per call so an edit takes effect without a reload.
   */
  async function readConfig(accountId: string): Promise<PlaneConfig | null> {
    const { accounts } = await readAccounts();
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (account === undefined) return null;
    const keyName = keySettingName(account.id);
    if (!(keyName in keyDescriptors)) return null;
    const keys = await keySettings.get();
    const apiKey = String(keys[keyName] ?? "").trim();
    if (apiKey === "" || account.workspace === "") return null;
    const { rootUrl, webUrl } = resolveUrls(account.serverUrl, account.webUrl);
    return { apiKey, workspace: account.workspace, rootUrl, webUrl };
  }

  async function requireConfig(accountId: string): Promise<PlaneConfig> {
    const config = await readConfig(accountId);
    if (config === null) {
      throw new Error(
        `Account '${accountId}' is not ready. Give it a workspace slug and an API key in Extensions -> Plugins -> Plane Board.`,
      );
    }
    return config;
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

  const readyAccounts = await Promise.all(
    definedAccounts.map(async (account) => (await readConfig(account.id)) !== null),
  );
  if (!readyAccounts.includes(true)) {
    bb.status.needsConfiguration(
      "Add a Plane workspace slug and API key in Extensions -> Plugins -> Plane Board.",
    );
  }

  bb.rpc.register(rpcContract, {
    config_read: async () => {
      const { accounts, error } = await readAccounts();
      const infos = await Promise.all(
        accounts.map(async (account) => {
          const { rootUrl } = resolveUrls(account.serverUrl, account.webUrl);
          return {
            id: account.id,
            label: account.label,
            workspace: account.workspace,
            rootUrl,
            defaultProject: account.defaultProject,
            ready: (await readConfig(account.id)) !== null,
          };
        }),
      );
      return { accounts: infos, error };
    },

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
    "--account defaults to the first ready connection. Add --json for raw output.",
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
      async function pickAccount(): Promise<Account> {
        const { accounts, error } = await readAccounts();
        if (error !== null) throw new Error(error);
        if (accounts.length === 0) throw new Error("No accounts are configured.");
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
        throw new Error(
          "No account has both a workspace slug and an API key yet. Run `bb plane-board accounts`.",
        );
      }

      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };

          case "accounts": {
            const { accounts, error } = await readAccounts();
            if (error !== null) return { exitCode: 1, stderr: error };
            const rows = await Promise.all(
              accounts.map(async (account) => ({
                id: account.id,
                label: account.label,
                workspace: account.workspace,
                serverUrl: resolveUrls(account.serverUrl, account.webUrl).rootUrl,
                ready: (await readConfig(account.id)) !== null,
              })),
            );
            if (json) return { exitCode: 0, stdout: JSON.stringify(rows) };
            return {
              exitCode: 0,
              stdout:
                rows.length === 0
                  ? "No accounts are configured."
                  : rows
                      .map(
                        (row) =>
                          `${row.ready ? "✓" : "✗"} ${row.id}\t${row.label}\t${row.workspace === "" ? "(no workspace)" : row.workspace}\t${row.serverUrl}`,
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
