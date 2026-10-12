import {z} from 'zod';
import {spawnSync} from 'node:child_process';
import {constants,lstatSync,realpathSync,openSync,readSync,fstatSync,closeSync,mkdirSync,readdirSync,writeFileSync,ftruncateSync} from 'node:fs';
import {resolve,relative,dirname,basename,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {auditBytes} from './public-audit.js';
import {strictJsonParse} from './strict-json.js';

const scope='INSTALLED_PACKAGE_NOTICE_TEXT_COLLECTION_NOT_LEGAL_OR_BUNDLED_RIGHTS_APPROVAL' as const;
const generator='scripts/package-notices.ts',root=realpathSync(process.cwd()),startedAt=new Date().toISOString();
const output='artifacts/acceptance/package-notices.json',sourceManifest='third-party/notice-sources/manifest.json';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const sha=z.string().regex(/^[a-f0-9]{64}$/),commit=z.string().regex(/^[a-f0-9]{40}$/);
const name=z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/),version=z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/);
const binding=z.object({path:z.string().min(1).max(4096),bytes:z.number().int().positive().max(4194304),sha256:sha}).strict();
const packageIdentity=z.object({name,version}).strict();
const issueSchema=packageIdentity.extend({code:z.string().regex(/^[A-Z_]+$/)}).strict();
const entrySchema=z.object({name,installedVersion:version,pinned:version.nullable(),direct:z.boolean(),declaredLicense:z.string().nullable(),nativeLicenseLabel:z.string(),metadataPath:z.string(),metadataSha256:sha,licenseFiles:z.array(binding)}).passthrough();
const inventorySchema=z.object({schemaVersion:z.literal(2),sourceCommit:commit.nullable(),worktreeDirty:z.boolean(),endedAt:z.iso.datetime(),inventoryComplete:z.literal(true),allPinsMatch:z.literal(true),lockSha256:sha,
  counts:z.object({workspaceProjects:z.number().int().positive(),packageNames:z.number().int().positive(),packageVersions:z.number().int().positive(),installedInstances:z.number().int().positive(),directDependencies:z.number().int().positive(),licenseFiles:z.number().int().nonnegative()}).strict(),
  installedGraphCoverage:z.object({missingFromInventory:z.array(z.string()).length(0),missingFromGraph:z.array(z.string()).length(0),allInstalledVersionsCovered:z.literal(true),notInstalled:z.array(z.string()),notInstalledInspected:z.literal(false)}).strict(),
  entries:z.array(entrySchema),issues:z.array(issueSchema),
}).passthrough();
const sourceBinding=binding.extend({url:z.string().url()}).strict();
const sourceEvidence=sourceBinding.extend({kind:z.enum(['REGISTRY_METADATA','UPSTREAM_PACKAGE_JSON','UPSTREAM_VERSION_TEXT','GIT_TAG_REFERENCE','GIT_TAG_OBJECT']),package:packageIdentity}).strict();
const referenceSchema=z.object({schemaVersion:z.literal(1),scope:z.literal('FIXED_OFFICIAL_SOURCE_REFERENCES_NOT_DISTRIBUTION_OR_LEGAL_APPROVAL'),recordedAt:z.iso.datetime(),
  sources:z.array(z.object({id:z.string().regex(/^[A-Za-z0-9._-]+$/),scope:z.literal('UPSTREAM_REFERENCE_NOT_INSTALLED_DISTRIBUTION'),commit,repository:z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),packages:z.array(packageIdentity).min(1),licenseLabel:z.string(),license:sourceBinding,versionEvidence:z.array(sourceEvidence).min(2),unresolved:z.array(z.string().regex(/^[A-Z_]+$/))}).strict()).length(5),limits:z.array(z.string()),
}).strict();
const officialLicenses:Record<string,{commit:string;bytes:number;sha256:string}>={
  'esbuild-0.25.12':{commit:'208f539945b145e7c9d6d844290f81c3fe5af320',bytes:1069,sha256:'b40ec5baec7bb34fa5b1c09521fa3cd52d5fad7adafed74932a2010d3612a681'},
  'rollup-4.63.5':{commit:'3722484c33c58b3ab0cbbfcca09b8f267d420329',bytes:35231,sha256:'fa1bd040c5bdeefe65b3821cebf474f2733ce65df13089bd151dda1778e62fe8'},
  'svix-1.99.1':{commit:'6cd12c1d6d19c6d222bab889d08315f6469702c8',bytes:1088,sha256:'5962c28427cb0c49b4782932eeeb9dfd3fcd14002755a68155bd6bb306717ced'},
  'standardwebhooks-1.0.0':{commit:'929bf0c1928b188287eaf88d0a9f0a4e87df6499',bytes:11357,sha256:'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'},
  'openzeppelin-5.4.0':{commit:'c64a1edb67b6e3f4a15cca8909c9482ad33a02b0',bytes:1090,sha256:'13cd784a6c31361f0e0c6aa3b410a1cb9a079868b7314c13e3eb8a75351746b9'},
};
type Binding=z.infer<typeof binding>;
type PackageNotice={name:string;version:string;installedInstance:string;direct:boolean;declaredLicense:string|null;nativeLicenseLabel:string;metadata:Binding;files:{sourcePath:string;copyPath:string;bytes:number;sha256:string;kind:'INVENTORIED_LICENSE_OR_NOTICE'|'CURRENT_STANDALONE_COPYRIGHT'}[]};
type Identity={ino:number;dev:number;size:number;mtimeMs:number;ctimeMs:number};
const same=(a:Identity,b:Identity)=>a.ino===b.ino&&a.dev===b.dev&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
function present(path:string){try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw Error('LOCAL_PATH_UNAVAILABLE');}}
function absolute(path:string){
  const parts=path.split('/');
  if(isAbsolute(path)||parts.some(part=>!part||part==='.'||part==='..'||/^\.env(?:\.|$)/i.test(part)||/[.]db(?:-|$)/i.test(part))||relative(root,resolve(root,path))!==path)throw Error('LOCAL_PATH_INVALID');
  let current=root;
  for(const part of parts){current=resolve(current,part);if(lstatSync(current).isSymbolicLink())throw Error('LOCAL_SYMLINK_REJECTED');}
  if(realpathSync(current)!==current)throw Error('LOCAL_PATH_CHANGED');return current;
}
function read(path:string,maximum=4194304){
  const target=absolute(path),before=lstatSync(target);
  if(!before.isFile()||before.size<=0||before.size>maximum)throw Error('LOCAL_FILE_INVALID');
  const fd=openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW),chunk=Buffer.alloc(65536),parts:Buffer[]=[];let size=0;
  try{
    if(!same(before,fstatSync(fd)))throw Error('LOCAL_FILE_CHANGED');
    for(let length;(length=readSync(fd,chunk,0,chunk.length,null))>0;){size+=length;if(size>maximum)throw Error('LOCAL_FILE_INVALID');parts.push(Buffer.from(chunk.subarray(0,length)));}
    if(size!==before.size||!same(before,fstatSync(fd))||!same(before,lstatSync(absolute(path))))throw Error('LOCAL_FILE_CHANGED');
  }finally{closeSync(fd);}
  const bytes=Buffer.concat(parts);if(auditBytes(path,bytes).length)throw Error('PUBLIC_NOTICE_BYTES_UNSAFE');return bytes;
}
const describe=(path:string,bytes:Buffer):Binding=>({path,bytes:bytes.length,sha256:hash(bytes)});
function json(bytes:Buffer):unknown{
  const value=strictJsonParse(bytes.toString('utf8'));
  if(auditBytes('package-notices',Buffer.from(JSON.stringify(value))).length)throw Error('PUBLIC_NOTICE_BYTES_UNSAFE');return value;
}
function objectJson(bytes:Buffer):Record<string,any>{const value=json(bytes);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('JSON_OBJECT_REQUIRED');return value as Record<string,any>;}
const observed=new Map<string,Binding>();
function bound(path:string,expected?:Pick<Binding,'bytes'|'sha256'>,maximum=4194304){
  const bytes=read(path,maximum),actual=describe(path,bytes);
  if(expected&&(actual.bytes!==expected.bytes||actual.sha256!==expected.sha256))throw Error('INPUT_BYTES_DRIFT');
  const previous=observed.get(path);if(previous&&(previous.bytes!==actual.bytes||previous.sha256!==actual.sha256))throw Error('INPUT_BYTES_DRIFT');observed.set(path,actual);return bytes;
}
function directories(path:string){
  let current=root;
  for(const part of path.split('/')){
    if(!part||part==='.'||part==='..')throw Error('OUTPUT_PATH_INVALID');current=resolve(current,part);
    if(present(current)){const stat=lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('OUTPUT_DIRECTORY_INVALID');}
    else mkdirSync(current);
  }
}
function saveNewOrIdentical(path:string,bytes:Buffer){
  if(!/^(?:third-party\/delivery-notices\/|artifacts\/acceptance\/package-notices)/.test(path))throw Error('OUTPUT_PATH_INVALID');
  directories(dirname(path));const target=resolve(root,path);
  if(present(target)){if(!read(path).equals(bytes))throw Error('EXISTING_OUTPUT_BYTES_DIFFER');return;}
  const fd=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644);
  try{writeFileSync(fd,bytes);}finally{closeSync(fd);}if(!read(path).equals(bytes))throw Error('OUTPUT_BYTES_DRIFT');
}
function lockIntegrities(lock:Buffer){
  const result=new Map<string,string>();let inPackages=false,key:string|null=null;
  for(const line of lock.toString('utf8').split('\n')){
    if(line==='packages:'){inPackages=true;continue;}if(line==='snapshots:')break;if(!inPackages)continue;
    if(/^  \S/.test(line))key=line.trim().replace(/:$/,'').replace(/^'(.*)'$/,'$1');
    const match=line.match(/^    resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}$/);if(match&&key)result.set(key,match[1]);
  }
  if(!result.size)throw Error('LOCK_FORMAT_INVALID');return result;
}
function sourceContext(){
  const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}),working=spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'});
  if(revision.status!==0||working.status!==0||!commit.safeParse(revision.stdout.trim()).success)throw Error('SOURCE_CONTEXT_UNAVAILABLE');
  return {sourceCommit:revision.stdout.trim(),worktreeDirty:!!working.stdout.trim()};
}
function collect(checkOnly:boolean){
  const inventoryPath='artifacts/acceptance/dependency-attribution.json',projectPath='package.json',lockPath='pnpm-lock.yaml';
  const inventory=inventorySchema.parse(json(bound(inventoryPath))),project=objectJson(bound(projectPath)) as {dependencies:Record<string,string>;devDependencies:Record<string,string>};
  const lock=bound(lockPath);if(hash(lock)!==inventory.lockSha256)throw Error('INVENTORY_LOCK_DRIFT');
  const locks=lockIntegrities(lock),pins=new Map(Object.entries({...project.dependencies,...project.devDependencies})),instances=new Set<string>(),identities=new Set<string>();
  const packages:PackageNotice[]=[];let licenseCount=0,licenseBytes=0,directCount=0,copyrightCount=0,copyrightBytes=0;
  for(const entry of inventory.entries){
    if(!entry.metadataPath.startsWith('node_modules/.pnpm/')||basename(entry.metadataPath)!=='package.json')throw Error('PACKAGE_PATH_INVALID');
    const instance=dirname(entry.metadataPath);if(instances.has(instance))throw Error('DUPLICATE_INSTALLED_INSTANCE');instances.add(instance);identities.add(entry.name+'@'+entry.installedVersion);
    const metadataBytes=bound(entry.metadataPath,{sha256:entry.metadataSha256,bytes:read(entry.metadataPath).length}),metadata=objectJson(metadataBytes);
    if(metadata.name!==entry.name||metadata.version!==entry.installedVersion||(typeof metadata.license==='string'?metadata.license:null)!==entry.declaredLicense||!locks.has(entry.name+'@'+entry.installedVersion))throw Error('PACKAGE_METADATA_DRIFT');
    if(entry.direct){
      if(pins.get(entry.name)!==entry.installedVersion||entry.pinned!==entry.installedVersion||realpathSync(resolve(root,'node_modules',entry.name))!==resolve(root,instance))throw Error('DIRECT_PIN_DRIFT');directCount++;
    }else if(entry.pinned!==null)throw Error('DIRECT_PIN_DRIFT');
    const directoryNames=readdirSync(absolute(instance));
    const topNames=directoryNames.filter(file=>/^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(file)).sort();
    const regular=topNames.filter(file=>{const stat=lstatSync(resolve(root,instance,file));if(stat.isSymbolicLink())throw Error('LICENSE_SYMLINK_REJECTED');return stat.isFile();});
    if(JSON.stringify(regular)!==JSON.stringify(entry.licenseFiles.map(file=>basename(file.path)).sort()))throw Error('INSTALLED_NOTICE_INVENTORY_DRIFT');
    const copyrights=directoryNames.filter(file=>/^copyrights?(?:$|[._-])/i.test(file)).sort().filter(file=>{const stat=lstatSync(resolve(root,instance,file));if(stat.isSymbolicLink())throw Error('COPYRIGHT_SYMLINK_REJECTED');return stat.isFile();});
    const files:PackageNotice['files']=[];
    for(const file of entry.licenseFiles){
      if(dirname(file.path)!==instance||!regular.includes(basename(file.path)))throw Error('LICENSE_PATH_INVALID');
      const bytes=bound(file.path,file),copyPath='third-party/delivery-notices/'+entry.name.replaceAll('/','__')+'@'+entry.installedVersion+'/'+basename(file.path);
      if(checkOnly)bound(copyPath,file);else{saveNewOrIdentical(copyPath,bytes);bound(copyPath,file);}
      files.push({sourcePath:file.path,copyPath,bytes:file.bytes,sha256:file.sha256,kind:'INVENTORIED_LICENSE_OR_NOTICE'});licenseCount++;licenseBytes+=bytes.length;
    }
    for(const filename of copyrights){
      const path=instance+'/'+filename,bytes=bound(path),file=describe(path,bytes),copyPath='third-party/delivery-notices/'+entry.name.replaceAll('/','__')+'@'+entry.installedVersion+'/'+filename;
      if(checkOnly)bound(copyPath,file);else{saveNewOrIdentical(copyPath,bytes);bound(copyPath,file);}
      files.push({sourcePath:path,copyPath,bytes:file.bytes,sha256:file.sha256,kind:'CURRENT_STANDALONE_COPYRIGHT'});copyrightCount++;copyrightBytes+=bytes.length;
    }
    packages.push({name:entry.name,version:entry.installedVersion,installedInstance:instance,direct:entry.direct,declaredLicense:entry.declaredLicense,nativeLicenseLabel:entry.nativeLicenseLabel,metadata:{path:entry.metadataPath,bytes:metadataBytes.length,sha256:entry.metadataSha256},files});
  }
  const expectedCounts=inventory.counts;
  if(instances.size!==expectedCounts.installedInstances||identities.size!==expectedCounts.packageVersions||new Set(packages.map(pkg=>pkg.name)).size!==expectedCounts.packageNames||licenseCount!==expectedCounts.licenseFiles||directCount!==expectedCounts.directDependencies||pins.size!==directCount||[...pins].some(([packageName,pin])=>!packages.some(pkg=>pkg.name===packageName&&pkg.direct&&pkg.version===pin)))throw Error('INVENTORY_COUNTS_DRIFT');
  const references=referenceSchema.parse(json(bound(sourceManifest,undefined,262144))),sourceIds=new Set<string>(),sourceReferences=[];
  for(const reference of references.sources){
    const official=officialLicenses[reference.id];if(!official||sourceIds.has(reference.id)||reference.commit!==official.commit||reference.license.bytes!==official.bytes||reference.license.sha256!==official.sha256)throw Error('OFFICIAL_REFERENCE_DRIFT');sourceIds.add(reference.id);
    const prefix='https://raw.githubusercontent.com/'+reference.repository.slice('https://github.com/'.length)+'/'+reference.commit+'/';
    if(!reference.license.url.startsWith(prefix))throw Error('IMMUTABLE_LICENSE_URL_REQUIRED');
    const all=[reference.license,...reference.versionEvidence];
    if(new Set(all.map(file=>file.path)).size!==all.length||all.some(file=>!file.path.startsWith('third-party/notice-sources/'+reference.id+'/')))throw Error('REFERENCE_PATH_INVALID');
    const license=bound(reference.license.path,reference.license,65536),declared=new Map<string,string|null>(),seenRegistry=new Set<string>(),versionEvidence=[];
    let refTag:any=null,tagObject:any=null;const unresolved:string[]=[];
    for(const evidence of reference.versionEvidence){
      if(!reference.packages.some(pkg=>pkg.name===evidence.package.name&&pkg.version===evidence.package.version)||!identities.has(evidence.package.name+'@'+evidence.package.version))throw Error('REFERENCE_PACKAGE_INVALID');
      const bytes=bound(evidence.path,evidence,65536),identity=evidence.package.name+'@'+evidence.package.version;
      if(evidence.kind==='REGISTRY_METADATA'){
        if(evidence.url!=='https://registry.npmjs.org/'+encodeURIComponent(evidence.package.name)+'/'+evidence.package.version)throw Error('REGISTRY_URL_INVALID');
        const data=objectJson(bytes);
        if(data.name!==evidence.package.name||data.version!==evidence.package.version||data.dist?.integrity!==locks.get(identity)||data.gitHead&&data.gitHead!==reference.commit||seenRegistry.has(identity))throw Error('REGISTRY_VERSION_OR_COMMIT_DRIFT');
        seenRegistry.add(identity);declared.set(identity,typeof data.license==='string'?data.license:null);
        versionEvidence.push({...evidence,recordedVersion:data.version,declaredLicense:typeof data.license==='string'?data.license:null,recordedGitHead:data.gitHead??null,lockIntegrity:data.dist.integrity});
      }else if(evidence.kind==='UPSTREAM_PACKAGE_JSON'){
        if(!evidence.url.startsWith(prefix))throw Error('IMMUTABLE_VERSION_URL_REQUIRED');const data=objectJson(bytes);
        if(data.version!==evidence.package.version){if(reference.id!=='standardwebhooks-1.0.0')throw Error('UPSTREAM_VERSION_DRIFT');unresolved.push('PUBLISH_COMMIT_PACKAGE_VERSION_DIFFERS');}
        versionEvidence.push({...evidence,recordedVersion:data.version,declaredLicense:data.license??null});
      }else if(evidence.kind==='UPSTREAM_VERSION_TEXT'){
        if(!evidence.url.startsWith(prefix)||bytes.toString('utf8').trim()!==evidence.package.version)throw Error('UPSTREAM_VERSION_DRIFT');versionEvidence.push({...evidence,recordedVersion:bytes.toString('utf8').trim()});
      }else{
        if(reference.id!=='openzeppelin-5.4.0'||!evidence.url.startsWith('https://api.github.com/repos/OpenZeppelin/openzeppelin-contracts/git/'))throw Error('OFFICIAL_TAG_REFERENCE_INVALID');
        const data=objectJson(bytes);if(evidence.kind==='GIT_TAG_REFERENCE')refTag=data;else tagObject=data;versionEvidence.push(evidence);
      }
    }
    if(reference.packages.some(pkg=>!seenRegistry.has(pkg.name+'@'+pkg.version)))throw Error('REGISTRY_VERSION_EVIDENCE_MISSING');
    if(reference.id==='openzeppelin-5.4.0'&&(!refTag||refTag.ref!=='refs/tags/v5.4.0'||(refTag.object?.type==='commit'?refTag.object.sha!==reference.commit:!tagObject||tagObject.sha!==refTag.object?.sha||tagObject.object?.type!=='commit'||tagObject.object.sha!==reference.commit)))throw Error('OFFICIAL_TAG_COMMIT_DRIFT');
    if(/Apache License/.test(license.toString('utf8'))&&[...declared.values()].includes('MIT'))unresolved.push('PACKAGE_DECLARATION_AND_UPSTREAM_ROOT_LICENSE_DIFFER');
    if(JSON.stringify([...unresolved].sort())!==JSON.stringify([...reference.unresolved].sort()))throw Error('REFERENCE_UNRESOLVED_DRIFT');
    sourceReferences.push({...reference,versionEvidence,status:unresolved.length?'BLOCKED':'UPSTREAM_REFERENCE_COLLECTED_NOT_DISTRIBUTION_CLEARANCE',unresolved});
  }
  const originalIssues=inventory.issues.map(item=>({...item}));
  const unresolved=[...originalIssues.map(item=>({...item,scope:'ORIGINAL_INSTALLED_DISTRIBUTION_METADATA_OR_TOP_LEVEL_TEXT_GAP'})),
    ...sourceReferences.flatMap(reference=>reference.unresolved.map(code=>({name:reference.packages[0].name,version:reference.packages[0].version,code,scope:'UPSTREAM_REFERENCE_CONFLICT'})))];
  const inputs=[inventoryPath,projectPath,lockPath,sourceManifest,generator,'scripts/strict-json.ts','scripts/public-audit.ts'].map(path=>{if(!observed.has(path))bound(path);return observed.get(path)!;});
  // Recheck every input and copy at the end, including source-file and parent identities.
  for(const file of observed.values())bound(file.path,file);
  return {packages,sourceReferences,originalIssues,unresolved,notInstalled:[...inventory.installedGraphCoverage.notInstalled],notInstalledInspected:false as const,inputs,
    counts:{workspaceProjects:expectedCounts.workspaceProjects,packageNames:expectedCounts.packageNames,packageVersions:identities.size,installedInstances:instances.size,directDependencies:directCount,installedLicenseFiles:licenseCount,installedLicenseBytes:licenseBytes,standaloneCopyrightFiles:copyrightCount,standaloneCopyrightBytes:copyrightBytes,copiedTextFiles:licenseCount+copyrightCount,upstreamLicenseReferences:sourceReferences.length,upstreamEvidenceFiles:sourceReferences.reduce((n,reference)=>n+reference.versionEvidence.length,0),originalIssues:originalIssues.length,notInstalledPlatformVersions:inventory.installedGraphCoverage.notInstalled.length},
    inventoryContext:{sourceCommit:inventory.sourceCommit,worktreeDirty:inventory.worktreeDirty,endedAt:inventory.endedAt},
    limits:['Full original bytes of enumerated current-installed top-level license/NOTICE/COPYRIGHT files only; no rewriting of copyrights or selection of a dual license. Standalone copyrights are current installed observations, separately counted from the original inventory.',
      'Original npm metadata and missing-text issues remain intact. Supplemental upstream references do not turn into installed distribution files or resolve conflicting declarations.',
      'Not-installed platform distributions are listed, not inspected. Nested/vendor code, compiled native libraries, tools and legal compatibility/permission have not been fully audited.',
      'Existing unlisted user files are not inspected, overwritten or deleted. Only manifest-enumerated copies are covered.',
      'Offline regeneration and checking perform no network/provider/wallet actions and read no .env, database or credentials.',
      'Source references bind recorded bytes and explicit published-version evidence; they are not independent provenance attestation. No D7 or release profile inherits PASS.'],
  };
}
function saveManifest(report:Record<string,unknown>){
  const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
  if(!present(resolve(root,output))){saveNewOrIdentical(output,bytes);return;}
  const old=read(output),previous=objectJson(old);
  if(previous.schemaVersion!==1||previous.scope!==scope||previous.generator!==generator)throw Error('EXISTING_MANIFEST_NOT_OWNED');
  const archive='artifacts/acceptance/package-notices-history-'+startedAt.replaceAll(':','-')+'.json';saveNewOrIdentical(archive,old);
  const target=absolute(output),before=lstatSync(target),fd=openSync(target,constants.O_RDWR|constants.O_NOFOLLOW);
  try{
    if(!same(before,fstatSync(fd))||!read(output).equals(old))throw Error('EXISTING_MANIFEST_CHANGED');
    ftruncateSync(fd,0);writeFileSync(fd,bytes);
  }finally{closeSync(fd);}
  if(!read(output).equals(bytes))throw Error('OUTPUT_BYTES_DRIFT');
}
try{
  if(process.argv.slice(2).some(arg=>arg!=='--check')||process.argv.slice(2).length>1)throw Error('ARGUMENT_INVALID');
  const checking=process.argv.includes('--check'),context=sourceContext(),data=collect(checking);
  if(checking){
    const stored=objectJson(read(output));
    if(stored.schemaVersion!==1||stored.scope!==scope||stored.generator!==generator||stored.status!=='BLOCKED'||stored.collectionStatus!=='COMPLETE')throw Error('NOTICE_MANIFEST_INVALID');
    for(const key of Object.keys(data))if(JSON.stringify(stored[key])!==JSON.stringify(data[key as keyof typeof data]))throw Error('NOTICE_MANIFEST_BINDING_DRIFT');
    console.log(JSON.stringify({schemaVersion:1,scope,status:'BLOCKED',integrityStatus:'PASS',startedAt,checkedAt:new Date().toISOString(),...context,manifestSourceCommit:stored.sourceCommit,manifestSha256:hash(read(output)),counts:data.counts,originalIssues:data.originalIssues,unresolved:data.unresolved,limits:data.limits},null,2));
  }else{
    const report={schemaVersion:1,generator,scope,status:'BLOCKED',collectionStatus:'COMPLETE',startedAt,endedAt:new Date().toISOString(),...context,...data};saveManifest(report);
    console.log(JSON.stringify({scope,status:report.status,collectionStatus:report.collectionStatus,counts:report.counts,originalIssues:report.originalIssues,unresolved:report.unresolved,manifest:output},null,2));
  }
  process.exitCode=1;
}catch(error){
  const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'NOTICE_COLLECTION_INVALID';
  console.log(JSON.stringify({schemaVersion:1,generator,scope,status:'FAIL',collectionStatus:'INCOMPLETE',startedAt,endedAt:new Date().toISOString(),code}));process.exitCode=1;
}
