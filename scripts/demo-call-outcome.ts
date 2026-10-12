import {toFunctionSelector} from 'viem';
import type {Day4SubmitCallOutcome} from '../packages/protocol/src/day4-submit-rejection-types.js';
export type ExpectedDemoCall='SUCCESS'|'InvalidSignature()'|'ContextMismatch()'|'WrongExecutor()'|'AlreadyConsumed()'|'InvalidState()'|'NoCredit()';
export function classifyDemoCall(expected:ExpectedDemoCall,outcome:Day4SubmitCallOutcome){
  if(outcome.status==='UNAVAILABLE')return 'BLOCKED' as const;
  if(expected==='SUCCESS')return outcome.status==='SUCCESS'&&outcome.returnData==='0x'?'PASS' as const:'FAIL' as const;
  return outcome.status==='REVERT'&&outcome.rpcCode===3&&outcome.revertData===toFunctionSelector(expected).toLowerCase()?'PASS' as const:'FAIL' as const;
}
