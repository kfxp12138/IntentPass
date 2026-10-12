import {isDeepStrictEqual} from 'node:util';
import {BackgroundVault} from '../../../packages/storage/src/background-vault.js';
import {JsonValueSchema,type JsonValue} from '../../../packages/automation/src/workflow.js';
import type {WorkflowVault} from './workflow-worker.js';
/** Immutable encrypted records can be shared by any number of jobs. */
export class EncryptedWorkflowVault implements WorkflowVault {
  constructor(private vault:BackgroundVault,private namespaceHash:string){}
  async save(id:string,value:JsonValue){
    JsonValueSchema.parse(value);
    try{this.vault.save('checkpoint',id,this.namespaceHash,value);}
    catch(error){if(!(error instanceof Error)||error.message!=='BACKGROUND_ORIGINAL_BACKUP_LOCKED')throw error;if(!isDeepStrictEqual(this.vault.open('checkpoint',id,this.namespaceHash),value))throw Error('WORKFLOW_VAULT_CONFLICT');}
  }
  async open(id:string){return JsonValueSchema.parse(this.vault.open('checkpoint',id,this.namespaceHash));}
}
