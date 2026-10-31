// Local scheduler/worker loop: calls /api/cron/tick every 60s. Usage: npm run worker
const url = (process.env.APP_URL ?? "http://localhost:3000") + "/api/cron/tick";
async function loop() {
  try {
    const r = await fetch(url, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    console.log(new Date().toISOString(), r.status, await r.text());
  } catch (e) {
    console.error("tick failed", e);
  }
  setTimeout(loop, 60_000);
}
loop();
