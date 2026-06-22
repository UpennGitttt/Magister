import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";

import type { FastifyInstance } from "fastify";

import { getSystemStatus } from "../services/system-status-service";

export async function registerSystemRoutes(app: FastifyInstance) {
  app.get("/system/status", async () => {
    return {
      ok: true,
      data: await getSystemStatus(),
    };
  });

  // POST /system/restart. Allows the web UI (and any basic-auth-
  // authenticated client) to restart the API without SSH access.
  //
  // Mechanism:
  //   1. Validate the install dir + profile from env.
  //   2. Spawn a fully-detached subprocess: `nohup bash -c "sleep 2
  //      && exec bash scripts/restart-profile.sh <profile>"`. The
  //      sleep is to let this HTTP response flush BEFORE
  //      restart.sh starts killing our own pid. detached:true +
  //      unref() ensures the child survives our SIGTERM. nohup
  //      + log redirect detaches stdio so the child doesn't pin
  //      our pty.
  //   3. Return 202 with `{ scheduled: true }` immediately so the
  //      browser can switch to "polling /health for return" mode.
  //
  // Caveats:
  //   - Any active leader task will be killed mid-flight. Operator
  //     should expect that.
  //   - There's no supervisor. If restart.sh fails (e.g. invalid
  //     profile env), nobody brings the API back. The log file
  //     written under `.magister/restart.log` is the only forensic.
  //   - Auth is whatever the proxy / fastify already enforces. The
  //     control plane is single-operator + basic-auth at the proxy,
  //     so this matches the existing security posture.
  app.post("/system/restart", async (_request, reply) => {
    const profile = process.env.MAGISTER_RUNTIME_PROFILE?.trim() || "prod";
    const installDir = process.env.MAGISTER_INSTALL_DIR?.trim() || process.cwd();

    // Sanity check: install dir must exist + contain
    // scripts/restart-profile.sh. We deliberately don't fall back to
    // anything else; misconfigured environments should hit this 500
    // explicitly rather than silently spawning something wrong.
    const scriptPath = join(installDir, "scripts", "restart-profile.sh");
    if (!existsSync(scriptPath)) {
      reply.status(500);
      return {
        ok: false,
        error: {
          code: "restart_script_missing",
          message: `restart-profile.sh not found at ${scriptPath}; check MAGISTER_INSTALL_DIR`,
        },
      };
    }

    // Persistent restart log under the install dir so the operator
    // can `tail` it after the restart to confirm it ran.
    const logPath = join(installDir, ".magister", "restart.log");
    try {
      mkdirSync(dirname(logPath), { recursive: true });
    } catch {
      /* best-effort */
    }
    const logFd = openSync(logPath, "a");

    // Run via `nohup` + new session (detached:true) so the child
    // survives our SIGTERM. Sleep 2s before invoking restart.sh so
    // this response has time to flush back to the client.
    const child = spawn(
      "nohup",
      [
        "bash",
        "-c",
        `echo "[$(date -Iseconds)] /system/restart invoked, sleeping 2s then exec'ing restart-profile.sh ${profile}" && sleep 2 && exec bash scripts/restart-profile.sh ${profile}`,
      ],
      {
        cwd: installDir,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      },
    );
    child.unref();

    reply.status(202);
    return {
      ok: true,
      data: {
        scheduled: true,
        profile,
        installDir,
        logPath,
        // Approximate when the new API should be reachable. Caller
        // should start polling /health around this time.
        estimatedReadyInMs: 8_000,
      },
    };
  });
}
