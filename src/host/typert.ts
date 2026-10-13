import { z } from 'zod';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types';

const PACKAGE = 'dsh-agent-control-center';
const stringCodec = { mode: 'strict' as const, typeSymbol: 'string', create: () => z.string() };

// Runtime contract mirrored by src/client/remote.ts. Keep the Host and Client
// descriptors in lockstep until the official Typert generator is available.
export const TYPERT: TypertContribution = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [{
    id: `${PACKAGE}#agentControlCenter/createPairingLink`,
    service: 'agentControlCenter',
    namespace: 'agentControlCenter',
    method: 'createPairingLink',
    invocation: { kind: 'direct' },
    parameters: [],
    result: stringCodec,
  }],
  model: {
    services: [{
      key: 'agentControlCenter',
      exportName: 'DashboardHost',
      members: [{ kind: 'method', name: 'createPairingLink', signature: 'createPairingLink(): Promise<string>' }],
      types: [],
      tags: [],
    }],
    events: [],
    objects: [],
  },
};

export default TYPERT;
