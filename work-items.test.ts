// The work-item surfaces: @-mentions, the ::plane directive's lookup,
// delegation, and the CLI. Plane is faked at the fetch boundary so the paths
// and request bodies this plugin sends are themselves under test — the
// attachment path and the loose key search are both easy to get wrong.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, type FakeSdkOverrides } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const WORKSPACE = "acme";
const ROOT = "https://plane.example.com";
const PROJECT_ID = "project-ga";
const ITEM_ID = "item-724";

const STATES = [
  { id: "state-backlog", name: "Backlog", color: "#60646C", group: "backlog", sequence: 1 },
  { id: "state-doing", name: "In Progress", color: "#F59E0B", group: "started", sequence: 2 },
];

const ITEM = {
  id: ITEM_ID,
  name: "Create Share link skips the share dialog",
  sequence_id: 724,
  priority: "high",
  state: "state-backlog",
  assignees: ["member-1"],
  labels: ["label-bug"],
  start_date: null,
  target_date: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-08T00:00:00Z",
  description_html: "<p>Dragging a file offers two choices.</p>",
};

/** Every Plane request the tests saw, for asserting paths and bodies. */
let seen: { method: string; url: string; body: unknown }[] = [];

/** A second project whose key shares a prefix, to pin down key resolution. */
const SEARCH_HITS = [
  {
    id: ITEM_ID,
    name: ITEM.name,
    sequence_id: 724,
    project__identifier: "GA",
    project_id: PROJECT_ID,
  },
  {
    id: "item-other",
    name: "A GAMI item that merely matches the text",
    sequence_id: 724,
    project__identifier: "GAMI",
    project_id: "project-gami",
  },
];

function fakePlane() {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    seen.push({ method, url, body });
    const path = new URL(url).pathname;

    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if (path.endsWith("/work-items/search/")) return json({ issues: SEARCH_HITS });
    if (path.endsWith(`/projects/`)) {
      return json([{ id: PROJECT_ID, name: "GAMI", identifier: "GA" }]);
    }
    if (path.endsWith(`/projects/${PROJECT_ID}/`)) {
      return json({ id: PROJECT_ID, name: "GAMI", identifier: "GA" });
    }
    if (path.endsWith("/states/")) return json(STATES);
    if (path.endsWith("/labels/")) return json([{ id: "label-bug", name: "BUG", color: "#f00" }]);
    if (path.endsWith("/project-members/")) {
      return json([{ member: { id: "member-1", display_name: "Ada" } }]);
    }
    if (path.endsWith("/issue-attachments/")) {
      return json([
        {
          id: "att-1",
          created_at: "2026-09-08T00:00:00Z",
          attributes: { name: "shot.png", size: 12, type: "image/png" },
        },
      ]);
    }
    if (path.endsWith("/comments/")) {
      if (method === "POST") return json({ id: "c-new", comment_html: "<p>done</p>" });
      return json([
        { id: "c-1", actor: "member-1", created_at: "2026-09-02T00:00:00Z", comment_html: "<p>Seen it.</p>" },
      ]);
    }
    if (path.endsWith(`/work-items/${ITEM_ID}/`)) {
      if (method === "PATCH") return json({ ...ITEM, ...(body as object) });
      return json(ITEM);
    }
    if (path.endsWith("/work-items/")) {
      return json({ results: [ITEM], next_page_results: false });
    }
    return new Response("unhandled", { status: 404 });
  });
}

const SDK: FakeSdkOverrides = {
  projects: { list: async () => [{ id: "proj_bb", name: "Gami" }] },
  threads: {
    spawn: async () => ({ id: "thr_new", title: "GA-724 — seeded", status: "pending" }),
    get: async () => ({ id: "thr_new", title: "GA-724 — renamed", status: "idle" }),
  },
} as FakeSdkOverrides;

async function start() {
  const { bb, harness } = createFakePluginHost({ pluginId: "plane-board", sdk: SDK });
  await plugin(bb);
  await harness.behavior.callRpc("account_save", {
    id: null,
    label: "Work",
    serverUrl: ROOT,
    workspace: WORKSPACE,
    webUrl: "",
    defaultProject: "GA",
    apiKey: "plane_api_test",
  });
  return {
    bb,
    harness,
    call: (method: string, input: unknown) => harness.behavior.callRpc(method, input),
    cli: (argv: string[]) => harness.behavior.runCli(argv),
    mention: harness.inspection.registrations.mentionProviders[0],
  };
}

beforeEach(() => {
  seen = [];
  vi.stubGlobal("fetch", fakePlane());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("key resolution", () => {
  it("ignores a search hit whose project identifier is not the one in the key", async () => {
    const { call } = await start();

    const { card } = (await call("item_by_key", { key: "GA-724" })) as {
      card: { key: string; itemId: string } | null;
    };

    // Both hits have sequence 724; only GA-724 belongs to the GA project.
    expect(card?.itemId).toBe(ITEM_ID);
    expect(card?.key).toBe("GA-724");
  });

  it("answers null for a key no configured workspace has", async () => {
    const { call } = await start();
    expect(await call("item_by_key", { key: "ZZ-1" })).toEqual({ card: null });
  });

  it("answers null for something that is not a key at all", async () => {
    const { call } = await start();
    expect(await call("item_by_key", { key: "not-a-key" })).toEqual({ card: null });
  });
});

describe("mention provider", () => {
  it("offers work items under a composite id that names the account and project", async () => {
    const { mention } = await start();

    const items = await mention!.search({
      trigger: "@",
      query: "share",
      projectId: null,
      threadId: null,
    });

    expect(items[0]).toMatchObject({
      id: `work|${PROJECT_ID}|${ITEM_ID}`,
      title: ITEM.name,
      subtitle: "GA-724",
    });
  });

  it("contributes nothing for an empty query rather than searching", async () => {
    const { mention } = await start();
    const before = seen.length;

    expect(
      await mention!.search({ trigger: "@", query: "  ", projectId: null, threadId: null }),
    ).toEqual([]);
    expect(seen.length).toBe(before);
  });

  it("resolves a picked item into the whole ticket", async () => {
    const { mention } = await start();

    const { context } = await mention!.resolve(`work|${PROJECT_ID}|${ITEM_ID}`);

    expect(context).toContain("# GA-724 — Create Share link skips the share dialog");
    expect(context).toContain("- State: Backlog");
    expect(context).toContain("- Priority: high");
    expect(context).toContain("Dragging a file offers two choices.");
    expect(context).toContain("shot.png");
    expect(context).toContain("Seen it.");
  });

  it("refuses a mention id it did not mint", async () => {
    const { mention } = await start();
    await expect(mention!.resolve("garbage")).rejects.toThrow(/Unrecognized/);
  });
});

describe("attachments", () => {
  it("asks for attachments under /issues/, which is the only path Plane serves", async () => {
    const { call } = await start();
    await call("item_detail", { accountId: "work", projectId: PROJECT_ID, itemId: ITEM_ID });

    const attachmentCall = seen.find((entry) => entry.url.includes("issue-attachments"));
    expect(attachmentCall?.url).toContain(`/projects/${PROJECT_ID}/issues/${ITEM_ID}/`);
    expect(attachmentCall?.url).not.toContain("/work-items/item-724/issue-attachments");
  });
});

describe("delegation", () => {
  it("spawns a thread seeded with the ticket and remembers it", async () => {
    const { call, bb, harness } = await start();

    const { thread } = (await call("item_delegate", {
      accountId: "work",
      projectId: PROJECT_ID,
      itemId: ITEM_ID,
      bbProjectId: "proj_bb",
      instructions: "Reproduce first.",
    })) as { thread: { threadId: string } };

    expect(thread.threadId).toBe("thr_new");
    const [args] = harness.sdk.callsTo("threads.spawn")[0] as [Record<string, string>];
    expect(args.projectId).toBe("proj_bb");
    expect(args.prompt).toContain("# GA-724 —");
    expect(args.prompt).toContain("Reproduce first.");
    expect(await bb.storage.kv.get(`threads:${ITEM_ID}`)).toHaveLength(1);
  });

  it("reports each linked thread's live title and status, not the stored copy", async () => {
    const { call } = await start();
    await call("item_delegate", {
      accountId: "work",
      projectId: PROJECT_ID,
      itemId: ITEM_ID,
      bbProjectId: "proj_bb",
      instructions: "",
    });

    const { threads } = (await call("item_threads", { itemId: ITEM_ID })) as {
      threads: { title: string; status: string }[];
    };

    expect(threads[0]).toMatchObject({ title: "GA-724 — renamed", status: "idle" });
  });

  it("has no threads for a work item nobody delegated", async () => {
    const { call } = await start();
    expect(await call("item_threads", { itemId: "item-none" })).toEqual({ threads: [] });
  });
});

describe("cli", () => {
  it("shows a work item as Markdown", async () => {
    const { cli } = await start();
    const result = await cli(["show", "GA-724"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# GA-724 —");
    expect(result.stdout).toContain("- Labels: BUG");
    expect(result.stdout).toContain("- Assignees: Ada");
  });

  it("posts a comment as the HTML Plane stores", async () => {
    const { cli } = await start();
    const result = await cli(["comment", "GA-724", "Fixed", "and", "deployed"]);

    expect(result.exitCode).toBe(0);
    const post = seen.find((entry) => entry.method === "POST" && entry.url.endsWith("/comments/"));
    expect(post?.body).toEqual({ comment_html: "<p>Fixed and deployed</p>" });
  });

  it("escapes HTML in a comment instead of passing it through", async () => {
    const { cli } = await start();
    await cli(["comment", "GA-724", "<script>alert(1)</script>"]);

    const post = seen.find((entry) => entry.method === "POST" && entry.url.endsWith("/comments/"));
    expect(post?.body).toEqual({
      comment_html: "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    });
  });

  it("rejects an unknown state by name, listing the ones that exist", async () => {
    const { cli } = await start();
    const result = await cli(["update", "GA-724", "--state", "Shipped"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No state 'Shipped'");
    expect(result.stderr).toContain("In Progress");
  });

  it("takes a state group as well as a state name", async () => {
    const { cli } = await start();
    const result = await cli(["update", "GA-724", "--state", "started"]);

    expect(result.exitCode).toBe(0);
    const patch = seen.find((entry) => entry.method === "PATCH");
    expect(patch?.body).toEqual({ state: "state-doing" });
  });

  it("refuses an update that would change nothing", async () => {
    const { cli } = await start();
    const result = await cli(["update", "GA-724"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Nothing to update");
  });

  it("explains a key it cannot find rather than failing blankly", async () => {
    const { cli } = await start();
    const result = await cli(["show", "ZZ-9"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No work item ZZ-9");
  });

  it("says what a key should look like when given something else", async () => {
    const { cli } = await start();
    const result = await cli(["show", "the-login-bug"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Keys look like GA-724");
  });

  it("does not let --json swallow the next argument", async () => {
    const { cli } = await start();
    const result = await cli(["search", "--json", "share"]);

    expect(result.exitCode).toBe(0);
    const search = seen.find((entry) => entry.url.includes("/work-items/search/"));
    expect(search?.url).toContain("search=share");
    expect(JSON.parse(result.stdout ?? "[]")).toHaveLength(2);
  });

  it("requires a BB project before it will delegate, and names the ones there are", async () => {
    const { cli } = await start();
    const result = await cli(["delegate", "GA-724"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("proj_bb (Gami)");
  });
});
