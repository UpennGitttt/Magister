import { createHash } from "crypto";

const WINDOW_SIZE = 20;
const REPEAT_THRESHOLD = 3;

export type DoomLoopResult = {
  isDoomLoop: boolean;
  fingerprint: string;
  count: number;
  warningMessage?: string;
};

export type DoomLoopSnapshot = { window: string[] };

export class DoomLoopDetector {
  private window: string[] = [];

  fingerprint(toolName: string, toolArgs: unknown): string {
    const hash = createHash("md5")
      .update(toolName)
      .update(JSON.stringify(toolArgs ?? {}))
      .digest("hex")
      .slice(0, 16);

    return hash;
  }

  getWarningMessage(toolName: string, count: number): string {
    return `Doom loop detected: tool "${toolName}" called ${count} times with identical arguments. Breaking loop.`;
  }

  record(toolName: string, toolArgs: unknown): DoomLoopResult {
    const fp = this.fingerprint(toolName, toolArgs);

    this.window.push(fp);
    if (this.window.length > WINDOW_SIZE) {
      this.window = this.window.slice(-WINDOW_SIZE);
    }

    const count = this.window.filter((f) => f === fp).length;
    if (count >= REPEAT_THRESHOLD) {
      return {
        isDoomLoop: true,
        fingerprint: fp,
        count,
        warningMessage: this.getWarningMessage(toolName, count),
      };
    }

    return { isDoomLoop: false, fingerprint: fp, count };
  }

  reset(): void {
    this.window = [];
  }

  snapshot(): DoomLoopSnapshot {
    return { window: [...this.window] };
  }

  restore(snap: DoomLoopSnapshot): void {
    this.window = [...(snap.window ?? [])];
  }
}
