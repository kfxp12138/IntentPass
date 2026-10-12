/** Wrapper exit status is insufficient: spawnSync can return status=0 alongside ETIMEDOUT. */
export function commandExit(result:{status:number|null;error?:Error}):number|null {return result.error?1:result.status;}
export function completeUnitRun(output:string,minimum:number):boolean {
  const count=output.match(/^# pass (\d+)$/m);
  return !!count&&Number(count[1])>=minimum&&/^# fail 0$/m.test(output)&&/^# cancelled 0$/m.test(output)&&/^# skipped 0$/m.test(output)&&!/^not ok /m.test(output);
}
