type OrderedAgent = {
  status: string;
  runningOrder: number | null;
};

export declare function orderAgents<T extends OrderedAgent>(agents: readonly T[]): T[];
