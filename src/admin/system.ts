// Adapted from listmonk cmd/dashboard.go (getSystemStats, readMemInfo, readLoadAvg, niceDuration)
// at 6fcd95f. Each value is one small read of a /proc file, so the page does not wait on the
// analytics reader for it; an absent file hides that row, as upstream's Has* fields do.
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

export interface SystemStats {
  uptime: string;
  cores: number;
  appMemoryMb: number;
  memory?: { usedMb: number; totalMb: number; percent: number };
  load?: { one: string; five: string; fifteen: string; percent: number };
}

const mib = 1024 * 1024;

function procFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function niceDuration(seconds: number): string {
  const total = Math.round(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor(total / 3600) % 24;
  const minutes = Math.floor(total / 60) % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}

function memory(): SystemStats["memory"] {
  const value = (name: string) => {
    const found = new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(procFile("/proc/meminfo"));
    return found ? Number(found[1]) * 1024 : undefined;
  };
  const total = value("MemTotal");
  const available = value("MemAvailable");
  if (!total || available === undefined) return undefined;
  const used = total - available;
  return {
    usedMb: Math.floor(used / mib),
    totalMb: Math.floor(total / mib),
    percent: Math.floor((used / total) * 100),
  };
}

function load(cores: number): SystemStats["load"] {
  const [one, five, fifteen] = procFile("/proc/loadavg").split(/\s+/).map(Number);
  if (one === undefined || five === undefined || fifteen === undefined) return undefined;
  if (![one, five, fifteen].every(Number.isFinite)) return undefined;
  return {
    one: one.toFixed(2),
    five: five.toFixed(2),
    fifteen: fifteen.toFixed(2),
    percent: Math.min(Math.floor((one / cores) * 100), 100),
  };
}

export function systemStats(): SystemStats {
  const cores = availableParallelism();
  const host = memory();
  const average = load(cores);
  return {
    uptime: niceDuration(process.uptime()),
    cores,
    appMemoryMb: Math.floor(process.memoryUsage().rss / mib),
    ...(host ? { memory: host } : {}),
    ...(average ? { load: average } : {}),
  };
}
