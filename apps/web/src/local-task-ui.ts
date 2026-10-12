import {serializeLocalTask,restoreLocalTask,confirmedFromMemory} from '../../../packages/capsule/src/local-task.js';

export const localTaskControls=`<h2>Keep the original task.</h2><p id="local-task-site" class="hint"></p><label><input id="local-task-copy-consent" type="checkbox">I approve exporting this unsigned task, dataset and evidence in plain text to my local device.</label><button id="download-local-task" disabled>Download task JSON</button><button id="copy-local-task" disabled>Copy task JSON</button><label>Original task file<input id="local-task-file" type="file" accept="application/json,.json"></label><label>Original task JSON<textarea id="local-task-input" rows="4" maxlength="1048576" placeholder="Paste the original unsigned task JSON or select its local file."></textarea></label><label><input id="local-task-import-consent" type="checkbox">Load this same original task into page memory, without signing or purchasing.</label><button id="import-local-task" disabled>Import original task</button><p id="local-task-feedback" role="status" aria-live="polite"></p>`;
export function attachLocalTaskControls(port:{current:()=>unknown;locked:()=>boolean;import:(task:ReturnType<typeof confirmedFromMemory>)=>void}){
  const query=<T extends HTMLElement>(id:string)=>document.querySelector<T>('#'+id)!;
  const copy=query<HTMLButtonElement>('copy-local-task'),importButton=query<HTMLButtonElement>('import-local-task'),copyConsent=query<HTMLInputElement>('local-task-copy-consent'),importConsent=query<HTMLInputElement>('local-task-import-consent'),input=query<HTMLTextAreaElement>('local-task-input'),file=query<HTMLInputElement>('local-task-file'),feedback=query<HTMLElement>('local-task-feedback'),site=query<HTMLElement>('local-task-site');
  site.textContent='Task files contain the dataset and original evidence, not wallet keys or signed permissions. They are unencrypted; keep them in a private local location. Automatic workflow backups are encrypted separately on the local server.';
  const download=document.querySelector<HTMLButtonElement>('#download-local-task');
  let busy=false;const active=()=>feedback.isConnected;
  const update=()=>{file.disabled=input.disabled=importConsent.disabled=copyConsent.disabled=busy||port.locked();copy.disabled=busy||port.locked()||!copyConsent.checked||!port.current();importButton.disabled=busy||port.locked()||!importConsent.checked||!input.value.trim();if(download)download.disabled=copy.disabled;};
  copyConsent.addEventListener('change',update);importConsent.addEventListener('change',update);input.addEventListener('input',update);update();
  file.addEventListener('change',()=>{void(async()=>{
    if(busy)return;const selected=file.files?.[0];if(!selected)return;
    busy=true;importConsent.checked=false;input.value='';update();const snapshot=port.current();
    try{
      if(selected.size>1048576)throw Error('LOCAL_TASK_FILE_TOO_LARGE');
      const text=await selected.text();
      if(!active()||selected!==file.files?.[0]||snapshot!==port.current()||port.locked())throw Error('LOCAL_TASK_CONTEXT_CHANGED');
      const restored=restoreLocalTask(text,port.current(),port.locked());
      input.value=serializeLocalTask(confirmedFromMemory(restored.memory),false);
      feedback.textContent='Original task file checked. Confirm the import to load it into page memory. Nothing was uploaded or signed.';
    }catch{if(active())feedback.textContent='The file could not be read. Check its format, size, original task and current permission state.';}
    finally{busy=false;if(active())update();}
  })();});
  copy.addEventListener('click',()=>{void(async()=>{if(busy||!copyConsent.checked)return;busy=true;update();try{const snapshot=port.current(),text=serializeLocalTask(snapshot,port.locked());await navigator.clipboard.writeText(text);if(!active()||snapshot!==port.current()||port.locked())return;feedback.textContent='Original task copied locally. Its ID, dataset and evidence are unchanged.';}catch{if(active())feedback.textContent='Copying was not confirmed. Check the original task, clipboard permission and authorization state.';}finally{busy=false;if(active())update();}})();});
  download?.addEventListener('click',()=>{if(busy||!copyConsent.checked||port.locked()||!port.current())return;try{const text=serializeLocalTask(port.current(),port.locked()),url=URL.createObjectURL(new Blob([text],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='intentpass-original-task.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);feedback.textContent='Task file download requested. It contains unencrypted task data; no permission or payment was sent.';}catch{feedback.textContent='The task could not be exported. Its existing state is unchanged.'}});
  importButton.addEventListener('click',()=>{if(busy||!importConsent.checked)return;try{const result=restoreLocalTask(input.value,port.current(),port.locked());if(!active())return;if(!result.alreadyPresent)port.import(confirmedFromMemory(result.memory));input.value='';copyConsent.checked=importConsent.checked=false;feedback.textContent=`Original task ${result.memory.policy.taskId} is verified and loaded into page memory. Its original dataset and evidence are preserved. Continue to Evidence review or Activity.`;update();}catch{feedback.textContent='Import was not completed. Use a complete unsigned original task with a matching dataset hash. A different existing task or pending permission cannot be overwritten.';}});
}
