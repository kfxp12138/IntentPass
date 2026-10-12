/** JSON.parse discards earlier duplicate members. Reject them before hashing or
 * publishing the original bytes, comparing decoded keys within each object. */
export function strictJsonParse(text:string):unknown{
  let result:unknown;
  try{result=JSON.parse(text);}catch{throw Error('JSON_INVALID');}
  let at=0;
  const whitespace=()=>{while(/[\t\n\r ]/.test(text[at]??'')&&at<text.length)at++;};
  const string=():string=>{
    const start=at++;
    while(at<text.length){if(text[at]==='\\'){at+=2;continue;}if(text[at++]==='"')return JSON.parse(text.slice(start,at)) as string;}
    throw Error('JSON_INVALID');
  };
  const value=(depth:number):void=>{
    if(depth>128)throw Error('JSON_DEPTH_EXCEEDED');
    whitespace();
    if(text[at]==='"'){string();return;}
    if(text[at]==='{'){
      at++;whitespace();const keys=new Set<string>();
      if(text[at]==='}'){at++;return;}
      for(;;){
        whitespace();if(text[at]!=='"')throw Error('JSON_INVALID');const key=string();
        if(keys.has(key))throw Error('JSON_DUPLICATE_KEY');keys.add(key);
        whitespace();if(text[at++]!==':')throw Error('JSON_INVALID');value(depth+1);whitespace();
        const delimiter=text[at++];if(delimiter==='}')return;if(delimiter!==',')throw Error('JSON_INVALID');
      }
    }
    if(text[at]==='['){
      at++;whitespace();if(text[at]===']'){at++;return;}
      for(;;){value(depth+1);whitespace();const delimiter=text[at++];if(delimiter===']')return;if(delimiter!==',')throw Error('JSON_INVALID');}
    }
    const primitive=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if(!primitive)throw Error('JSON_INVALID');at+=primitive[0].length;
  };
  value(0);whitespace();if(at!==text.length)throw Error('JSON_INVALID');return result;
}
