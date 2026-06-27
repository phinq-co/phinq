import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { buildServer, VERSION } from "./server.js";

const config = loadConfig();
const app = buildServer(config);

// Drop a pointer so the `phinq` CLI finds this instance from any directory.
const pointerDir = join(homedir(), ".phinq");
const pointerFile = join(pointerDir, "instance.json");
try {
  mkdirSync(pointerDir, { recursive: true });
  writeFileSync(
    pointerFile,
    JSON.stringify(
      {
        port: config.port,
        host: config.host,
        holdDbPath: resolve(config.holdDbPath),
        auditLogPath: config.auditLogPath ? resolve(config.auditLogPath) : "",
        pid: process.pid,
      },
      null,
      2
    )
  );
} catch {
  /* pointer is a convenience; never fatal */
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, "shutting down");
    try {
      rmSync(pointerFile, { force: true });
    } catch {
      /* ignore */
    }
    await app.close();
    process.exit(0);
  });
}

app
  .listen({ port: config.port, host: config.host })
  .then(() => {
    app.log.info(
      `phinq-proxy v${VERSION} | point your agent at http://${config.host}:${config.port}/api/v1 | upstream ${config.upstream}`
    );
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
