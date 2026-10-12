import test from 'node:test';
import assert from 'node:assert/strict';
import {ReleaseAssetsSchema,videoMetadata,logoSize,logoFileMetadata} from '../scripts/release-assets.js';
const fixture=()=>({schemaVersion:1,sourceCommit:'1'.repeat(40),productUrl:null,repositoryUrl:null,technicalVideo:null,pitchVideo:null,cleanverseVideo:null,logoPath:null,submission:null});
test('release declarations reject nonpublic credentialed URLs relative files extra secrets and invalid commit without proving reachability',()=>{
  assert.ok(ReleaseAssetsSchema.safeParse(fixture()).success);assert.ok(ReleaseAssetsSchema.safeParse({...fixture(),technicalVideo:{localPath:'/tmp/local-demo.mp4',publicUrl:'https://video.example/demo'}}).success);
  for(const productUrl of ['http://product.example','https://localhost','https://127.0.0.1','https://[::1]','https://10.0.0.1','https://preview.local',['https://','user:secret','@product.example'].join('')])assert.equal(ReleaseAssetsSchema.safeParse({...fixture(),productUrl}).success,false);
  for(const changed of [{sourceCommit:'pending'},{logoPath:'relative.svg'},{privateKey:'forbidden'},{technicalVideo:{localPath:'/tmp/local-demo.mp4',publicUrl:'https://video.example/demo',durationSeconds:100}}])assert.equal(ReleaseAssetsSchema.safeParse({...fixture(),...changed}).success,false);
});
test('release video metadata requires a real video stream and bounded finite positive duration rather than declared duration',()=>{
  const output=(duration:string,codec='video')=>JSON.stringify({format:{duration},streams:[{codec_type:codec}]});assert.deepEqual(videoMetadata(output('180'),180),{durationSeconds:180,maximumSeconds:180});assert.ok(videoMetadata(output('119.999'),120));
  for(const value of [output('180.001'),output('0'),output('-1'),output('NaN'),output('Infinity'),output('10','audio'),'{}','not json'])assert.equal(videoMetadata(value,180),null);
  assert.equal(videoMetadata(output('121'),120),null);assert.ok(videoMetadata(output('300'),300));assert.equal(videoMetadata(output('301'),300),null);
});
test('release logo limit rejects empty oversized noninteger or unavailable sizes',()=>{
  for(const suffix of ['png','jpg','jpeg','webp','PNG','JPEG'])assert.equal(logoFileMetadata(`/tmp/logo.${suffix}`,3000000),true);
  for(const path of ['/tmp/logo.svg','/tmp/logo.gif','/tmp/logo.png.svg','/tmp/logo','/tmp/logo.webp.exe'])assert.equal(logoFileMetadata(path,1),false);
  for(const bytes of [0,3000001,NaN])assert.equal(logoFileMetadata('/tmp/logo.png',bytes),false);
  assert.equal(logoSize(3000000),true);assert.equal(logoSize(1),true);
  for(const bytes of [0,-1,3000001,1.5,NaN,Infinity])assert.equal(logoSize(bytes),false);
});
