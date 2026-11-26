import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot, type Root } from "@opentui/react";
import { App } from "./App.tsx";
import { cliAction, HELP, unknownCommandText } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { IrcManager } from "./irc/manager.ts";
import { Notifier } from "./notify.ts";
import { startUpdateCheck } from "./updateCheck.ts";
import { runUpgrade } from "./upgrade.ts";
import { versionLine } from "./version.ts";

// Answer before reading the config or taking over the terminal.
const action = cliAction(process.argv.slice(2));
switch (action.kind) {
  case "help":
    console.log(HELP);
    process.exit(0);
  case "version":
    console.log(versionLine());
    process.exit(0);
  case "upgrade":
    process.exit(await runUpgrade());
  case "unknown":
    // A typo such as "honk upgarde" would otherwise start the client.
    console.error(unknownCommandText(action.word));
    process.exit(2);
  case "run":
    break;
}

interface HotState {
  renderer: CliRenderer;
  root: Root;
  manager: IrcManager;
  version: number;
}

const g = globalThis as unknown as { __ircHot?: HotState };

if (!g.__ircHot) {
  const config = loadConfig();
  const manager = new IrcManager();

  if (process.argv.includes("--demo")) {
    manager.startDemo();
  } else if (config.servers.length === 0) {
    manager.initWelcome();
  } else {
    for (const server of config.servers) {
      manager.addServer(server);
    }
  }
  // In the background, at most once a day. See src/updateCheck.ts.
  startUpdateCheck((update, lines) => manager.showUpdate(update, lines));

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    // A left click would otherwise focus the clicked element (the chat scrollbox), and
    // the input would stop getting keys. Focus moves only through `focused` props.
    autoFocus: false,
  });
  const root = createRoot(renderer);

  // Mentions and DMs become desktop notifications, shown by the terminal. See src/notify.ts.
  if (config.notifications !== false) {
    const notifier = new Notifier((message, title) =>
      renderer.triggerNotification(message, title),
    );
    renderer.on("focus", () => notifier.setFocused(true));
    renderer.on("blur", () => notifier.setFocused(false));
    manager.onMention((event) => notifier.notify(event));
  }

  // On SIGTERM or SIGHUP (kill, a closed terminal, a dropped SSH session),
  // OpenTUI catches the signal and shuts the renderer down. Catching it stops the
  // normal exit, and the IRC sockets and timers would keep honk running unseen.
  // Quit as /quit does, once the terminal is restored.
  renderer.on("destroy", () => {
    manager.disconnectAll();
    void renderer.closed.finally(() => process.exit(0));
  });

  g.__ircHot = { renderer, root, manager, version: 0 };
}

g.__ircHot.version += 1;
g.__ircHot.root.render(
  <App key={g.__ircHot.version} manager={g.__ircHot.manager} />,
);
g.__ircHot.renderer.requestRender();
