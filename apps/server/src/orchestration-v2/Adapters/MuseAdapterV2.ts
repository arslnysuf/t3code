import { makeProviderFailure } from "../ProviderFailure.ts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  MuseSettings,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ServerConfig from "../../config.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import {
  makeMuseAcpRuntime,
  museApprovalModeForRuntimeMode,
  resolveMuseAcpBaseModelId,
} from "../../provider/acp/MuseAcpSupport.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderContinuationRequests from "../ProviderContinuationRequests.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

const MUSE_PROVIDER = ProviderDriverKind.make("muse");
const MUSE_DRIVER_KIND = MUSE_PROVIDER;
const DEFAULT_MUSE_SETTINGS = Schema.decodeSync(MuseSettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const MuseProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    // Approval posture is a plain session config option, so runtime-mode
    // switches apply to the live session. Model switching, thread
    // load/fork, MCP tools, and conversation snapshots negotiate from the
    // live agent capabilities in the shared core.
    supportsRuntimeModeSwitchInSession: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface MuseAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: MuseSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly selfInvocation: SelfInvocation;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

function makeMuseAcpAdapterFlavor(options: MuseAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: MUSE_PROVIDER,
    runtimeHarness: "Muse Code",
    capabilities: MuseProviderCapabilitiesV2,
    resolveModelId: (selection) => resolveMuseAcpBaseModelId(selection.model),
    // Model selection rides the shared path: the `model` config option is
    // applied via `session/set_config_option`, and option selections such as
    // `reasoning_effort` apply the same way with graceful degradation.
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy: _runtimePolicy, ...input }) =>
        makeMuseAcpRuntime({
          ...input,
          museSettings: options.settings,
          environment: options.environment,
          childProcessSpawner: options.childProcessSpawner,
        })),
    sessionModeForPolicy: (policy) => museApprovalModeForRuntimeMode(policy.runtimeMode),
    promptFailure: (cause) =>
      makeProviderFailure({
        cause,
        ...(isAcpRequestError(cause)
          ? {
              // Muse's own failure text rides on the cause; makeProviderFailure
              // redacts and bounds it before it reaches the user.
              message: cause.errorMessage,
              code: String(cause.code),
              class: "provider_error",
            }
          : { class: "provider_error" }),
      }),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

function makeMuseAdapterV2(options: MuseAdapterV2Options) {
  const flavor = makeMuseAcpAdapterFlavor(options);
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor,
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
}

export type MuseAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const MuseAdapterV2Driver: ProviderAdapterDriver<MuseSettings, MuseAdapterV2DriverEnv> = {
  driverKind: MUSE_DRIVER_KIND,
  configSchema: MuseSettings,
  defaultConfig: (): MuseSettings => DEFAULT_MUSE_SETTINGS,
  create: Effect.fn("MuseAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<MuseSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const selfInvocation = yield* resolveSelfInvocation();
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return makeMuseAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        childProcessSpawner,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        selfInvocation,
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: MUSE_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: MUSE_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Muse ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
