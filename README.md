# bb-plugin-plane-board

A Plane kanban board in BB's sidebar, against Plane Cloud or a self-hosted
instance.

- `lib/plane.ts` — the Plane REST API v1 client: cursor pagination, the
  `X-API-Key` header, and the 429 the 60-requests-per-minute limit produces.
  Server-side only, so the key never reaches the browser.
- `server.ts` — the backend: the account settings, the RPC methods the board
  calls, a five-minute cache of each project's states, labels, and members, a
  `bb plane-board` command for checking a connection, and realtime signals so
  every open board stays current without polling.
- `app.tsx` — the frontend: a **Plane** page in the left sidebar
  (`app.slots.navPanel`), with the account and project in the panel's `subPath`
  so a board is a shareable link.
- `components/board.tsx` — the columns and cards, with native HTML5 drag and
  drop to move a work item between states. Clicking a card opens the preview.
- `components/work-item-preview.tsx` — Plane's peek view as a dialog (a drawer
  on a compact viewport): state, priority, assignees, labels, dates,
  description, and comments.
- `lib/plane-ui.ts` — the presentation rules both share, so a label pill or a
  priority badge reads the same on a card and in the preview.
- `PLUGIN_OVERVIEW.md` — the store listing text: a longer version of
  `bb.description` that the plugin detail page shows under it. See
  [Store listing](#store-listing).

## Setup

Open **Extensions → Plugins → Plane Board** and use the **Accounts** panel:

1. Click **Add account**.
2. Fill in a name, your workspace slug (the first path segment in your Plane
   URL, `https://app.plane.so/<workspace>/`), the server URL — leave it at
   `https://api.plane.so` for Plane Cloud, or point it at your own instance —
   and an API key from Plane → Profile settings → Personal access tokens.
   Default project and Web UI URL are optional.
3. Save. The panel tests the connection straight away and reports what Plane
   said.

Add up to five connections and switch between them from the picker in the
board's header. Editing one leaves its stored key alone unless you type a new
one. Removing one also erases its key.

`maxItems` (how many of the most recently updated work items to fetch, default
200) is shared by every account.

### Where the pieces live

The editable half of an account is in this plugin's kv storage, written only
through the panel. The API key is a `secret` setting, so it stays in the 0600
secrets file and is never put in the database or sent to the browser. Secret
settings have to be declared when the plugin loads and cannot be created on
demand, so the plugin declares a fixed pool of five key slots up front and each
account claims one — which is why five is the ceiling, and why the settings form
lists slots by the account holding them.

### Checking a connection

```
bb plane-board accounts                   # every connection, ✓ when usable
bb plane-board check [--account <id>]     # verify a key reaches its workspace
bb plane-board projects [--account <id>]  # that account's projects
```

`--account` defaults to the first connection that has both a workspace and a
key. Accounts are added and edited in the panel, not from the CLI.

## Tests

```
npm test
```

`server.test.ts` drives the backend through the SDK's fake plugin host — account
creation, key-slot claiming and release, the edit that keeps a stored key, and
the migration off the old settings. `components/accounts-settings.test.tsx`
mounts the Accounts panel with `renderSlot` and drives it the way a person does:
click **Add account**, fill the form, save, confirm a removal.

## Notes on Plane's payloads

- Descriptions and comments are stored as HTML. The server converts them to
  plain text before they reach the browser, so nothing from Plane is ever
  injected as markup. Formatting beyond paragraphs and list bullets is lost —
  that is the trade for not shipping a sanitizer.
- Serializers vary by Plane version. Self-hosted 0.x omits
  `description_stripped` and the `sub_issues_count` / `attachment_count` /
  `link_count` fields, so the board reads `description_html` and shows no
  counts.
- A key can list a project it cannot read. Picking such a project loads an
  error rather than an empty board.

## Keeping the board steady

BB autosaves the settings form as it is typed in, and each save fires
`onChange`. Three things keep that from turning into a flickering board:

- The backend debounces those saves into one `config-changed` signal, separate
  from the `board-changed` signal a write to Plane publishes. Typing a
  workspace slug no longer reloads anyone's cards.
- The frontend debounces both signals again, and ignores any board response
  that is not from its newest request, so overlapping loads cannot land out of
  order.
- The page renders nothing until it knows whether an account is configured,
  and only blanks the columns when the account or project actually changes.

## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the BB
component registry (the full shadcn set, version-matched to your BB install
via the pinned ref in `components.json`):

```
npx shadcn add @bb/select @bb/table
```

Run `npm install` once before `bb plugin build` — the vendored components'
npm deps bundle into your dist. React, and BB-shimmed packages like the
radix portal primitives and `sonner` (`import { toast } from "sonner"`
reaches BB's own toaster), are provided by the BB app at runtime and never
bundled. Every shimmed package is declared in `devDependencies` at the
host's version so those imports typecheck; keep them there (never in
`dependencies`, which would bundle a second copy), and `bb plugin types`
repins them alongside the SDK. Ship `dist/` (npm tarball or committed for
git installs) so people installing your plugin never need npm.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required).
- `bb.app` — frontend entry. Delete it, `app.tsx`, `components/`,
  `hooks/`, and `lib/` for a headless plugin.
- `bb.skills` — skill roots; omitted here, and this plugin ships no
  `skills/` directory. BB surfaces `bb plane-board` to agents through the
  generated plugin-commands skill either way.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; declare `icon` as a BB icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.bb` — supported bb app version range.
- `engines.bbPluginSdk` — the lowest plugin SDK you need (scaffold:
  `>=0.4.47`). BB reads this as a floor, not a ceiling: a later
  SDK in the same major still loads your plugin.
- `dependencies` — every package your source imports that BB does not provide.
  `bb plugin build` inlines them into `dist/`, and git installs resolve this
  list alone, so a build-required package here rather than in
  `devDependencies` is what keeps your plugin installable. `devDependencies`
  is for types and tooling only (BB shims React, the portal primitives, and
  `@get-bb/plugin-sdk` at runtime — never bundle them).

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` and `app.js` / `app.css` /
`app.meta.json`. Each `*.meta.json` stamps SDK major/version,
`artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts.

## Store listing

Two texts describe the plugin in the store. `bb.description` in package.json
is the one-sentence hook on every browse card and the lead paragraph on the
detail page; keep it under about 140 characters. `PLUGIN_OVERVIEW.md` is the
same claim at length, shown in an Overview section under that paragraph.
Rewrite the scaffold's copy for your plugin, and update it whenever
`bb.description` changes, so the two never disagree.

The submission to the public BB Community marketplace requires the file. Keep
it under 4000 characters (aim for 700 to 1800) and use headings, paragraphs,
emphasis, code, blockquotes, lists, thematic breaks, and absolute https links
only — raw HTML, images, tables, footnotes, and task lists are rejected. Do
not open with a `#` title or repeat `bb.description` verbatim; the page
shows both directly above.

## Install

From this directory (`bb plugin new` already ran the install; a fresh clone
needs it):

```
npm install
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload plane-board
```

Or let `bb plugin dev` rebuild and reload on every save.

## Configure

```
bb plugin config plane-board
bb plugin config plane-board set showDone false
bb plugin reload plane-board
```

## Types & API reference

The plugin API ships as the npm package `@get-bb/plugin-sdk`, pinned to an
exact version in `devDependencies` (`0.4.47` — the SDK of the BB
that scaffolded this plugin). After `npm install`, the full surface is on disk
at:

```
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts      # backend
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts  # frontend
```

Your editor and `tsc` resolve `@get-bb/plugin-sdk` there through ordinary node
resolution — no path mapping. These are readable declarations: open them for an
exact signature.

The SDK surface grows with every BB release, so the pin has to track the BB you
actually run:

```
bb plugin types          # sync this plugin's SDK surface to the running BB
bb plugin types --check  # CI: fail when it does not match
```

Ask BB to write plugins for you: the `bb-plugin-authoring` skill documents
the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/get-bb/bb>.
