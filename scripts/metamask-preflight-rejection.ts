import {z} from 'zod';
const codes=z.enum(['DEPLOYMENT_PREFLIGHT_EXPIRED','DEPLOYMENT_PREFLIGHT_CHANGED']);
/** Thrown only before this request can call the durable reservation store. */
export class MetaMaskPreflightRejected extends Error{
  constructor(code:z.infer<typeof codes>){super(codes.parse(code));this.name='MetaMaskPreflightRejected';}
}
/** It attests this request made no reservation; it says nothing about other requests. */
export const MetaMaskNoReservationResponseSchema=z.object({code:codes,reservationOutcome:z.literal('NOT_CREATED_BY_THIS_REQUEST'),
  signaturesRequested:z.literal(0),transactionsSent:z.literal(0)}).strict();
