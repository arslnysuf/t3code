import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { MuseDriver } from "./MuseDriver.ts";

import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-muse-driver-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Muse must not make an HTTP request")),
    ),
  ),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Muse must not spawn a process"),
);

it.layer(testLayer)("MuseDriver", (it) => {
  it("registers in the built-in driver set", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain("muse");
    expect(MuseDriver.driverKind).toBe("muse");
    expect(MuseDriver.metadata.displayName).toBe("Muse Code");
    expect(MuseDriver.metadata.supportsMultipleInstances).toBe(true);
  });

  it("decodes opt-in defaults", () => {
    expect(MuseDriver.defaultConfig()).toMatchObject({
      enabled: false,
      binaryPath: "muse-acp",
    });
  });

  it.effect("creates a disabled instance without spawning and exposes the adapter", () =>
    Effect.gen(function* () {
      const instance = yield* MuseDriver.create({
        instanceId: ProviderInstanceId.make("muse"),
        displayName: "Muse test",
        enabled: false,
        environment: [],
        config: MuseDriver.defaultConfig(),
      });

      expect(instance.driverKind).toBe("muse");
      expect(instance.orchestrationAdapter).toBeDefined();
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
      const failure = yield* Effect.flip(
        instance.textGeneration.generateThreadTitle(
          {} as unknown as Parameters<typeof instance.textGeneration.generateThreadTitle>[0],
        ),
      );
      expect(failure).toBeInstanceOf(TextGenerationError);
      expect(failure.operation).toBe("generateThreadTitle");
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );
});
