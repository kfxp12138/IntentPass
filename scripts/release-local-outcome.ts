export function completeReleaseUnitRun(output:string){
  const keys=['tests','pass','fail','cancelled','skipped','todo'] as const;
  const counts=Object.fromEntries(keys.map(key=>{const matches=[...output.matchAll(new RegExp(`^# ${key} (\\d+)$`,'gm'))];if(matches.length!==1)throw Error('RELEASE_UNIT_SUMMARY_INVALID');return [key,Number(matches[0][1])];})) as Record<typeof keys[number],number>;
  if(Object.values(counts).some(n=>!Number.isSafeInteger(n)||n<0)||counts.tests<20||counts.pass!==counts.tests||counts.fail!==0||counts.cancelled!==0||counts.skipped!==0||counts.todo!==0||/^not ok /m.test(output))throw Error('RELEASE_UNIT_RUN_INCOMPLETE');
  return counts;
}
