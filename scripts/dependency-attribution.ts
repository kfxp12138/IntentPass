import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,relative,resolve,sep} from 'node:path';
import {commandExit} from './verification-outcome.js';

const startedAt=new Date().toISOString(),root=process.cwd(),base='artifacts/acceptance';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
type NativePackage={name:string;versions:string[];paths:string[];license:string};
const inputs=['dependency-attribution.json','dependency-licenses-native.json','dependency-tree-native.json'];
mkdirSync(base,{recursive:true});
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),working=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
if(existsSync(`${base}/dependency-attribution.json`)){const history=`${base}/history/${startedAt.replaceAll(':','-')}-dependency-attribution`;mkdirSync(history,{recursive:true});copyFileSync(`${base}/dependency-attribution.json`,`${history}/dependency-attribution.json`);}
const runs:{command:string;exitCode:number|null;evidence:string;stderr:string}[]=[];
const manager=spawnSync('pnpm',['--version'],{encoding:'utf8',timeout:30000}),managerLog=`${base}/dependency-manager-version.log`,managerError=`${base}/dependency-manager-version-stderr.log`;
writeFileSync(managerLog,manager.stdout??'');writeFileSync(managerError,manager.stderr??'');runs.push({command:'pnpm --version',exitCode:commandExit(manager),evidence:managerLog,stderr:managerError});if(commandExit(manager)!==0)throw Error('PACKAGE_MANAGER_UNAVAILABLE');
function native(name:string,args:string[]){
  const result=spawnSync('pnpm',args,{encoding:'utf8',timeout:30000,maxBuffer:32000000}),evidence=`${base}/${name}.json`,stderr=`${base}/${name}-stderr.log`;
  writeFileSync(evidence,result.stdout??'');writeFileSync(stderr,(result.stderr??'')+(result.error?'\nLOCAL_COMMAND_ERROR':''));runs.push({command:'pnpm '+args.join(' '),exitCode:commandExit(result),evidence,stderr});
  if(commandExit(result)!==0)throw Error('DEPENDENCY_INVENTORY_COMMAND_FAILED');return JSON.parse(result.stdout) as unknown;
}
const licenses=native('dependency-licenses-native',['licenses','list','--json','--long']) as Record<string,NativePackage[]>;
const tree=native('dependency-tree-native',['list','--depth','Infinity','--json','--recursive']) as Record<string,unknown>[];
const store=realpathSync('node_modules/.pnpm'),manifestBytes=readFileSync('package.json'),manifest=JSON.parse(manifestBytes.toString('utf8')) as {dependencies:Record<string,string>;devDependencies:Record<string,string>};
const direct=new Map(Object.entries({...manifest.dependencies,...manifest.devDependencies})),directRoots=new Map([...direct.keys()].map(name=>[name,realpathSync(join('node_modules',name))])),entries:Record<string,unknown>[]=[],versions=new Set<string>(),issues:{name:string;version:string;code:string}[]=[];
for(const row of Object.values(licenses).flat())for(const path of row.paths){
  const directory=realpathSync(path);if(!directory.startsWith(store+sep))throw Error('PACKAGE_PATH_OUTSIDE_PROJECT_STORE');
  const metadataPath=join(directory,'package.json');if(lstatSync(metadataPath).isSymbolicLink())throw Error('PACKAGE_METADATA_SYMLINK');const bytes=readFileSync(metadataPath),metadata=JSON.parse(bytes.toString('utf8')) as {name:string;version:string;license?:string;repository?:unknown};
  if(metadata.name!==row.name||!row.versions.includes(metadata.version))throw Error('NATIVE_METADATA_MISMATCH');versions.add(`${metadata.name}@${metadata.version}`);
  const licenseFiles=[];
  for(const name of readdirSync(directory).filter(name=>/^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(name)).sort()){
    const file=join(directory,name),stat=lstatSync(file);if(stat.isSymbolicLink()){issues.push({name:metadata.name,version:metadata.version,code:'LICENSE_SYMLINK_NOT_READ'});continue;}if(!stat.isFile())continue;
    const text=readFileSync(file);licenseFiles.push({path:relative(root,file),bytes:text.length,sha256:hash(text)});
  }
  const declaredLicense=typeof metadata.license==='string'?metadata.license:null;
  if(!declaredLicense)issues.push({name:metadata.name,version:metadata.version,code:'NO_PACKAGE_LICENSE_DECLARATION'});
  if(!licenseFiles.length)issues.push({name:metadata.name,version:metadata.version,code:'NO_TOP_LEVEL_LICENSE_TEXT'});
  const pinned=directRoots.get(metadata.name)===directory?direct.get(metadata.name):undefined;if(pinned&&pinned!==metadata.version)throw Error('DIRECT_DEPENDENCY_PIN_MISMATCH');
  entries.push({name:metadata.name,pinned:pinned??null,installedVersion:metadata.version,direct:!!pinned,declaredLicense,nativeLicenseLabel:row.license,metadataPath:relative(root,metadataPath),metadataSha256:hash(bytes),repository:metadata.repository??null,licenseFiles,licenseTextStatus:licenseFiles.length?'DISTRIBUTION_TEXT_PRESENT_NOT_PERMISSION_OR_COMPATIBILITY_APPROVAL':'MISSING_TOP_LEVEL_TEXT_METADATA_ONLY'});
}
const graph=new Set<string>(),notInstalled=new Set<string>();
// Native JSON is a finite tree. Visit every branch: repeated paths can carry
// additional dependency details, and other-platform optional nodes may be absent.
function visit(dependencies:unknown){if(!dependencies||typeof dependencies!=='object')return;for(const [name,value] of Object.entries(dependencies)){if(!value||typeof value!=='object')throw Error('DEPENDENCY_GRAPH_INVALID');const node=value as Record<string,unknown>;if(typeof node.version!=='string'||typeof node.path!=='string')throw Error('DEPENDENCY_GRAPH_INVALID');const identity=`${name}@${node.version}`;(existsSync(join(node.path,'package.json'))?graph:notInstalled).add(identity);visit(node.dependencies);visit(node.optionalDependencies);}}
for(const project of tree){visit(project.dependencies);visit(project.devDependencies);visit(project.optionalDependencies);}
const missingFromInventory=[...graph].filter(key=>!versions.has(key)),missingFromGraph=[...versions].filter(key=>!graph.has(key));if(missingFromInventory.length||missingFromGraph.length||[...direct].some(([name,pin])=>!versions.has(`${name}@${pin}`)))throw Error('INSTALLED_GRAPH_COVERAGE_MISMATCH');
entries.sort((a,b)=>String(a.name).localeCompare(String(b.name))||String(a.installedVersion).localeCompare(String(b.installedVersion)));
const report={schemaVersion:2,startedAt,endedAt:new Date().toISOString(),sourceCommit:commandExit(revision)===0?revision.stdout.trim():null,worktreeDirty:commandExit(working)!==0||!!working.stdout.trim(),environment:{node:process.version,packageManager:'pnpm@'+manager.stdout.trim(),platform:process.platform},scope:'INSTALLED_WORKSPACE_DIRECT_AND_TRANSITIVE_METADATA_AND_TOP_LEVEL_LICENSE_TEXT_NOT_LEGAL_OR_BUNDLED_CODE_AUDIT',status:issues.length?'BLOCKED':'PASS',inventoryComplete:true,packageManifestSha256:hash(manifestBytes),lockSha256:hash(readFileSync('pnpm-lock.yaml')),runs,rawInputHashes:Object.fromEntries(inputs.slice(1).map(path=>[`${base}/${path}`,hash(readFileSync(`${base}/${path}`))])),counts:{workspaceProjects:tree.length,packageNames:new Set(entries.map(row=>row.name)).size,packageVersions:versions.size,installedInstances:entries.length,directDependencies:direct.size,licenseFiles:entries.reduce((count,row)=>count+(row.licenseFiles as unknown[]).length,0)},allPinsMatch:true,installedGraphCoverage:{missingFromInventory,missingFromGraph,allInstalledVersionsCovered:true,notInstalled:[...notInstalled].sort(),notInstalledInspected:false},entries,issues,transitiveLicensesVerified:false,limits:['Installed current-platform packages only; absent optional platform packages not covered.','Top-level license/NOTICE files only; bundled/vendor/nested source rights not inferred.','A package declaration, file presence or SPDX label is not a compatibility/permission decision.','No provider credentials or private .env/database read; no dependency modifications.']};
writeFileSync(`${base}/dependency-attribution.json`,JSON.stringify(report,null,2)+'\n');
const safe=(value:unknown)=>String(value??'未声明').replace(/[|\r\n<>]/g,' ');
writeFileSync('docs/dependency-licenses.md',`# 已安装依赖归因清单\n\n范围：${report.scope}。生成：${report.endedAt}，源码 ${report.sourceCommit} / dirty=${report.worktreeDirty}。本机安装树覆盖核对完成；需要解释或补正文的事项使状态保持 ${report.status}，不是法律或发布许可通过。${report.counts.workspaceProjects} 个 workspace、${report.counts.packageNames} 个名称、${report.counts.packageVersions} 个版本、${report.counts.directDependencies} 个直接依赖、${report.counts.licenseFiles} 个顶层许可/NOTICE 文件。缺失平台、内嵌代码和工具分发不在本表覆盖范围。\n\n| 包 | 版本 | 直接 | 安装元数据声明 | 顶层许可/NOTICE 数 |\n|---|---|---|---|---|\n${entries.map(row=>`| ${safe(row.name)} | ${safe(row.installedVersion)} | ${row.direct} | ${safe(row.declaredLicense)} | ${(row.licenseFiles as unknown[]).length} |`).join('\n')}\n\n## 待核对事项\n\n${issues.map(issue=>`- ${safe(issue.name)}@${safe(issue.version)}：${issue.code}`).join('\n')||'没有顶层元数据/正文缺项；仍不意味着完成全部许可审计。'}\n\n真实 native JSON、命令/退出码、文件/metadata SHA 与逐包路径见 artifacts/acceptance/dependency-attribution.json。pnpm licenses list 的列表基于实际安装包；这里使用 pnpm licenses list --json --long，另用 pnpm list --depth Infinity --json --recursive 交叉核对。重新安装后运行 pnpm attribution:inventory；必需正文/声明未核对时入口保持非零。\n`);
console.log(JSON.stringify({status:report.status,inventoryComplete:report.inventoryComplete,counts:report.counts,issues:report.issues,scope:report.scope}));process.exitCode=issues.length?1:0;
