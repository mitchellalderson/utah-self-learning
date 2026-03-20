/** Acknowledge Message — typing indicator or emoji reaction on receipt. Best-effort. */

import { inngest, agentMessageReceived } from "../client.ts";
import { getChannel } from "../channels/index.ts";

export const acknowledgeMessage = inngest.createFunction(
  { id: "acknowledge-message", retries: 0, triggers: [agentMessageReceived] },
  async ({ event, step }) => {
    const { channel, destination, channelMeta } = event.data;

    if (!destination?.chatId) return;

    const handler = getChannel(channel);
    if (!handler) return;

    await step.run("acknowledge", async () => {
      await handler.acknowledge({ destination, channelMeta });
    });
  },
);
