# Muse Code

T3 Code can use your existing Muse Code installation through the
[`muse-acp`](https://github.com/BrokkAi/muse-acp) ACP adapter while keeping Muse's
own models, subscription authentication, session engine, and approval flow. T3 Code
talks to `muse-acp` over the Agent Client Protocol; `muse-acp` talks to Muse over
its native Muse Session Protocol. Requests are not routed through OpenRouter, and
T3 Code never asks for a Meta API key.

## Set Up Muse Code

1. Install Muse Code on the machine running the T3 Code server, then log in once
   in a terminal:
   ```sh
   muse login
   ```
2. Install the adapter (Node.js 22+):
   ```sh
   npm install -g @brokkai/muse-acp
   ```
3. Verify both binaries:
   ```powershell
   muse --version
   muse-acp --version
   muse-acp --selftest
   ```
4. Open T3 Code Settings, enable Muse Code, and refresh the provider.

`muse-acp` 0.9.0 with Muse Code 1.4.3 is the verified combination. If `muse-acp`
is not on the server's `PATH`, set the Muse binary path to the executable
(for example the adapter's native `muse-acp.exe`). If `muse` itself lives
outside `PATH`, point the `MUSE_CLI` provider environment variable at it.

## What Carries Over

T3 Code discovers the models `muse-acp` reports (such as
`muse-spark-1.3-contributor`) and exposes the advertised reasoning tiers —
Muse default, None, Minimal, Low, Medium, High, Extra High, Max, and Ultra —
without overriding your configured default until you pick one. The current Muse
model is marked as the default in the picker.

Threads use durable Muse session IDs, so reopening a thread resumes the same
native conversation, including forks. Switching providers uses portable
conversation context. The composer context meter follows Muse's own usage
reporting while a response streams and after it settles.

## Permission Modes

T3 Code applies the composer permission mode through Muse's approval mode:

- **Supervised** prompts before unmatched tool actions; requests appear in T3
  Code's normal approval UI.
- **Auto** keeps Muse's default approval posture.
- **Full access** allows tool actions without approval prompts.

Auto-accept edits is not offered because Muse exposes no edits-only posture;
it behaves as Supervised when stored. The mode can be switched on the live
session, and the per-thread mode and reasoning selectors stay adjustable from
the composer.

T3 Code's `delegate_task` tool can target Muse instances, and Muse threads
receive the same `t3-code` MCP toolkit as other providers, so a Muse parent
agent can itself delegate to Codex, Claude, or another Muse instance.

## Troubleshooting

- If Muse is unavailable, confirm that the configured `muse-acp` binary runs
  on the server machine, then refresh the provider in Settings.
- If T3 Code reports that the Muse Code CLI is missing, install Muse Code and
  confirm `muse --version` works where the server runs.
- If T3 Code reports Muse is not logged in, run `muse login` in a terminal and
  approve the code in your browser, then refresh the provider. T3 Code cannot
  complete the browser login for you.
- If no models appear, open Muse directly and confirm its authentication, then
  refresh the provider.
- If discovery cannot complete, T3 Code keeps Muse available with the `Default`
  model, which defers to the session's current Muse model. Starting a thread
  boots a fresh host that usually succeeds once the first cold start is over.
- The first discovery after installing can take a while because it boots a
  disposable Muse host. Later refreshes reuse the warm path and are faster.
