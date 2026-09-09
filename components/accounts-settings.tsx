// The Accounts panel: add, edit, test, and remove Plane connections.
//
// Rendered as a settings section on the plugin's detail page. Every write goes
// through RPC, so an API key travels to the server and is stored as a secret
// setting — it is never read back into this component. A stored key shows as
// "Saved", and leaving the field blank on an edit keeps it.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { BoardAccount, rpcContract } from "@/server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const CLOUD_URL = "https://api.plane.so";

interface Draft {
  id: string | null;
  label: string;
  serverUrl: string;
  workspace: string;
  webUrl: string;
  defaultProject: string;
  apiKey: string;
}

function emptyDraft(): Draft {
  return {
    id: null,
    label: "",
    serverUrl: CLOUD_URL,
    workspace: "",
    webUrl: "",
    defaultProject: "",
    apiKey: "",
  };
}

function draftFrom(account: BoardAccount): Draft {
  return {
    id: account.id,
    label: account.label,
    serverUrl: account.serverUrl,
    workspace: account.workspace,
    webUrl: account.webUrl,
    defaultProject: account.defaultProject,
    apiKey: "",
  };
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  // The hint sits outside the <label>, or it would be read as part of the
  // field's name rather than as guidance about it.
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground">{label}</span>
        {children}
      </label>
      {hint === undefined ? null : (
        <span className="text-xs text-muted-foreground">{hint}</span>
      )}
    </div>
  );
}

function AccountForm({
  draft,
  isSaving,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  isSaving: boolean;
  onChange: (next: Draft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    onChange({ ...draft, [key]: value });
  const isCloud = draft.serverUrl.trim() === CLOUD_URL || draft.serverUrl.trim() === "";

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="How this connection appears in the board's picker.">
          <Input
            autoFocus
            required
            value={draft.label}
            placeholder="Work"
            onChange={(event) => set("label", event.target.value)}
          />
        </Field>
        <Field label="Workspace slug" hint="The first path segment in your Plane URL.">
          <Input
            required
            value={draft.workspace}
            placeholder="acme"
            onChange={(event) => set("workspace", event.target.value)}
          />
        </Field>
      </div>

      <Field
        label="Server URL"
        hint={
          isCloud
            ? "Plane Cloud. Change this to your own host for a self-hosted instance."
            : "Self-hosted. Use the host you open in the browser."
        }
      >
        <div className="flex gap-2">
          <Input
            value={draft.serverUrl}
            placeholder={CLOUD_URL}
            onChange={(event) => set("serverUrl", event.target.value)}
          />
          {isCloud ? null : (
            <Button type="button" variant="outline" onClick={() => set("serverUrl", CLOUD_URL)}>
              Use Cloud
            </Button>
          )}
        </div>
      </Field>

      <Field
        label={draft.id === null ? "API key" : "API key (leave blank to keep the stored one)"}
        hint="Plane → Profile settings → Personal access tokens. Stored as a secret on the server."
      >
        <Input
          type="password"
          required={draft.id === null}
          value={draft.apiKey}
          placeholder={draft.id === null ? "plane_api_…" : "••••••••"}
          autoComplete="off"
          onChange={(event) => set("apiKey", event.target.value)}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Default project" hint="Identifier, name, or UUID. Optional.">
          <Input
            value={draft.defaultProject}
            placeholder="WEB"
            onChange={(event) => set("defaultProject", event.target.value)}
          />
        </Field>
        <Field label="Web UI URL" hint="Only when the UI is not on the server URL.">
          <Input
            value={draft.webUrl}
            placeholder="(same as server URL)"
            onChange={(event) => set("webUrl", event.target.value)}
          />
        </Field>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isSaving}>
          {draft.id === null ? "Add account" : "Save changes"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AccountRow({
  account,
  test,
  isBusy,
  onEdit,
  onTest,
  onRemove,
}: {
  account: BoardAccount;
  test: { ok: boolean; message: string } | undefined;
  isBusy: boolean;
  onEdit: () => void;
  onTest: () => void;
  onRemove: () => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            account.ready ? "bg-primary" : "bg-muted-foreground",
          )}
        />
        <span className="truncate text-sm font-medium text-foreground">{account.label}</span>
        <span className="truncate text-xs text-muted-foreground">
          {account.workspace === "" ? "no workspace" : account.workspace} ·{" "}
          {account.serverUrl.replace(/^https?:\/\//, "")}
        </span>
        {account.hasKey ? null : (
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
            no key
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onTest} disabled={isBusy}>
            Test
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={isBusy}>
            Edit
          </Button>
          {confirmRemove ? (
            <>
              <Button variant="destructive" size="sm" onClick={onRemove} disabled={isBusy}>
                Remove
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-destructive"
              aria-label={`Remove ${account.label}`}
              onClick={() => setConfirmRemove(true)}
              disabled={isBusy}
            >
              <Icon name="Trash2" className="size-4" />
            </Button>
          )}
        </div>
      </div>
      {test === undefined ? null : (
        <p className={cn("text-xs", test.ok ? "text-muted-foreground" : "text-destructive")}>
          {test.message}
        </p>
      )}
    </li>
  );
}

export function AccountsSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [accounts, setAccounts] = useState<BoardAccount[] | null>(null);
  const [remainingSlots, setRemainingSlots] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; message: string }>>({});

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refresh = useCallback(() => {
    rpc.call("accounts_list").then((result) => {
      setAccounts(result.accounts);
      setRemainingSlots(result.remainingSlots);
    }, report);
  }, [rpc, report]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Another window may have changed a connection.
  useRealtime("config-changed", refresh);

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft === null || isSaving) return;
    setIsSaving(true);
    setError(null);
    rpc
      .call("account_save", {
        id: draft.id,
        label: draft.label,
        serverUrl: draft.serverUrl.trim() === "" ? CLOUD_URL : draft.serverUrl,
        workspace: draft.workspace,
        webUrl: draft.webUrl,
        defaultProject: draft.defaultProject,
        // Blank on an edit means "keep the stored key".
        apiKey: draft.id !== null && draft.apiKey === "" ? null : draft.apiKey,
      })
      .then(
        ({ account }) => {
          setIsSaving(false);
          setDraft(null);
          refresh();
          // Saving is the natural moment to find out the key actually works.
          test(account.id);
        },
        (cause) => {
          setIsSaving(false);
          report(cause);
        },
      );
  };

  const test = (accountId: string) => {
    rpc.call("account_test", { accountId }).then((result) => {
      setTests((current) => ({ ...current, [accountId]: result }));
    }, report);
  };

  const remove = (accountId: string) => {
    rpc.call("account_remove", { accountId }).then(() => {
      setTests((current) => {
        const next = { ...current };
        delete next[accountId];
        return next;
      });
      refresh();
    }, report);
  };

  if (accounts === null) return null;

  return (
    <div className="flex flex-col gap-3">
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {accounts.length === 0 && draft === null ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No connections yet. Add one to see a board.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              test={tests[account.id]}
              isBusy={isSaving}
              onEdit={() => setDraft(draftFrom(account))}
              onTest={() => test(account.id)}
              onRemove={() => remove(account.id)}
            />
          ))}
        </ul>
      )}

      {draft === null ? (
        <div className="flex items-center gap-2">
          <Button onClick={() => setDraft(emptyDraft())} disabled={remainingSlots === 0}>
            <Icon name="Plus" className="size-4" />
            Add account
          </Button>
          <span className="text-xs text-muted-foreground">
            {remainingSlots === 0
              ? "Every connection slot is in use. Remove one to add another."
              : `${remainingSlots} slot${remainingSlots === 1 ? "" : "s"} left.`}
          </span>
        </div>
      ) : (
        <AccountForm
          draft={draft}
          isSaving={isSaving}
          onChange={setDraft}
          onSubmit={save}
          onCancel={() => {
            setDraft(null);
            setError(null);
          }}
        />
      )}
    </div>
  );
}
