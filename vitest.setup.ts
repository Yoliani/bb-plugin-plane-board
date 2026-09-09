// The SDK's app hooks (useRpc, useRealtime, …) resolve through a runtime the BB
// app installs. Tests install the harness's stand-in, which must happen before
// any module imports @get-bb/plugin-sdk/app — hence a setup file.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";

installTestPluginRuntime();

// Vitest runs without Testing Library's globals, so unmounting is ours to do;
// without it every test renders into the previous test's DOM.
afterEach(cleanup);
