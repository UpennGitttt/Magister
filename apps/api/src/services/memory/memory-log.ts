const TAG = "[memory]";

export const memoryLog = {
  info(action: string, data?: unknown): void {
    if (data === undefined) console.log(`${TAG} ${action}`);
    else console.log(`${TAG} ${action}`, data);
  },
  warn(action: string, data?: unknown): void {
    if (data === undefined) console.warn(`${TAG} ${action}`);
    else console.warn(`${TAG} ${action}`, data);
  },
  error(action: string, data?: unknown): void {
    if (data === undefined) console.error(`${TAG} ${action}`);
    else console.error(`${TAG} ${action}`, data);
  },
};
