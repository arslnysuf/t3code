import { describe, expect, it } from "@effect/vitest";

import * as EffectAcpErrors from "effect-acp/errors";

import {
  buildMuseAcpSpawnInput,
  currentMuseModelIdFromSessionSetup,
  isMuseSignInRequiredError,
  museAcpRuntimeProcessOwnership,
  museAcpSpawnArgs,
  museApprovalModeForRuntimeMode,
  resolveMuseAcpBaseModelId,
  resolveMuseCliCommand,
} from "./MuseAcpSupport.ts";

describe("museAcpRuntimeProcessOwnership", () => {
  it("opts Muse into detached process-tree ownership on the injected host platform", () => {
    expect(museAcpRuntimeProcessOwnership("linux")).toEqual({
      ownDescendantProcessGroups: true,
      ownDetachedProcessGroup: true,
      processGroupPlatform: "linux",
    });
  });

  it("uses the prior provider-group path on Darwin and Windows", () => {
    expect(museAcpRuntimeProcessOwnership("darwin")).toEqual({
      ownDescendantProcessGroups: false,
      ownDetachedProcessGroup: true,
      processGroupPlatform: "darwin",
    });
    expect(museAcpRuntimeProcessOwnership("win32")).toEqual({
      ownDescendantProcessGroups: false,
      ownDetachedProcessGroup: true,
      processGroupPlatform: "win32",
    });
  });
});

describe("resolveMuseAcpBaseModelId", () => {
  it("defers empty selections to the session model and keeps Muse model ids verbatim", () => {
    expect(resolveMuseAcpBaseModelId(undefined)).toBe("default");
    expect(resolveMuseAcpBaseModelId("   ")).toBe("default");
    expect(resolveMuseAcpBaseModelId("  muse-spark-1.3-contributor  ")).toBe(
      "muse-spark-1.3-contributor",
    );
  });
});

describe("museAcpSpawnArgs", () => {
  it("launches the bare adapter over stdio for every runtime mode", () => {
    expect(museAcpSpawnArgs()).toEqual([]);
  });
});

describe("museApprovalModeForRuntimeMode", () => {
  it("keeps Supervised on the permission-request path", () => {
    expect(museApprovalModeForRuntimeMode("approval-required")).toBe("promptUnmatched");
    expect(museApprovalModeForRuntimeMode("auto-accept-edits")).toBe("promptUnmatched");
  });

  it("keeps Auto on the host default and reserves allow-all for Full Access", () => {
    expect(museApprovalModeForRuntimeMode("auto")).toBe("onRequest");
    expect(museApprovalModeForRuntimeMode("full-access")).toBe("allowAll");
  });
});

describe("buildMuseAcpSpawnInput", () => {
  it("defaults to the PATH command and passes the environment through", () => {
    const spawn = buildMuseAcpSpawnInput(null, "/tmp/project", {
      MUSE_LOG: "debug",
    });

    expect(spawn).toEqual({
      command: "muse-acp",
      args: [],
      cwd: "/tmp/project",
      env: {
        MUSE_LOG: "debug",
      },
    });
  });

  it("honors an explicit binary path, including Windows executable paths", () => {
    const spawn = buildMuseAcpSpawnInput(
      { binaryPath: "C:\\tools\\muse-acp.exe" },
      "C:\\work\\project",
      undefined,
    );

    expect(spawn.command).toBe("C:\\tools\\muse-acp.exe");
    expect(spawn.args).toEqual([]);
    expect(spawn.cwd).toBe("C:\\work\\project");
  });
});

describe("resolveMuseCliCommand", () => {
  it("defaults to muse and honors the adapter's own MUSE_CLI override", () => {
    expect(resolveMuseCliCommand(undefined)).toBe("muse");
    expect(resolveMuseCliCommand({})).toBe("muse");
    expect(resolveMuseCliCommand({ MUSE_CLI: "   " })).toBe("muse");
    expect(resolveMuseCliCommand({ MUSE_CLI: "C:\\tools\\muse.cmd" })).toBe("C:\\tools\\muse.cmd");
  });
});

describe("isMuseSignInRequiredError", () => {
  it("matches only the ACP auth-required signal", () => {
    const authRequired = new EffectAcpErrors.AcpRequestError({
      code: -32000,
      errorMessage: "Authentication required",
    });
    expect(isMuseSignInRequiredError(authRequired)).toBe(true);
    expect(
      isMuseSignInRequiredError(EffectAcpErrors.AcpRequestError.internalError("Internal error")),
    ).toBe(false);
    expect(isMuseSignInRequiredError(new Error("Authentication required"))).toBe(false);
    expect(isMuseSignInRequiredError(null)).toBe(false);
  });
});

describe("currentMuseModelIdFromSessionSetup", () => {
  it("reads the current model from the model config option", () => {
    expect(
      currentMuseModelIdFromSessionSetup({
        sessionId: "session-1",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "muse-spark-1.3-contributor",
            options: [],
          },
        ],
      }),
    ).toBe("muse-spark-1.3-contributor");
    expect(currentMuseModelIdFromSessionSetup({ sessionId: "session-1" })).toBeUndefined();
  });
});
