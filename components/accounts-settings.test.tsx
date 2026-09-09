// @vitest-environment jsdom
// The Accounts panel, driven the way a person drives it: click Add account,
// fill the form, save. The RPC layer is faked, so these assert the panel's own
// behavior — what it sends, and what it does with the answer.
import { describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountsSettings } from "./accounts-settings";
import type { BoardAccount } from "@/server";

const saved: BoardAccount = {
  id: "work",
  label: "Work",
  serverUrl: "https://plane.example.com",
  workspace: "acme",
  webUrl: "",
  defaultProject: "",
  hasKey: true,
  ready: true,
};

/**
 * The panel over a small stateful fake: saves and removals change what the next
 * `accounts_list` returns, the way the real backend does. `calls` records what
 * the panel sent.
 */
function mount(initial: BoardAccount[], overrides: Record<string, unknown> = {}) {
  const calls: { method: string; input: unknown }[] = [];
  let accounts = [...initial];
  const log = (method: string, input: unknown) => calls.push({ method, input });

  const slot = renderSlot(
    { component: AccountsSettings },
    {},
    {
      rpc: {
        accounts_list: (input: unknown) => {
          log("accounts_list", input);
          return { accounts, remainingSlots: 5 - accounts.length };
        },
        account_save: (input: unknown) => {
          log("account_save", input);
          const draft = input as { id: string | null };
          accounts =
            draft.id === null
              ? [...accounts, saved]
              : accounts.map((entry) => (entry.id === draft.id ? saved : entry));
          return { account: saved };
        },
        account_remove: (input: unknown) => {
          log("account_remove", input);
          const { accountId } = input as { accountId: string };
          accounts = accounts.filter((entry) => entry.id !== accountId);
          return { removed: true };
        },
        account_test: (input: unknown) => {
          log("account_test", input);
          return { ok: true, message: "Reached acme — 3 projects." };
        },
        ...overrides,
      } as never,
    },
  );
  return { slot, calls };
}

describe("the Accounts panel", () => {
  it("invites a first connection when there are none", async () => {
    mount([]);

    expect(await screen.findByText(/No connections yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add account/i })).toBeTruthy();
  });

  it("sends what the Add account form was filled with, and no id", async () => {
    const user = userEvent.setup();
    const { calls } = mount([]);

    await user.click(await screen.findByRole("button", { name: /Add account/i }));
    await user.type(screen.getByLabelText(/^Name$/i), "Work");
    await user.type(screen.getByLabelText(/Workspace slug/i), "acme");
    await user.clear(screen.getByLabelText(/Server URL/i));
    await user.type(screen.getByLabelText(/Server URL/i), "https://plane.example.com");
    await user.type(screen.getByLabelText(/^API key$/i), "plane_api_secret");
    await user.click(screen.getByRole("button", { name: /^Add account$/i }));

    await waitFor(() => expect(calls.some((call) => call.method === "account_save")).toBe(true));
    expect(calls.find((call) => call.method === "account_save")?.input).toEqual({
      id: null,
      label: "Work",
      serverUrl: "https://plane.example.com",
      workspace: "acme",
      webUrl: "",
      defaultProject: "",
      apiKey: "plane_api_secret",
    });
  });

  it("tests the connection right after saving it", async () => {
    const user = userEvent.setup();
    const { calls } = mount([]);

    await user.click(await screen.findByRole("button", { name: /Add account/i }));
    await user.type(screen.getByLabelText(/^Name$/i), "Work");
    await user.type(screen.getByLabelText(/Workspace slug/i), "acme");
    await user.type(screen.getByLabelText(/^API key$/i), "plane_api_secret");
    await user.click(screen.getByRole("button", { name: /^Add account$/i }));

    await waitFor(() =>
      expect(calls.find((call) => call.method === "account_test")?.input).toEqual({
        accountId: "work",
      }),
    );
    expect(await screen.findByText(/Reached acme/i)).toBeTruthy();
  });

  it("defaults a blank server URL to Plane Cloud", async () => {
    const user = userEvent.setup();
    const { calls } = mount([]);

    await user.click(await screen.findByRole("button", { name: /Add account/i }));
    await user.type(screen.getByLabelText(/^Name$/i), "Cloud");
    await user.type(screen.getByLabelText(/Workspace slug/i), "acme");
    await user.clear(screen.getByLabelText(/Server URL/i));
    await user.type(screen.getByLabelText(/^API key$/i), "k");
    await user.click(screen.getByRole("button", { name: /^Add account$/i }));

    await waitFor(() =>
      expect(
        (calls.find((call) => call.method === "account_save")?.input as { serverUrl: string })
          .serverUrl,
      ).toBe("https://api.plane.so"),
    );
  });

  it("sends a null key when an edit leaves the field blank, so the stored one survives", async () => {
    const user = userEvent.setup();
    const { calls } = mount([saved]);

    await user.click(await screen.findByRole("button", { name: /^Edit$/i }));
    await user.clear(screen.getByLabelText(/^Name$/i));
    await user.type(screen.getByLabelText(/^Name$/i), "Renamed");
    await user.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() =>
      expect(calls.find((call) => call.method === "account_save")?.input).toMatchObject({
        id: "work",
        label: "Renamed",
        apiKey: null,
      }),
    );
  });

  it("asks before removing an account", async () => {
    const user = userEvent.setup();
    const { calls } = mount([saved]);

    await user.click(await screen.findByRole("button", { name: /Remove Work/i }));
    expect(calls.some((call) => call.method === "account_remove")).toBe(false);

    await user.click(screen.getByRole("button", { name: /^Remove$/i }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "account_remove")?.input).toEqual({
        accountId: "work",
      }),
    );
  });

  it("keeps the account when the removal is waved off", async () => {
    const user = userEvent.setup();
    const { calls } = mount([saved]);

    await user.click(await screen.findByRole("button", { name: /Remove Work/i }));
    await user.click(screen.getByRole("button", { name: /^Keep$/i }));

    expect(calls.some((call) => call.method === "account_remove")).toBe(false);
    expect(screen.getByText("Work")).toBeTruthy();
  });

  it("flags an account that has no key", async () => {
    mount([{ ...saved, hasKey: false, ready: false }]);

    expect(await screen.findByText(/no key/i)).toBeTruthy();
  });

  it("reports a failed save instead of closing the form", async () => {
    const user = userEvent.setup();
    const { calls } = mount([], {
      account_save: vi.fn(() => {
        throw new Error("Plane rejected the API key.");
      }),
    });

    await user.click(await screen.findByRole("button", { name: /Add account/i }));
    await user.type(screen.getByLabelText(/^Name$/i), "Work");
    await user.type(screen.getByLabelText(/Workspace slug/i), "acme");
    await user.type(screen.getByLabelText(/^API key$/i), "bad");
    await user.click(screen.getByRole("button", { name: /^Add account$/i }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Plane rejected the API key.",
    );
    expect(screen.getByRole("button", { name: /^Add account$/i })).toBeTruthy();
    expect(calls.some((call) => call.method === "account_test")).toBe(false);
  });

  it("stops offering Add account once every slot is used", async () => {
    const accounts = Array.from({ length: 5 }, (_, index) => ({
      ...saved,
      id: `a${index}`,
      label: `Account ${index}`,
    }));
    mount(accounts);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Add account/i }).hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(screen.getByText(/Every connection slot is in use/i)).toBeTruthy();
  });
});
