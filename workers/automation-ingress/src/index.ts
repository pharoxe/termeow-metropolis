interface Env {
  AUTOMATION_EVENTS: Queue<AutomationEvent>;
  AUTOMATION_API_BASE_URL: string;
  AUTOMATION_TRIGGER_SECRET: string;
  INGRESS_SECRET: string;
}

interface AutomationEvent {
  automationId: string;
  sourceEventId: string;
  observedMarketCapUsd?: number;
  receivedAt: string;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

function eventFromRequest(request: Request, pathname: string): Promise<AutomationEvent> {
  const match = pathname.match(/^\/v1\/automations\/([0-9a-f-]{36})\/fire$/i);
  if (!match) throw new Error("route");
  return request.json<Record<string, unknown>>().then((body) => {
    const sourceEventId = typeof body.sourceEventId === "string" ? body.sourceEventId.trim() : "";
    const observedMarketCapUsd = body.observedMarketCapUsd;
    if (sourceEventId.length < 4 || sourceEventId.length > 200) throw new Error("sourceEventId");
    if (observedMarketCapUsd != null && (typeof observedMarketCapUsd !== "number" || !Number.isFinite(observedMarketCapUsd) || observedMarketCapUsd < 0)) throw new Error("observedMarketCapUsd");
    return { automationId: match[1], sourceEventId, observedMarketCapUsd: observedMarketCapUsd as number | undefined, receivedAt: new Date().toISOString() };
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", service: "termeow-automation-ingress" });
    }
    if (request.method !== "POST" || !url.pathname.startsWith("/v1/automations/")) return json({ error: "Not found" }, 404);
    if (request.headers.get("authorization") !== `Bearer ${env.INGRESS_SECRET}`) return json({ error: "Unauthorized" }, 401);
    try {
      const event = await eventFromRequest(request, url.pathname);
      await env.AUTOMATION_EVENTS.send(event, { contentType: "json" });
      return json({ accepted: true, sourceEventId: event.sourceEventId }, 202);
    } catch (error) {
      return json({ error: error instanceof Error && error.message === "route" ? "Not found" : "Invalid automation event" }, error instanceof Error && error.message === "route" ? 404 : 400);
    }
  },

  async queue(batch: MessageBatch<AutomationEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const event = message.body;
      try {
        const response = await fetch(`${env.AUTOMATION_API_BASE_URL}/api/internal/automations/${event.automationId}/fire`, {
          method: "POST",
          headers: {
            "authorization": `Bearer ${env.AUTOMATION_TRIGGER_SECRET}`,
            "content-type": "application/json",
            "user-agent": "termeow-automation-ingress/1.0"
          },
          body: JSON.stringify({ sourceEventId: event.sourceEventId, observedMarketCapUsd: event.observedMarketCapUsd })
        });
        if (!response.ok) throw new Error(`Termeow execution API returned ${response.status}`);
        message.ack();
      } catch (error) {
        console.error("Automation delivery failed", { automationId: event.automationId, sourceEventId: event.sourceEventId, error: String(error) });
        message.retry({ delaySeconds: 30 });
      }
    }
  }
} satisfies ExportedHandler<Env, AutomationEvent>;
