import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type MuseSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/** Default `muse-acp` command; the instance `binaryPath` setting overrides it. */
export const MUSE_ACP_DEFAULT_COMMAND = "muse-acp";
/** Env var `muse-acp` itself honors to locate the Muse Code CLI. */
const MUSE_CLI_ENV = "MUSE_CLI";
/** Default Muse Code CLI command, probed to tell "adapter missing" from "Muse missing". */
const MUSE_DEFAULT_COMMAND = "muse";
/** ACP auth-required error code (spec): the signal for "Muse is not logged in". */
const ACP_AUTH_REQUIRED_CODE = -32000;

const MUSE_DRIVER_KIND = ProviderDriverKind.make("muse");

type MuseAcpRuntimeMuseSettings = Pick<MuseSettings, "binaryPath">;

interface MuseAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly museSettings: MuseAcpRuntimeMuseSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * The runtime modes T3 offers for Muse. `muse-acp` exposes approval posture
 * as the session `mode` config option instead of launch flags, so every mode
 * launches identically and the adapter selects the posture per policy.
 * `auto-accept-edits` has no Muse equivalent and is not offered.
 */
export const MUSE_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

/**
 * Launch argv for `muse-acp`. A bare binary speaks ACP over stdio (verified
 * against `muse-acp --help`); subcommands are only for setup utilities.
 */
export function museAcpSpawnArgs(): ReadonlyArray<string> {
  return [];
}

export function buildMuseAcpSpawnInput(
  museSettings: MuseAcpRuntimeMuseSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: museSettings?.binaryPath || MUSE_ACP_DEFAULT_COMMAND,
    args: [...museAcpSpawnArgs()],
    cwd,
    env: {
      ...environment,
    },
  };
}

/**
 * Maps a T3 runtime policy onto the `muse-acp` session approval `mode`
 * (verified against a live `session/new`: allowAll, promptUnmatched,
 * onRequest, denyUnmatched). Supervised keeps every unmatched tool call on
 * the `session/request_permission` path so T3's approval UI stays in charge;
 * only an explicit Full Access policy selects `allowAll`.
 */
export function museApprovalModeForRuntimeMode(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "full-access":
      return "allowAll";
    case "auto":
      return "onRequest";
    case "approval-required":
    case "auto-accept-edits":
      return "promptUnmatched";
  }
}

export const MUSE_SERVE_ARGS_ENV = "MUSE_SERVE_ARGS";

// Host-lifetime equivalent of the CLI's `--yolo` sandbox half for `muse serve`
// (serve exposes no --yolo flag): no sandbox plus trusted workspace
// skills/rules. Approval selection stays on the wire via the session mode.
const MUSE_FULL_ACCESS_SERVE_ARGS = "--disable-sandbox --trust-workspace";

/**
 * Full Access runs the Muse host unsandboxed. Sandbox posture is fixed when
 * the host spawns, so this merges the flags into the adapter spawn
 * environment. An explicit user-provided sandbox posture always wins.
 */
export function museServeArgsForRuntimeMode(
  runtimeMode: RuntimeMode,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (museApprovalModeForRuntimeMode(runtimeMode) !== "allowAll") return environment;
  const existing = environment[MUSE_SERVE_ARGS_ENV]?.trim() ?? "";
  if (existing.toLowerCase().includes("sandbox")) return environment;
  return {
    ...environment,
    [MUSE_SERVE_ARGS_ENV]: [existing, MUSE_FULL_ACCESS_SERVE_ARGS]
      .filter((part) => part.length > 0)
      .join(" "),
  };
}

/** Whether the given runtime mode spawns the Muse host unsandboxed. */
export function museSandboxDisabledForRuntimeMode(runtimeMode: RuntimeMode): boolean {
  return museApprovalModeForRuntimeMode(runtimeMode) === "allowAll";
}

/** Whether crossing between two runtime modes changes the host sandbox posture. */
export function museRuntimeRestartRequiredForPolicyChange(
  previousRuntimeMode: RuntimeMode,
  nextRuntimeMode: RuntimeMode,
): boolean {
  return (
    museSandboxDisabledForRuntimeMode(previousRuntimeMode) !==
    museSandboxDisabledForRuntimeMode(nextRuntimeMode)
  );
}

export function museAcpRuntimeProcessOwnership(
  processGroupPlatform: NodeJS.Platform,
): Pick<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "ownDescendantProcessGroups" | "ownDetachedProcessGroup" | "processGroupPlatform"
> {
  return {
    // Same conservative default as Grok until Muse's nested detached tool
    // groups are characterized on macOS/Windows.
    ownDescendantProcessGroups: processGroupPlatform === "linux",
    ownDetachedProcessGroup: true,
    processGroupPlatform,
  };
}

export const makeMuseAcpRuntime = (
  input: MuseAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const processGroupPlatform = yield* HostProcessPlatform.pipe(
      Effect.provide(NodeServices.layer),
    );
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildMuseAcpSpawnInput(input.museSettings, input.cwd, input.environment),
        ...museAcpRuntimeProcessOwnership(processGroupPlatform),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * T3's built-in Muse slug. It is not a model id the ACP accepts, so
 * selecting it means "use whatever model the Muse session currently runs
 * on" (the shared adapter skips `default` on apply).
 */
export const MUSE_DEFAULT_MODEL_SLUG = "default";

export function resolveMuseAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : MUSE_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, MUSE_DRIVER_KIND) ?? MUSE_DEFAULT_MODEL_SLUG;
}

/** True when an ACP failure means Muse Code is not logged in. */
export function isMuseSignInRequiredError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly _tag?: unknown })._tag === "AcpRequestError" &&
    (error as { readonly code?: unknown }).code === ACP_AUTH_REQUIRED_CODE
  );
}

/** Resolves the `muse` command `muse-acp` will launch, honoring `MUSE_CLI`. */
export function resolveMuseCliCommand(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[MUSE_CLI_ENV]?.trim() || MUSE_DEFAULT_COMMAND;
}

export function currentMuseModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const modelOption = sessionSetupResult.configOptions?.find(
    (option) => option.category === "model" && option.type === "select",
  );
  return modelOption?.type === "select" ? modelOption.currentValue.trim() || undefined : undefined;
}
