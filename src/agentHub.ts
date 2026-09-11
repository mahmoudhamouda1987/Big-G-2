import type { AIService, BigGChatCallbacks, BigGChatMessage } from "./aiService";

export interface BigGAgentDef {
  id: string;
  name: string;
  purpose: string;
  model: string;
}

export interface BigGAgentDispatchOptions {
  web?: boolean;
  systemPrefix?: string;
}

/**
 * AgentHub — connectivity to Big G's agent network.
 *
 * Big G can delegate specialized work (chat, coding, vision, research,
 * media) to dedicated model end-points and allows the user to fully
 * customize/override every agent definition.
 */
export class AgentHub {
  private registry: Map<string, BigGAgentDef>;

  private static readonly DEFAULT_AGENTS: BigGAgentDef[] = [
    {
      id: "chat",
      name: "Big G Core",
      purpose: "General conversation, cognition, and daily assistance.",
      model: "openai/gpt-4o-mini",
    },
    {
      id: "coding",
      name: "Coder",
      purpose: "Software engineering: writing, debugging, and reviewing code.",
      model: "deepseek/deepseek-chat",
    },
    {
      id: "vision",
      name: "Vision",
      purpose: "Multi-modal understanding of camera frames and images.",
      model: "qwen/qwen2.5-vl-72b-instruct",
    },
    {
      id: "research",
      name: "Researcher",
      purpose: "Live web search, news, and real-time information retrieval.",
      model: "google/gemini-2.5-flash",
    },
    {
      id: "media",
      name: "Media",
      purpose: "Creative writing, media briefs, and content generation.",
      model: "meta-llama/llama-3.3-70b-instruct",
    },
  ];

  constructor(agents: BigGAgentDef[] = AgentHub.DEFAULT_AGENTS) {
    this.registry = new Map(agents.map((agent) => [agent.id, agent]));
  }

  listAgents(): BigGAgentDef[] {
    return [...this.registry.values()];
  }

  getAgent(id: string): BigGAgentDef | undefined {
    return this.registry.get(id);
  }

  /** Full customization & control: override or inject agent definitions. */
  defineAgent(def: BigGAgentDef): void {
    this.registry.set(def.id, def);
  }

  removeAgent(id: string): boolean {
    return this.registry.delete(id);
  }

  /** Rendering of the agent catalog for the model's system prompt. */
  buildCatalogBlock(): string {
    const lines = this.listAgents().map(
      (a) => `- [${a.id}] ${a.name} (${a.model}): ${a.purpose}`,
    );
    return lines.join("\n");
  }

  /**
   * Dispatches a turn to a named agent, returning its streamed reply.
   * When `agentId` is omitted, the caller passes its own AIService directly.
   */
  async dispatch(
    ai: AIService,
    agentId: string,
    messages: BigGChatMessage[],
    callbacks: BigGChatCallbacks = {},
    options: BigGAgentDispatchOptions = {},
  ): Promise<string> {
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(`AgentHub: unknown agent '${agentId}'`);
    }

    const previous = ai.getModel();
    ai.setModel(agent.model);
    try {
      const result = await ai.streamChat(messages, callbacks, { web: options.web });
      return result.text;
    } finally {
      ai.setModel(previous);
    }
  }
}