import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

type Options = {
  minOutputTokensToNotify: number;
  minSecondsToNotify: number;
  precision: number; // decimals for TPS/seconds
  showCache: boolean;
  showTotals: boolean;
};

const DEFAULTS: Options = {
  minOutputTokensToNotify: 1,
  minSecondsToNotify: 0,
  precision: 1,
  showCache: true,
  showTotals: true,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!isRecord(message)) return false;
  return message.role === "assistant";
}

function readNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function aggregateUsage(messages: unknown[]): Usage {
  const acc: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

  for (const m of messages) {
    if (!isAssistantMessage(m)) continue;

    // usage may or may not exist depending on the SDK
    const usage = (m as any).usage;
    if (!isRecord(usage)) continue;

    acc.input += readNumber(usage.input);
    acc.output += readNumber(usage.output);
    acc.cacheRead += readNumber(usage.cacheRead);
    acc.cacheWrite += readNumber(usage.cacheWrite);
    acc.totalTokens += readNumber(usage.totalTokens);
  }

  return acc;
}

function fmtInt(n: number): string {
  return Math.trunc(n).toLocaleString();
}

function formatNotification(args: {
  elapsedSeconds: number;
  usage: Usage;
  options: Options;
}): string {
  const { elapsedSeconds, usage, options } = args;
  const { precision, showCache, showTotals } = options;

  const outTps = usage.output / Math.max(elapsedSeconds, 1e-9);
  const parts: string[] = [];

  parts.push(`TPS ${outTps.toFixed(precision)} tok/s`);
  parts.push(`out ${fmtInt(usage.output)}`);
  parts.push(`in ${fmtInt(usage.input)}`);

  if (showCache) {
    parts.push(`cache r/w ${fmtInt(usage.cacheRead)}/${fmtInt(usage.cacheWrite)}`);
    const denom = usage.input + usage.cacheRead;
    if (denom > 0) {
      const hitRate = usage.cacheRead / denom;
      parts.push(`cache% ${(hitRate * 100).toFixed(0)}%`);
    }
  }

  if (showTotals) {
    parts.push(`total ${fmtInt(usage.totalTokens)}`);
    const ratio = usage.input > 0 ? usage.output / usage.input : 0;
    if (usage.input > 0) parts.push(`o/i ${ratio.toFixed(2)}`);
  }

  parts.push(`${elapsedSeconds.toFixed(precision)}s`);
  return parts.join(", ");
}

export default function tpsExtension(pi: ExtensionAPI, userOptions?: Partial<Options>) {
  const options: Options = { ...DEFAULTS, ...userOptions };

  // If agent runs can overlap, replace this with a Map keyed by run id.
  let agentStartMs: number | null = null;

  pi.on("agent_start", () => {
    agentStartMs = Date.now();
  });

  pi.on("agent_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    if (agentStartMs === null) return;

    const elapsedMs = Date.now() - agentStartMs;
    agentStartMs = null;

    if (elapsedMs <= 0) return;
    const elapsedSeconds = elapsedMs / 1000;

    const usage = aggregateUsage(event.messages);

    if (usage.output < options.minOutputTokensToNotify) return;
    if (elapsedSeconds < options.minSecondsToNotify) return;

    const msg = formatNotification({ elapsedSeconds, usage, options });
    ctx.ui.notify(msg, "info");
  });
}
