// Account bookkeeping: the part with rules worth pinning down. Nothing here
// reaches Plane — every test account keeps an unusable key on purpose.
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { KEY_SLOTS, MAX_ACCOUNTS, type StoredAccount } from "./lib/accounts";
import plugin from "./server";

async function start(settings: Record<string, string | number | boolean> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "plane-board", settings });
  await plugin(bb);
  const call = (method: string, input: unknown) => harness.behavior.callRpc(method, input);
  const accounts = () => bb.storage.kv.get<StoredAccount[]>("accounts");
  return { bb, harness, call, accounts };
}

const draft = (overrides: Record<string, unknown> = {}) => ({
  id: null,
  label: "Work",
  serverUrl: "https://plane.example.com",
  workspace: "acme",
  webUrl: "",
  defaultProject: "",
  apiKey: "plane_api_test",
  ...overrides,
});

describe("accounts", () => {
  it("creates an account, claims the first key slot, and keeps the key out of the reply", async () => {
    const { call, accounts } = await start();

    const { account } = (await call("account_save", draft())) as {
      account: Record<string, unknown>;
    };

    expect(account).toMatchObject({ id: "work", label: "Work", hasKey: true, ready: true });
    expect(JSON.stringify(account)).not.toContain("plane_api_test");
    expect((await accounts())?.[0]?.keySetting).toBe(KEY_SLOTS[0]);
  });

  it("gives each account its own key slot", async () => {
    const { call, accounts } = await start();
    await call("account_save", draft({ label: "One" }));
    await call("account_save", draft({ label: "Two" }));

    expect((await accounts())?.map((entry) => entry.keySetting)).toEqual([
      KEY_SLOTS[0],
      KEY_SLOTS[1],
    ]);
  });

  it("keeps ids unique when two accounts share a name", async () => {
    const { call } = await start();
    await call("account_save", draft({ label: "Work" }));
    const { account } = (await call("account_save", draft({ label: "Work" }))) as {
      account: { id: string };
    };

    expect(account.id).toBe("work_2");
  });

  it("leaves the stored key alone when an edit sends none", async () => {
    const { call } = await start();
    const created = (await call("account_save", draft())) as { account: { id: string } };

    const { account } = (await call(
      "account_save",
      draft({ id: created.account.id, label: "Renamed", workspace: "other", apiKey: null }),
    )) as { account: Record<string, unknown> };

    expect(account).toMatchObject({
      id: "work",
      label: "Renamed",
      workspace: "other",
      hasKey: true,
    });
  });

  it("clears the key when an edit sends an empty one", async () => {
    const { call } = await start();
    await call("account_save", draft());

    const { account } = (await call("account_save", draft({ id: "work", apiKey: "" }))) as {
      account: Record<string, unknown>;
    };

    expect(account).toMatchObject({ hasKey: false, ready: false });
  });

  it("is not ready without a workspace", async () => {
    const { call } = await start();
    const { account } = (await call("account_save", draft({ workspace: "" }))) as {
      account: Record<string, unknown>;
    };

    expect(account).toMatchObject({ hasKey: true, ready: false });
  });

  it("releases the key slot when an account is removed", async () => {
    const { call, accounts, bb } = await start();
    await call("account_save", draft({ label: "One" }));
    await call("account_save", draft({ label: "Two" }));

    await call("account_remove", { accountId: "one" });

    expect(await call("account_remove", { accountId: "one" })).toEqual({ removed: false });
    expect((await accounts())?.map((entry) => entry.id)).toEqual(["two"]);
    // The freed slot is empty, so the next account can claim it.
    await call("account_save", draft({ label: "Three" }));
    const remaining = await accounts();
    expect(remaining?.find((entry) => entry.id === "three")?.keySetting).toBe(KEY_SLOTS[0]);
    expect(bb.pluginId).toBe("plane-board");
  });

  it("refuses more accounts than there are key slots", async () => {
    const { call } = await start();
    for (let index = 0; index < MAX_ACCOUNTS; index++) {
      await call("account_save", draft({ label: `Account ${index}` }));
    }

    await expect(call("account_save", draft({ label: "One too many" }))).rejects.toThrow(
      /at most/,
    );
  });

  it("reports how many slots are left", async () => {
    const { call } = await start();
    await call("account_save", draft());

    expect(await call("accounts_list", null)).toMatchObject({
      remainingSlots: MAX_ACCOUNTS - 1,
    });
  });

  it("migrates the old Accounts JSON setting into storage once", async () => {
    const { accounts } = await start({
      accounts: JSON.stringify([
        {
          id: "default",
          label: "Plane",
          serverUrl: "https://plane.example.com",
          workspace: "acme",
          webUrl: "",
          defaultProject: "WEB",
        },
      ]),
      // The old scheme stored the first account's key under this same name.
      apiKey: "plane_api_migrated",
    });

    expect(await accounts()).toEqual([
      {
        id: "default",
        label: "Plane",
        serverUrl: "https://plane.example.com",
        workspace: "acme",
        webUrl: "",
        defaultProject: "WEB",
        keySetting: KEY_SLOTS[0],
      },
    ]);
  });

  it("reports a bad account id rather than inventing one", async () => {
    const { call } = await start();
    await expect(call("account_save", draft({ id: "nope" }))).rejects.toThrow(/No account/);
  });
});
