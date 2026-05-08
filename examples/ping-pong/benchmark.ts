import { spawn } from "node:child_process";

type Scenario = {
  name: string;
  env: Record<string, string>;
  durationMs: number;
};

const scenarios: Scenario[] = [
  { name: "lan", env: {}, durationMs: 15000 },
  {
    name: "moderate",
    env: {
      PING_PONG_INITIAL_RTT_MS: "140",
      PING_PONG_ACK_DELAY_MS: "10",
    },
    durationMs: 15000,
  },
  {
    name: "harsh",
    env: {
      PING_PONG_INITIAL_RTT_MS: "180",
      PING_PONG_ACK_DELAY_MS: "0",
      PING_PONG_MAX_RETRANSMITS: "14",
    },
    durationMs: 20000,
  },
];

function launch(cmd: string, args: string[], env: Record<string, string>) {
  return spawn(cmd, args, {
    stdio: "pipe",
    env: { ...process.env, ...env },
  });
}

async function runScenario(s: Scenario): Promise<void> {
  console.log(`\n=== scenario:${s.name} ===`);
  const env = { ...s.env, PING_PONG_NAME: `bot-${s.name}` };
  const server = launch("npx", ["tsx", "ping-pong/server.ts"], env);
  const clientA = launch(
    "npx",
    ["tsx", "ping-pong/client.ts", "127.0.0.1", "7777", `a-${s.name}`],
    env,
  );
  const clientB = launch(
    "npx",
    ["tsx", "ping-pong/client.ts", "127.0.0.1", "7777", `b-${s.name}`],
    env,
  );
  for (const p of [server, clientA, clientB]) {
    p.stdout.on("data", (buf) => process.stdout.write(buf));
    p.stderr.on("data", (buf) => process.stderr.write(buf));
  }
  await new Promise((r) => setTimeout(r, s.durationMs));
  for (const p of [clientA, clientB, server]) p.kill("SIGINT");
  await new Promise((r) => setTimeout(r, 600));
}

async function main(): Promise<void> {
  for (const scenario of scenarios) {
    // Run scenarios sequentially to avoid UDP port conflicts.
    await runScenario(scenario);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
