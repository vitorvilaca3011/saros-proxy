/**
 * help.ts — Help text for the Saros proxy CLI.
 *
 * Extracted from index.ts so importing it does not trigger the
 * entire module graph (config loading, server setup, etc.).
 */

export function printHelp(): void {
  console.log(`Usage: saros-proxy [command] [options]

Commands:
  (no command)                                 Show overview (status, harnesses, API keys)
  serve [--port <port>] [--config <path>]      Run the proxy in the foreground
  start [--port <port>] [--config <path>]   Start the proxy daemon
  stop                                       Stop the proxy daemon
  restart [--port <port>] [--config <path>]  Restart the proxy daemon
  status                                     Check daemon status
  setup                                      Run interactive setup wizard
  sync-models                                Sync bundled models to all enabled harnesses
  sync-upstream                              Sync new models from upstream into enabled harnesses
  configharness [omp|ohmypi] [pi] [oc|opencode]  Add harnesses; --remove <h> / --clear to disable
  probe [model-id]                           Test model capabilities (liveness, reasoning, tools)
  autostart install [--method <method>]      Install autostart
  autostart uninstall [--method <method>]    Uninstall autostart
  autostart status [--method <method>]       Check autostart status
  help                                       Show this help message

Options:
  --version, -v                              Show version number`);
}
