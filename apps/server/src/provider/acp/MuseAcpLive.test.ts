// @effect-diagnostics nodeBuiltinImport:off - gates the live probe on a local CLI check.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeMuseAcpRuntime } from "./MuseAcpSupport.ts";

/**
 * Opt-in live handshake test. It only runs with `T3_LIVE_MUSE=1` and a
 * resolvable `muse-acp`, performs `initialize` alone (no session, no prompt,
 * no side effects), and stays skipped in normal runs.
 */
const resolveLiveMuse = (): boolean => {
  if (process.env.T3_LIVE_MUSE !== "1") return false;
  try {
    NodeChildProcess.execFileSync("muse-acp", ["--version"], {
      stdio: "pipe",
      shell: HostProcessPlatform.defaultValue() === "win32",
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
};

const liveMuseEnabled = resolveLiveMuse();

it.layer(NodeServices.layer)("live muse-acp", (it) => {
  it.effect.skipIf(!liveMuseEnabled)("rediscovers the live muse-acp handshake", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const acp = yield* makeMuseAcpRuntime({
        museSettings: null,
        environment: process.env,
        childProcessSpawner,
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-live-probe", version: "0.0.0" },
      });
      const initialized = yield* acp.initialize();
      expect(initialized.agentInfo?.name).toBe("muse-acp");
      expect(initialized.agentCapabilities?.loadSession).toBe(true);
    }).pipe(Effect.scoped),
  );
});
