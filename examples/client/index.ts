import {runExample} from './client.js';
import {formatExampleOutput} from './serialization.js';
/** Read stdin; never load the server .env or take credentials in arguments. */
async function input(){const chunks:Buffer[]=[];let size=0;for await(const chunk of process.stdin){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>1048576)throw new Error('EXAMPLE_INPUT_TOO_LARGE');chunks.push(bytes);}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
const args=process.argv.slice(2),legacyOrder=args[0]==='--order'&&args.length===2?args[1]:undefined;
process.exitCode=await runExample(legacyOrder?['order']:args,{INTENTPASS_URL:process.env.INTENTPASS_URL,INTENTPASS_TOKEN:process.env.INTENTPASS_TOKEN},{input:legacyOrder?async()=>({orderId:legacyOrder}):input,out:value=>process.stdout.write(formatExampleOutput(value)),error:code=>process.stderr.write(code+'\n')});
