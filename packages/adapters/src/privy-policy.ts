/** Privy canonicalizes address values to EIP-55. Compare only declared address
 * conditions case-insensitively; methods, operators, message strings, hashes,
 * schemas, ordering, extra conditions and every other value remain exact. */
export function semanticPrivyPolicyRules(rules:readonly {method:string;action:string;conditions:readonly unknown[]}[]){
  const condition=(input:unknown):unknown=>{
    if(!input||typeof input!=='object'||Array.isArray(input))return structuredClone(input);
    const c=structuredClone(input) as Record<string,unknown>;
    let address=false;
    if(c.field_source==='ethereum_transaction'&&(c.field==='to'||c.field==='from'))address=true;
    if(c.field_source==='ethereum_typed_data_domain'&&c.field==='verifyingContract')address=true;
    if(c.field_source==='ethereum_typed_data_message'&&typeof c.field==='string'){
      const t=c.typed_data as {primary_type?:unknown;types?:Record<string,{name?:unknown;type?:unknown}[]>}|undefined;
      if(typeof t?.primary_type==='string'&&Array.isArray(t.types?.[t.primary_type]))address=t.types![t.primary_type].some(f=>f.name===c.field&&f.type==='address');
    }
    if(c.field_source==='ethereum_calldata'&&typeof c.field==='string'&&Array.isArray(c.abi)){
      const [functionName,name,...extra]=c.field.split('.'),types=extra.length?[]:c.abi.flatMap((item:unknown)=>{
        const f=item as {type?:unknown;name?:unknown;inputs?:{name?:unknown;type?:unknown}[]};
        return f?.type==='function'&&f.name===functionName&&Array.isArray(f.inputs)?f.inputs.filter(input=>input.name===name).map(input=>input.type):[];
      });
      if(types.length&&types.every(type=>type==='address'))address=true;
    }
    if(address&&typeof c.value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(c.value))c.value=c.value.toLowerCase();
    return c;
  };
  return rules.map(({method,action,conditions})=>({method,action,conditions:conditions.map(condition)}));
}
