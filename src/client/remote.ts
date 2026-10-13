import { z } from 'zod';
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';

const PACKAGE = 'dsh-agent-control-center';
const stringCodec = { mode: 'strict' as const, typeSymbol: 'string', create: () => z.string() };

// Runtime counterpart of src/host/typert.ts. It is mounted by the browser
// entry only while this Bundle is active.
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: PACKAGE,
  descriptors: [{
    id: `${PACKAGE}#agentControlCenter/createPairingLink`,
    service: 'agentControlCenter',
    namespace: 'agentControlCenter',
    method: 'createPairingLink',
    invocation: { kind: 'direct' },
    parameters: [],
    result: stringCodec,
  }],
};

export default TYPERT_REMOTE;
