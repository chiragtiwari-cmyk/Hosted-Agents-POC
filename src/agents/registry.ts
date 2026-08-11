/**
 * The agent registry.
 *
 * This list is the ONLY place the set of specialists is declared. The supervisor
 * derives its tool definitions from here, so adding a specialist is one new file
 * plus one line below — no supervisor change.
 */
import { balanceAgent } from "./balance.js";
import { loansAgent } from "./loans.js";
import { paymentsAgent } from "./payments.js";
import { type Agent, type ToolDefinition, toToolDefinition } from "./types.js";

export const agents: Agent[] = [balanceAgent, paymentsAgent, loansAgent];

export function agentByName(name: string): Agent | undefined {
  return agents.find((agent) => agent.name === name);
}

export function toolDefinitions(list: Agent[] = agents): ToolDefinition[] {
  return list.map(toToolDefinition);
}
