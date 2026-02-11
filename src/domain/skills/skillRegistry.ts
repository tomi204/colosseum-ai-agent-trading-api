export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  capabilities: string[];
}

const BUILT_IN_SKILLS: Skill[] = [
  {
    id: 'trade',
    name: 'Trade Execution',
    description: 'Submit and execute trade intents on Solana DEXs via Jupiter.',
    version: '1.0.0',
    capabilities: ['submit-intent', 'paper-trade', 'live-trade'],
  },
  {
    id: 'monitor',
    name: 'Market Monitor',
    description: 'Track real-time market prices and generate signals.',
    version: '1.0.0',
    capabilities: ['price-feed', 'signal-generation', 'alert'],
  },
  {
    id: 'arbitrage',
    name: 'Arbitrage Detection',
    description: 'Detect cross-venue price discrepancies and generate arbitrage intents.',
    version: '1.0.0',
    capabilities: ['cross-venue-scan', 'arb-intent', 'slippage-check'],
  },
  {
    id: 'lending',
    name: 'Lending Monitor',
    description: 'Monitor DeFi lending positions, track health factors and auto-rebalance.',
    version: '1.0.0',
    capabilities: ['position-tracking', 'health-monitor', 'auto-rebalance', 'liquidation-alert'],
  },
];

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();
  /** agentId → set of skill ids */
  private agentSkills: Map<string, Set<string>> = new Map();

  constructor() {
    for (const skill of BUILT_IN_SKILLS) {
      this.skills.set(skill.id, skill);
    }
  }

  /* ── query ─────────────────────────────────────────────────── */

  listAll(): Skill[] {
    return [...this.skills.values()];
  }

  getById(skillId: string): Skill | undefined {
    return this.skills.get(skillId);
  }

  getAgentSkills(agentId: string): Skill[] {
    const ids = this.agentSkills.get(agentId);
    if (!ids) return [];
    return [...ids].map((id) => this.skills.get(id)).filter(Boolean) as Skill[];
  }

  /* ── mutations ─────────────────────────────────────────────── */

  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  announceAgentSkills(agentId: string, skillIds: string[]): void {
    const existing = this.agentSkills.get(agentId) ?? new Set();
    for (const id of skillIds) {
      if (this.skills.has(id)) existing.add(id);
    }
    this.agentSkills.set(agentId, existing);
  }

  /** Assign all built-in skills to a newly registered agent. */
  assignDefaults(agentId: string): void {
    this.announceAgentSkills(
      agentId,
      BUILT_IN_SKILLS.map((s) => s.id),
    );
  }
}
