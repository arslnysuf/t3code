import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { MuseSettings } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { acpProviderOptionDescriptors } from "../acp/AcpSessionConfig.ts";
import {
  buildInitialMuseProviderSnapshot,
  buildMuseModelsFromSessionConfig,
  checkMuseProviderStatus,
} from "./MuseProvider.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeMuseSettings = Schema.decodeSync(MuseSettings);

// Live capture from `muse-acp 0.9.0` + `Muse Code 1.4.2`, with the
// machine-specific terminal-auth command sanitized. This is the exact shape
// discovery must parse: models AND reasoning tiers arrive as `configOptions`.
const MUSE_ACP_INITIALIZE_FIXTURE = {
  protocolVersion: 1,
  authMethods: [
    {
      id: "muse-login",
      name: "Log in with Muse",
      description: "Run `muse login` in a terminal and approve the code in your browser",
      type: "terminal",
      args: ["login"],
      _meta: {
        "terminal-auth": {
          label: "Log in with Muse",
          command: "muse-acp",
          args: ["login"],
        },
      },
    },
  ],
  agentCapabilities: {
    promptCapabilities: { text: true, image: true, audio: false, embeddedContext: true },
    mcpCapabilities: { http: true, sse: false },
    loadSession: true,
    sessionCapabilities: {
      list: {},
      resume: {},
      close: {},
      fork: {},
      subagents: {},
      additionalDirectories: {},
    },
  },
  agentInfo: { name: "muse-acp", title: "Muse ACP", version: "0.9.0" },
};

const MUSE_ACP_CONFIG_OPTIONS_FIXTURE = [
  {
    id: "mode",
    name: "Approval Mode",
    description: "Muse approval enforcement mode for tool actions",
    category: "mode",
    type: "select",
    currentValue: "onRequest",
    options: [
      { value: "allowAll", name: "Allow all", description: "Allow everything" },
      {
        value: "promptUnmatched",
        name: "Prompt unmatched",
        description: "Prompt on unmatched subjects",
      },
      { value: "onRequest", name: "On request", description: "Approve only on request" },
      { value: "denyUnmatched", name: "Deny unmatched", description: "Deny unmatched subjects" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "muse-spark-1.3-contributor",
    options: [
      { value: "muse-spark-1.3", name: "muse-spark-1.3" },
      { value: "muse-spark-1.3-contributor", name: "muse-spark-1.3-contributor" },
      { value: "muse-spark-1.2", name: "muse-spark-1.2" },
      { value: "muse-spark-1.2-contributor", name: "muse-spark-1.2-contributor" },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning Effort",
    description:
      "Muse reasoning effort for this session; Muse default keeps the tier configured in Muse",
    category: "thought_level",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Muse default" },
      { value: "none", name: "None" },
      { value: "minimal", name: "Minimal" },
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "xhigh", name: "Extra High" },
      { value: "max", name: "Max" },
      { value: "ultra", name: "Ultra" },
    ],
  },
] as const;

const MUSE_ACP_SESSION_NEW_FIXTURE = {
  sessionId: "mock-muse-session-1",
  _meta: { mspSessionId: "mock-muse-session-1" },
  configOptions: MUSE_ACP_CONFIG_OPTIONS_FIXTURE,
  modes: {
    currentModeId: "onRequest",
    availableModes: [
      { id: "allowAll", name: "Allow all", description: "Allow everything" },
      {
        id: "promptUnmatched",
        name: "Prompt unmatched",
        description: "Prompt on unmatched subjects",
      },
      { id: "onRequest", name: "On request", description: "Approve only on request" },
      { id: "denyUnmatched", name: "Deny unmatched", description: "Deny unmatched subjects" },
    ],
  },
};

const MUSE_ACP_VERSION_OUTPUT = "muse-acp 0.9.0\n";
const MUSE_VERSION_OUTPUT = "Muse Code 1.4.2 (1.4.2-R4684.1)\n";

// Serializes fixture payloads into fake-CLI stub source. The JSON is code
// generation for the stub, not unknown data being parsed.
const stubJson = (value: unknown): string => JSON.stringify(value);

/** Fake `muse-acp`: `--version` prints canned text, otherwise it speaks minimal ACP. */
const museAcpAgentSource = (sessionNewResponse: string) =>
  [
    'if (process.argv[2] === "--version") {',
    `  process.stdout.write(${stubJson(MUSE_ACP_VERSION_OUTPUT)});`,
    "  process.exit(0);",
    "}",
    "const { createInterface } = await import('node:readline');",
    `const initializeResult = ${stubJson(MUSE_ACP_INITIALIZE_FIXTURE)};`,
    `const sessionNewResult = ${sessionNewResponse};`,
    "const rl = createInterface({ input: process.stdin });",
    'rl.on("line", (line) => {',
    "  if (!line.trim()) return;",
    "  const msg = JSON.parse(line);",
    '  const result = msg.method === "initialize" ? initializeResult : msg.method === "session/new" ? sessionNewResult : undefined;',
    "  if (result === undefined) {",
    '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }) + "\\n");',
    "    return;",
    "  }",
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");',
    "});",
    "",
  ].join("\n");

/** Fake `muse-acp` whose session setup fails with an ACP auth-required error. */
const museAcpAuthRequiredSource = [
  'if (process.argv[2] === "--version") {',
  `  process.stdout.write(${stubJson(MUSE_ACP_VERSION_OUTPUT)});`,
  "  process.exit(0);",
  "}",
  "const { createInterface } = await import('node:readline');",
  `const initializeResult = ${stubJson(MUSE_ACP_INITIALIZE_FIXTURE)};`,
  "const rl = createInterface({ input: process.stdin });",
  'rl.on("line", (line) => {',
  "  if (!line.trim()) return;",
  "  const msg = JSON.parse(line);",
  '  if (msg.method === "initialize") {',
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: initializeResult }) + "\\n");',
  "    return;",
  "  }",
  '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Muse host unavailable: authentication required. Run `muse login` in a terminal." } }) + "\\n");',
  "});",
  "",
].join("\n");

/** Fake `muse-acp` that dies as soon as ACP starts instead of speaking the protocol. */
const museAcpBrokenSource = [
  'if (process.argv[2] === "--version") {',
  `  process.stdout.write(${stubJson(MUSE_ACP_VERSION_OUTPUT)});`,
  "  process.exit(0);",
  "}",
  'process.stderr.write("not an acp agent\\n");',
  "process.exit(3);",
  "",
].join("\n");

const museCliSource = [
  'if (process.argv[2] === "--version") {',
  `  process.stdout.write(${stubJson(MUSE_VERSION_OUTPUT)});`,
  "  process.exit(0);",
  "}",
  "process.exit(1);",
  "",
].join("\n");

const writeFakeMusePair = (sessionNewResponse: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-muse-probe-" });
    const museAcpPath = writeFakeCli({
      directory: dir,
      name: "muse-acp",
      source: museAcpAgentSource(sessionNewResponse),
    });
    const musePath = writeFakeCli({ directory: dir, name: "muse", source: museCliSource });
    return { dir, museAcpPath, musePath };
  });

describe("buildMuseModelsFromSessionConfig", () => {
  it("builds models from the live model selector, marking the session model default", () => {
    const models = buildMuseModelsFromSessionConfig(
      MUSE_ACP_CONFIG_OPTIONS_FIXTURE,
      "muse-spark-1.3-contributor",
      createModelCapabilities({ optionDescriptors: [] }),
    );
    expect(models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      ["muse-spark-1.3", false],
      ["muse-spark-1.3-contributor", true],
      ["muse-spark-1.2", false],
      ["muse-spark-1.2-contributor", false],
      ["default", false],
    ]);
    expect(models.every((model) => model.isCustom === false)).toBe(true);
  });

  it("keeps the fallback slug resolvable with discovered capabilities", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = buildMuseModelsFromSessionConfig(
      MUSE_ACP_CONFIG_OPTIONS_FIXTURE,
      "muse-spark-1.3-contributor",
      capabilities,
    );
    const fallback = models.find((model) => model.slug === "default");
    expect(fallback?.name).toBe("Default");
    expect(fallback?.isDefault).toBeUndefined();
    expect(fallback?.capabilities).toBe(capabilities);
  });

  it("returns no models when the agent exposes no model selector", () => {
    expect(
      buildMuseModelsFromSessionConfig(
        [],
        undefined,
        createModelCapabilities({ optionDescriptors: [] }),
      ),
    ).toEqual([]);
  });
});

describe("muse session option descriptors", () => {
  it("surfaces approval mode and reasoning effort while the model stays on the picker", () => {
    const descriptors = acpProviderOptionDescriptors({
      configOptions: MUSE_ACP_CONFIG_OPTIONS_FIXTURE,
      modeState: undefined,
    });
    expect(descriptors.map((descriptor) => descriptor.id).sort()).toEqual([
      "mode",
      "reasoning_effort",
    ]);
    const reasoning = descriptors.find((descriptor) => descriptor.id === "reasoning_effort");
    expect(reasoning?.type).toBe("select");
    if (reasoning?.type !== "select") throw new Error("expected a select descriptor");
    expect(reasoning.options.map((option) => option.id)).toContain("ultra");
    expect(reasoning.currentValue).toBe("default");
  });
});

describe("buildInitialMuseProviderSnapshot", () => {
  it.effect("reports disabled without probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialMuseProviderSnapshot(
        decodeMuseSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.message).toBe("Muse is disabled in T3 Code settings.");
    }),
  );

  it.effect("reports checking while the live probe runs", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialMuseProviderSnapshot(
        decodeMuseSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toBe("Checking Muse availability...");
    }),
  );
});

it.layer(NodeServices.layer)("checkMuseProviderStatus", (it) => {
  it.effect("reports disabled without spawning", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkMuseProviderStatus(decodeMuseSettings({ enabled: false }));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.message).toBe("Muse is disabled in T3 Code settings.");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    }),
  );

  it.effect("reports a distinct error when muse-acp is missing", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-muse-missing-" });
          return yield* checkMuseProviderStatus(
            decodeMuseSettings({ enabled: true, binaryPath: `${dir}/muse-acp` }),
          );
        }),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("muse-acp is not installed");
    }),
  );

  it.effect("reports a distinct error when the Muse CLI is missing", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-muse-nomuse-" });
          const museAcpPath = writeFakeCli({
            directory: dir,
            name: "muse-acp",
            source: museCliSource.replaceAll(
              stubJson(MUSE_VERSION_OUTPUT),
              stubJson(MUSE_ACP_VERSION_OUTPUT),
            ),
          });
          return yield* checkMuseProviderStatus(
            decodeMuseSettings({ enabled: true, binaryPath: museAcpPath }),
            { ...process.env, MUSE_CLI: `${dir}/no-such-muse` },
          );
        }),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.9.0");
      expect(snapshot.message).toContain("Muse Code CLI (`muse`) is not installed");
    }),
  );

  it.effect("reports ready with discovered models, modes, and reasoning tiers", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const { museAcpPath, musePath } = yield* writeFakeMusePair(
            stubJson(MUSE_ACP_SESSION_NEW_FIXTURE),
          );
          return yield* checkMuseProviderStatus(
            decodeMuseSettings({ enabled: true, binaryPath: museAcpPath }),
            { ...process.env, MUSE_CLI: musePath },
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("0.9.0");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "Muse Code login",
      });
      expect(snapshot.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
        ["muse-spark-1.3", false],
        ["muse-spark-1.3-contributor", true],
        ["muse-spark-1.2", false],
        ["muse-spark-1.2-contributor", false],
        ["default", false],
      ]);
      const descriptors =
        snapshot.models[0]?.capabilities?.optionDescriptors?.map((option) => option.id).sort() ??
        [];
      expect(descriptors).toEqual(["mode", "reasoning_effort"]);
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact"]);
    }),
  );

  it.effect("reports unauthenticated with a login hint when the session requires auth", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-muse-auth-" });
          const museAcpPath = writeFakeCli({
            directory: dir,
            name: "muse-acp",
            source: museAcpAuthRequiredSource,
          });
          const musePath = writeFakeCli({ directory: dir, name: "muse", source: museCliSource });
          return yield* checkMuseProviderStatus(
            decodeMuseSettings({ enabled: true, binaryPath: museAcpPath }),
            { ...process.env, MUSE_CLI: musePath },
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.version).toBe("0.9.0");
      expect(snapshot.auth).toEqual({ status: "unauthenticated" });
      expect(snapshot.message).toContain("muse login");
    }),
  );

  it.effect("degrades to the fallback model with a warning when discovery fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-muse-broken-" });
          const museAcpPath = writeFakeCli({
            directory: dir,
            name: "muse-acp",
            source: museAcpBrokenSource,
          });
          const musePath = writeFakeCli({ directory: dir, name: "muse", source: museCliSource });
          return yield* checkMuseProviderStatus(
            decodeMuseSettings({ enabled: true, binaryPath: museAcpPath }),
            { ...process.env, MUSE_CLI: musePath },
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth).toEqual({ status: "unknown" });
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
      expect(snapshot.message).toContain("ACP discovery failed");
    }),
  );
});
