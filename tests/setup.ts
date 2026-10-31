import { readFileSync, existsSync } from "node:fs";
// Load .env.local for tests (OPENAI_API_KEY stays empty => AI gateway mock mode)
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
