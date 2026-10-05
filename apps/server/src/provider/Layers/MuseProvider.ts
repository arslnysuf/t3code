import {
  type CustomModelSetting,
  type ModelCapabilities,
  type MuseSettings,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Crypto from "effect/Crypto";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  currentMuseModelIdFromSessionSetup,
  isMuseSignInRequiredError,
  makeMuseAcpRuntime,
  MUSE_ACP_DEFAULT_COMMAND,
  MUSE_SUPPORTED_RUNTIME_MODES,
  resolveMuseAcpBaseModelId,
  resolveMuseCliCommand,
  MUSE_DEFAULT_MODEL_SLUG,
} from "../acp/MuseAcpSupport.ts";
import { acpProviderOptionDescriptors } from "../acp/AcpSessionConfig.ts";
import { parseSessionModeState } from "../acp/AcpRuntimeModel.ts";

const MUSE_PRESENTATION = {
  displayName: "Muse Code",
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
  supportedRuntimeModes: MUSE_SUPPORTED_RUNTIME_MODES,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

// `muse --version` runs through the PowerShell launcher plus a ~450MB binary,
// so under load it can take seconds (1.6s+ observed warm on Windows). The probe
// gates the whole provider, so give it room instead of hard-erroring on a slow
// machine.
const VERSION_PROBE_TIMEOUT_MS = 15_000;
// Discovery boots a disposable `muse serve` host, which is slow on a cold
// start (30s+ observed on Windows), so this is generous. A miss degrades to
// the fallback model instead of failing the provider.
const MUSE_ACP_DISCOVERY_TIMEOUT_MS = 120_000;

const MUSE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: MUSE_DEFAULT_MODEL_SLUG,
    name: "Default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialMuseProviderSnapshot(
  museSettings: MuseSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = museModelsFromSettings(museSettings.customModels);

    if (!museSettings.enabled) {
      return buildServerProvider({
        presentation: MUSE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Muse is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Muse availability...",
      },
    });
  });
}

function museModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = MUSE_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/** Models advertised by the `model` session config option; ACP has no other portable inventory. */
export function buildMuseModelsFromSessionConfig(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  currentModelId: string | undefined,
  capabilities: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = configOptions?.find(
    (option) => option.category === "model" && option.type === "select",
  );
  if (modelOption?.type !== "select") {
    return [];
  }
  const seen = new Set<string>();
  const discovered = modelOption.options.flatMap((entry): ServerProviderModel[] => {
    const choices = "value" in entry ? [entry] : entry.options;
    return choices.flatMap((choice): ServerProviderModel[] => {
      const id = choice.value.trim();
      if (id.length === 0 || seen.has(id)) {
        return [];
      }
      seen.add(id);
      const slug = resolveMuseAcpBaseModelId(id);
      return [
        {
          slug,
          name: choice.name.trim() || slug,
          isCustom: false,
          ...(id === currentModelId ? { isDefault: true } : {}),
          capabilities,
        },
      ];
    });
  });
  // Keep the fallback slug resolvable after discovery: threads and drafts
  // created while discovery was still running hold model "default", and the
  // composer preserves that unavailable selection. Without this row their
  // capabilities resolve empty and the traits menu (approval mode, reasoning
  // effort) disappears. The shared ACP adapter skips "default" on model
  // apply, so this row means "whatever model the session currently runs on".
  if (discovered.length > 0 && !seen.has(MUSE_DEFAULT_MODEL_SLUG)) {
    discovered.push({
      slug: MUSE_DEFAULT_MODEL_SLUG,
      name: "Default",
      isCustom: false,
      capabilities,
    });
  }
  return discovered;
}

const runMuseCliCommand = (
  command: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export interface MuseAcpDiscovery {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly currentModelId: string | undefined;
}

/**
 * Reads model and option metadata from a disposable ACP session. This never
 * sends a prompt, so it cannot run tools; the pre-turn session is not even
 * persisted by Muse. Auth-required surfaces immediately instead of
 * attempting a terminal login.
 */
const discoverMuseMetadataViaAcpSession = (
  museSettings: MuseSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeMuseAcpRuntime({
      museSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      authenticateOnAuthRequired: false,
    });
    const started = yield* acp.start();
    const configOptions = started.sessionSetupResult.configOptions ?? [];
    const capabilities = createModelCapabilities({
      optionDescriptors: acpProviderOptionDescriptors({
        configOptions,
        modeState: parseSessionModeState(started.sessionSetupResult),
      }),
    });
    const currentModelId = currentMuseModelIdFromSessionSetup(started.sessionSetupResult);
    const models = buildMuseModelsFromSessionConfig(configOptions, currentModelId, capabilities);
    return { models, currentModelId } satisfies MuseAcpDiscovery;
  }).pipe(Effect.scoped);

export const checkMuseProviderStatus = Effect.fn("checkMuseProviderStatus")(function* (
  museSettings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
  versionProbeTimeoutMs: number = VERSION_PROBE_TIMEOUT_MS,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = museModelsFromSettings(museSettings.customModels);

  if (!museSettings.enabled) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Muse is disabled in T3 Code settings.",
      },
    });
  }

  const adapterCommand = museSettings.binaryPath || MUSE_ACP_DEFAULT_COMMAND;
  const versionResult = yield* runMuseCliCommand(adapterCommand, ["--version"], environment).pipe(
    Effect.timeoutOption(versionProbeTimeoutMs),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Muse ACP adapter health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "muse-acp is not installed or not on PATH. Install @brokkai/muse-acp or set the Muse binary path."
          : "Failed to execute muse-acp health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "muse-acp is installed but timed out while running `muse-acp --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("muse-acp version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "muse-acp is installed but failed to run.",
      },
    });
  }

  const museCommand = resolveMuseCliCommand(environment);
  const museResult = yield* runMuseCliCommand(museCommand, ["--version"], environment).pipe(
    Effect.timeoutOption(versionProbeTimeoutMs),
    Effect.result,
  );
  if (Result.isFailure(museResult)) {
    const error = museResult.failure;
    const missing = isCommandMissingCause(error);
    yield* Effect.logWarning("Muse CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Muse Code CLI (`muse`) is not installed or not on PATH. Install Muse Code and run `muse login`."
          : "Muse Code CLI is installed but failed to run `muse --version`.",
      },
    });
  }

  if (Option.isNone(museResult.success)) {
    yield* Effect.logWarning("Muse CLI health check timed out.", {
      timeoutMs: versionProbeTimeoutMs,
    });
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Muse Code CLI is installed but timed out while running `muse --version`.",
      },
    });
  }

  const museOutput = museResult.success.value;
  if (museOutput.code !== 0) {
    yield* Effect.logWarning("Muse CLI version probe exited with a non-zero status.", {
      exitCode: museOutput.code,
      stdoutLength: museOutput.stdout.length,
      stderrLength: museOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Muse Code CLI is installed but \`muse --version\` exited with code ${museOutput.code}.`,
      },
    });
  }

  const discoveryResult = yield* discoverMuseMetadataViaAcpSession(museSettings, environment).pipe(
    Effect.timeoutOption(MUSE_ACP_DISCOVERY_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(discoveryResult) && isMuseSignInRequiredError(discoveryResult.failure)) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Muse Code is installed but not logged in. Run `muse login` in a terminal.",
      },
    });
  }

  const discovery =
    Result.isSuccess(discoveryResult) && Option.isSome(discoveryResult.success)
      ? discoveryResult.success.value
      : undefined;
  const discoveredModels = discovery?.models ?? [];
  const models =
    discoveredModels.length > 0
      ? museModelsFromSettings(museSettings.customModels, discoveredModels)
      : fallbackModels;
  const discoveryFailed = discovery === undefined;
  if (discoveryFailed) {
    yield* Effect.logWarning("Muse ACP discovery probe failed or timed out.", {
      errorTag: Result.isFailure(discoveryResult) ? discoveryResult.failure._tag : "Timeout",
    });
  }

  const auth: ServerProviderAuth = !discoveryFailed
    ? { status: "authenticated", type: "cached_token", label: "Muse Code login" }
    : { status: "unknown" };

  return buildServerProvider({
    presentation: MUSE_PRESENTATION,
    enabled: museSettings.enabled,
    checkedAt,
    models,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      // A failed discovery probe degrades the model picker, it does not make chats fail.
      status: discoveryFailed ? "warning" : "ready",
      auth,
      ...(discoveryFailed
        ? {
            message:
              "Muse Code is installed but ACP discovery failed. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichMuseSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Muse version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
